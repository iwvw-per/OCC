import { describe, expect, it } from 'vitest'
import { adaptMessage } from '../api/v2/message'
import { toUIMessage } from '../utils/messageConversion'
import { hasRenderableContent, isVisibleTextContent } from './message'
import type { Message } from './message'

/**
 * 纯图片消息（正文为空）必须保留。
 *
 * 真实故障（2026-10-21）：用户发了一张截图，界面上**看不到这条消息**。
 *
 * 数据形状（从 opencode.db 读出）：
 *   { type: "user", text: "", files: [{ mime: "image/png", source: {type:"inline"}, data: "...base64..." }] }
 *
 * 适配层本身没问题（会生成 text + file 两个 part，file 折成 attachment）。
 * 问题在可见性判定：`hasRenderableContent` 只看 content[]，而纯图片消息的
 * content 里只有一个**空 text**，`isVisibleTextContent` 返回 false ——
 * 于是整条消息被当成「无内容」过滤掉，用户看到的就是「我发了图片但没显示」。
 */

function pureImageUserMessage(): Message {
  // 与真实数据同形：text 为空，附件在 info.attachments
  return {
    info: {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'user',
      time: { created: 1 },
      attachments: [
        {
          id: 'att_1',
          type: 'file',
          displayName: '1792563987354_d.png',
          url: 'data:image/png;base64,AAAA',
          mime: 'image/png',
        },
      ],
    } as never,
    content: [{ id: 'msg_1-text', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: '' }],
  }
}

describe('hasRenderableContent', () => {
  it('keeps a user message that carries only an image attachment', () => {
    // 回归：此前这里返回 false，整条消息被过滤 → 用户看不到自己发的图
    expect(hasRenderableContent(pureImageUserMessage())).toBe(true)
  })

  it('still hides an empty user message with no attachments', () => {
    const empty: Message = {
      info: { id: 'msg_2', sessionID: 'ses_1', role: 'user', time: { created: 1 } } as never,
      content: [{ id: 'p', sessionID: 'ses_1', messageID: 'msg_2', type: 'text', text: '   ' }],
    }
    expect(hasRenderableContent(empty)).toBe(false)
  })

  it('keeps a normal text message', () => {
    const textMessage: Message = {
      info: { id: 'msg_3', sessionID: 'ses_1', role: 'user', time: { created: 1 } } as never,
      content: [{ id: 'p', sessionID: 'ses_1', messageID: 'msg_3', type: 'text', text: '你好' }],
    }
    expect(hasRenderableContent(textMessage)).toBe(true)
  })

  it('does not treat blank text as visible (avoids empty bubbles)', () => {
    expect(
      isVisibleTextContent({ id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: '  \n ' }),
    ).toBe(false)
  })
})

describe('pure-image message end to end', () => {
  it('produces an attachment from the real v2 shape', () => {
    // 真实载荷：text 为空 + inline base64 文件
    const raw = {
      id: 'msg_ea99a2e111e84d54b46650a7ce2bedc6',
      sessionID: 'ses_1',
      type: 'user',
      time: { created: 1792563987354 },
      text: '',
      files: [
        { name: '1792563987354_d.png', mime: 'image/png', source: { type: 'inline' }, data: 'A'.repeat(4096) },
      ],
    }
    const withParts = adaptMessage(raw)!
    expect(withParts.parts.map(p => p.type)).toEqual(['text', 'file'])

    const ui = toUIMessage(withParts as never)
    const attachments = (ui.info as { attachments?: Array<{ url?: string; mime?: string }> }).attachments ?? []
    expect(attachments).toHaveLength(1)
    // inline base64 必须转成 data: URL，否则图片显示不出来（曾是另一个 bug）
    expect(attachments[0].url?.startsWith('data:image/png;base64,')).toBe(true)

    // 并且这条消息要被认为「有内容」
    expect(hasRenderableContent(ui)).toBe(true)
  })
})
