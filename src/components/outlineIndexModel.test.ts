import { describe, expect, it } from 'vitest'
import { buildOutlineSourceEntries, extractTurnOutlineEntries } from './outlineIndexModel'
import type { Message, UserMessageInfo } from '../types/message'

function userMessage(id: string, text: string, created: number, summaryTitle?: string): Message {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      summary: summaryTitle ? { title: summaryTitle } : undefined,
    } as UserMessageInfo,
    content: [{ id: `part-${id}`, sessionID: 'ses-1', messageID: id, type: 'text', text }],
  }
}

describe('outlineIndexModel', () => {
  it('builds outline entries from user messages with summary title preferred', () => {
    const entries = buildOutlineSourceEntries([
      userMessage('u1', 'body text', 1, 'Summary Title'),
      userMessage('u2', 'first line\nsecond', 2),
    ])
    expect(entries).toEqual([
      { messageId: 'u1', title: 'Summary Title' },
      { messageId: 'u2', title: 'first line' },
    ])
  })

  it('extracts turn outline entries with createdAt and skips empty titles', () => {
    const entries = extractTurnOutlineEntries([
      userMessage('u1', 'hello', 10),
      { info: { id: 'a1', sessionID: 'ses-1', role: 'assistant', time: { created: 11 } } as never, content: [] },
      userMessage('u2', '   ', 20),
    ])
    expect(entries).toEqual([{ messageId: 'u1', title: 'hello', createdAt: 10 }])
  })
})
