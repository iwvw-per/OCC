import { describe, expect, it } from 'vitest'
import { adaptMessagePage, collectSessionMarkers, findCompactionMarker } from './message'

/**
 * v2 的消息模型有 11 种类型（packages/schema/src/session-message.ts）：
 *
 *   user  assistant  idle  compaction  system  synthetic  skill  shell
 *   agent-switched  model-switched  location-switched
 *
 * 对话渲染只处理 user/assistant（其余塞进消息流会让位置错乱），但其中两类是
 * **权威状态**，丢掉会直接导致界面错误：
 *
 *   - `idle`：带 outcome（succeeded/failed/interrupted）与 error。这是「这一轮
 *     结束了吗、成功还是失败」的权威来源。事件流的 execution.succeeded 一旦
 *     丢失（断线重连、隧道抖动、进程重启），界面就永远转圈。
 *     → 实测真实会话 800 条消息里有 8 条 idle、9 条 agent-switched、2 条
 *       model-switched、2 条 system。
 *
 *   - `model-switched` / `agent-switched`：带 model / agent。这是「会话绑定
 *     什么模型」的权威历史。v2 的 user 消息**没有** model 字段（实测只有
 *     time/text/files），所以「无痕窗口打开会话显示成默认模型」这类问题只能
 *     靠这里（或 session 元数据）还原。
 */

describe('collectSessionMarkers', () => {
  it('extracts the latest idle outcome with its error', () => {
    const data = [
      { id: 'm1', type: 'idle', outcome: 'interrupted', time: { created: 100 } },
      {
        id: 'm2',
        type: 'idle',
        outcome: 'failed',
        time: { created: 200 },
        error: { name: 'APIError', data: { message: 'provider exploded' } },
      },
      { id: 'm3', type: 'idle', outcome: 'succeeded', time: { created: 300 } },
    ]
    const { idle } = collectSessionMarkers(data)
    expect(idle).toEqual({ at: 300, outcome: 'succeeded' })
  })

  it('keeps the error message when the turn failed', () => {
    const data = [
      {
        id: 'm1',
        type: 'idle',
        outcome: 'failed',
        time: { created: 500 },
        error: { name: 'APIError', data: { message: 'rate limited' } },
      },
    ]
    expect(collectSessionMarkers(data).idle).toEqual({
      at: 500,
      outcome: 'failed',
      error: 'rate limited',
    })
  })

  it('normalises unknown outcomes to succeeded instead of crashing', () => {
    expect(
      collectSessionMarkers([{ id: 'm1', type: 'idle', outcome: 'weird', time: { created: 1 } }]).idle,
    ).toEqual({ at: 1, outcome: 'succeeded' })
  })

  it('reads the newest model-switched record (this is how a session remembers its model)', () => {
    // 真实形状：{ type: "model-switched", model: { id, providerID } }
    const data = [
      { id: 'm1', type: 'model-switched', model: { id: 'old-model', providerID: 'p1' }, time: { created: 100 } },
      { id: 'm2', type: 'model-switched', model: { id: 'new-model', providerID: 'p2' }, time: { created: 200 } },
    ]
    expect(collectSessionMarkers(data).config.model).toEqual({
      providerID: 'p2',
      modelID: 'new-model',
      at: 200,
    })
  })

  it('ignores model-switched records without a usable model', () => {
    const data = [{ id: 'm1', type: 'model-switched', model: { id: 'x' }, time: { created: 1 } }]
    expect(collectSessionMarkers(data).config.model).toBeUndefined()
  })

  it('reads the newest agent-switched record', () => {
    const data = [
      { id: 'm1', type: 'agent-switched', agent: 'build', time: { created: 100 } },
      { id: 'm2', type: 'agent-switched', agent: 'plan', time: { created: 200 } },
    ]
    expect(collectSessionMarkers(data).config.agent).toEqual({ agent: 'plan', at: 200 })
  })

  it('is order-independent: picks by timestamp, not by position', () => {
    // message.list 是 desc（最新在前），而 getSessionTurnPage 内部会反转。
    // 两种顺序都必须得到同一个结论。
    const asc = [
      { id: 'm1', type: 'idle', outcome: 'failed', time: { created: 100 } },
      { id: 'm2', type: 'idle', outcome: 'succeeded', time: { created: 200 } },
    ]
    expect(collectSessionMarkers(asc).idle).toEqual({ at: 200, outcome: 'succeeded' })
    expect(collectSessionMarkers([...asc].reverse()).idle).toEqual({ at: 200, outcome: 'succeeded' })
  })

  it('returns an empty config when the page has no markers', () => {
    const data = [
      { id: 'm1', type: 'user', text: 'hi', time: { created: 1 } },
      { id: 'm2', type: 'assistant', content: [], time: { created: 2 } },
    ]
    const result = collectSessionMarkers(data)
    expect(result.idle).toBeUndefined()
    expect(result.config).toEqual({})
  })

  it('does not confuse compaction records with idle markers', () => {
    const data = [
      {
        id: 'm1',
        type: 'compaction',
        status: 'completed',
        summary: 's',
        recent: 'r',
        time: { created: 100 },
      },
    ]
    expect(collectSessionMarkers(data).idle).toBeUndefined()
    expect(findCompactionMarker(data)).toBeDefined()
  })
})

