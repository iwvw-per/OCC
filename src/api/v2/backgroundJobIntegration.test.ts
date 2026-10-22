/**
 * 端到端回归：用**真实** v2 消息形状验证后台任务识别。
 *
 * 下面这段 JSON 是从本机 opencode 实测抓下来的（一次 `background: true` 的
 * bash 调用 + 它完成后的 synthetic 通知），刻意保留真实字段名：
 *   - 工具名在 `content[].name`（不是 `tool`）
 *   - 后台 id 在 `state.metadata.shellID`
 *   - 完成通知是 `type: "synthetic"` 的独立消息
 */
import { describe, expect, it } from 'vitest'
import { adaptMessage } from './message'
import { toUIMessage } from '../../utils/messageConversion'
import { collectBackgroundJobs } from '../../features/workStatus/backgroundJobs'

const REAL_TOOL_MESSAGE = {
  id: 'msg_a1',
  sessionID: 'ses_1',
  type: 'assistant',
  time: { created: 1000, completed: 1001 },
  agent: 'build',
  model: { id: 'm', providerID: 'p' },
  finish: 'tool-calls',
  content: [
    {
      type: 'tool',
      id: 'call_1',
      name: 'bash',
      state: {
        status: 'completed',
        input: { command: 'sleep 3 && echo BACKDONE', background: true },
        metadata: { status: 'running', truncated: false, shellID: 'sh_real1' },
        content: [
          {
            type: 'text',
            text: 'Command moved to the background (shell ID: sh_real1).\nOutput is streaming to: /tmp/x.log',
          },
        ],
      },
    },
  ],
}

const REAL_SYNTHETIC_MESSAGE = {
  id: 'msg_syn',
  sessionID: 'ses_1',
  type: 'synthetic',
  time: { created: 5000 },
  description: 'sleep 3 && echo BACKDONE',
  text: '<shell id="sh_real1" state="completed" command="sleep 3 && echo BACKDONE">\nBACKDONE\n</shell>',
}

describe('后台任务：真实 v2 数据', () => {
  it('detects the job from the real tool part (metadata.shellID)', () => {
    const message = toUIMessage(adaptMessage(REAL_TOOL_MESSAGE)!)
    expect(message).not.toBeNull()
    const jobs = collectBackgroundJobs([message])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: 'sh_real1',
      kind: 'shell',
      title: 'sleep 3 && echo BACKDONE',
    })
  })

  it('reconciles status from the real synthetic notice', () => {
    const tool = toUIMessage(adaptMessage(REAL_TOOL_MESSAGE)!)
    const synthetic = toUIMessage(adaptMessage(REAL_SYNTHETIC_MESSAGE)!)
    expect(synthetic).not.toBeNull()

    const jobs = collectBackgroundJobs([tool, synthetic])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: 'sh_real1',
      status: 'completed',
      title: 'sleep 3 && echo BACKDONE',
    })
    expect(jobs[0].output).toContain('BACKDONE')
  })

  it('does not leak the synthetic XML into the conversation', () => {
    // 这条消息虽然在内存里，但 content 全是 synthetic text → 对话流不渲染
    const synthetic = toUIMessage(adaptMessage(REAL_SYNTHETIC_MESSAGE)!)
    expect(synthetic.content.every(part => part.type === 'text' && part.synthetic === true)).toBe(true)
  })
})
