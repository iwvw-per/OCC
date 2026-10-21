import { describe, expect, it } from 'vitest'
import { formatHeavyBytes, summarizeHeavyContent } from './heavyContent'
import type { Message } from '../../types/message'

/**
 * 上下文过重预警。
 *
 * 真实故障（2026-10-21）：用户在一个会话里只发了「继续」两个字，却收到
 * `API Error (413) http: request body too large`。查证链条：
 *
 *   1. agent 用 `read` 工具读了自己截的 5 张 PNG（每张 1.8~2.5MB）；
 *   2. 这些图以 base64 内联在工具结果里（`content[].uri`），一直留在
 *      **服务端**会话上下文中，累计约 11MB base64（解码后约 8.2MB）；
 *   3. 服务端把上下文转发给模型时，请求体超过上游网关上限
 *      （API-Monitor `GeneralMaxSize = 16 << 20`）→ 413。
 *
 * 前端并不持有这些字节（适配层只拼文本 output、把图片丢掉），所以无法
 * 减小请求体；能做的是**提前告诉用户**，避免这个错误完全不可理解。
 *
 * 这里验证的是「检测信号」本身：适配层丢弃图片时记下体积，
 * 汇总后达到阈值就预警。
 */

function toolMessage(omittedFileBytes?: number): Message {
  return {
    info: { id: 'm', sessionID: 's', role: 'assistant', time: { created: 0 } } as never,
    content: [
      {
        id: 'p',
        sessionID: 's',
        messageID: 'm',
        type: 'tool',
        callID: 'c',
        tool: 'read',
        state:
          omittedFileBytes === undefined
            ? ({ status: 'completed', output: 'Image read successfully' } as never)
            : ({ status: 'completed', output: 'Image read successfully', omittedFileBytes } as never),
      },
    ],
  }
}

describe('summarizeHeavyContent', () => {
  it('warns once accumulated inline bytes reach the threshold', () => {
    // 真实案例：5 张截图，合计约 8.2MB（解码后）
    const per = 1_700_000
    const messages = Array.from({ length: 5 }, () => toolMessage(per))
    const summary = summarizeHeavyContent(messages)
    expect(summary.toolCount).toBe(5)
    expect(summary.totalBytes).toBe(per * 5)
    expect(summary.shouldWarn).toBe(true)
  })

  it('does not warn when the accumulated volume is still small', () => {
    const summary = summarizeHeavyContent([toolMessage(400_000), toolMessage(400_000)])
    expect(summary.toolCount).toBe(2)
    expect(summary.shouldWarn).toBe(false)
  })

  it('ignores tiny inline payloads to avoid noise from ordinary files', () => {
    // 256KB 以下不算「重型」：普通文本附件、小图标都会落在这个区间
    const summary = summarizeHeavyContent([toolMessage(1024), toolMessage(200_000)])
    expect(summary).toEqual({ toolCount: 0, totalBytes: 0, shouldWarn: false })
  })

  it('ignores tool parts without the marker (e.g. text-only tools)', () => {
    const summary = summarizeHeavyContent([toolMessage(undefined), toolMessage(undefined)])
    expect(summary.shouldWarn).toBe(false)
    expect(summary.toolCount).toBe(0)
  })

  it('returns an empty summary for sessions without tool results', () => {
    const plain: Message = {
      info: { id: 'm', sessionID: 's', role: 'user', time: { created: 0 } } as never,
      content: [{ id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: '继续' }],
    }
    expect(summarizeHeavyContent([plain])).toEqual({ toolCount: 0, totalBytes: 0, shouldWarn: false })
  })
})

describe('formatHeavyBytes', () => {
  it('renders megabytes for large volumes', () => {
    expect(formatHeavyBytes(8_230_000)).toBe('7.8 MB')
  })

  it('renders kilobytes below one megabyte', () => {
    expect(formatHeavyBytes(512 * 1024)).toBe('512 KB')
  })
})