/**
 * 工具结果里被丢弃的内联文件体积。
 *
 * v2 的 tool content[] 可以带 `type: "file"` 块，`uri` 是完整的
 * `data:image/png;base64,...`（实测一张截图 2.3MB 字符）。
 *
 * 这些字节**不能留在前端内存**（一页几十条消息会吃掉几十 MB 堆），所以
 * adaptToolState 只把文本拼成 output、图片块丢弃。但它们**仍然留在服务端
 * 上下文**里，会让「上下文转发给模型」的请求体膨胀 —— 真实故障就是 5 张
 * 截图累计触发上游 16MB 上限，返回 413。
 *
 * 因此丢弃时记一个数字（`state.omittedFileBytes`）供发送前预警使用。
 */
describe('tool result inline file accounting', () => {
  /** base64 的 4 字符表示 3 字节，所以字符数 × 3/4 */
  const base64Bytes = (chars: number) => Math.floor((chars * 3) / 4)

  it('records the decoded size of an inline base64 file', () => {
    const payload = 'A'.repeat(4000) // 4000 字符 → 3000 字节
    const page = adaptMessagePage({
      data: [
        {
          id: 'msg_1',
          sessionID: 'ses_1',
          type: 'assistant',
          time: { created: 1, completed: 2 },
          content: [
            {
              type: 'tool',
              id: 'call_1',
              name: 'read',
              state: {
                status: 'completed',
                input: { path: 'a.png' },
                content: [
                  { type: 'text', text: 'Image read successfully' },
                  { type: 'file', uri: `data:image/png;base64,${payload}`, mime: 'image/png', name: 'a.png' },
                ],
              },
            },
          ],
        },
      ],
    })
    const part = page.messages[0].parts[0] as { state: { omittedFileBytes?: number; output?: string } }
    expect(part.state.omittedFileBytes).toBe(base64Bytes(payload.length))
    // 图片字节不进 output，内存里只有那句文本
    expect(part.state.output).toBe('Image read successfully')
  })

  it('does not set the field for text-only tool results', () => {
    const page = adaptMessagePage({
      data: [
        {
          id: 'msg_1',
          sessionID: 'ses_1',
          type: 'assistant',
          time: { created: 1, completed: 2 },
          content: [
            {
              type: 'tool',
              id: 'call_1',
              name: 'bash',
              state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] },
            },
          ],
        },
      ],
    })
    const part = page.messages[0].parts[0] as { state: { omittedFileBytes?: number } }
    expect(part.state.omittedFileBytes).toBeUndefined()
  })
})
