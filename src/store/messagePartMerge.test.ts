import { describe, expect, it } from 'vitest'
import {
  serverIdOfSessionKey,
  rawSessionIdOfKey,
  preferCompatibleText,
  mergePartPreferLiveText,
  mergePartsPreferLiveText,
  mergeToolPart,
  messageIsIncomplete,
  shouldPreserveLiveParts,
  isServerPartId,
} from './messagePartMerge'
import type { Part } from '../types/message'

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: 's1',
  messageID: 'm1',
  type: 'text',
  text,
})

const toolPart = (id: string, tool: string, status: string, input: Record<string, unknown> = {}): Part =>
  ({
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: id,
    tool,
    state: { status, input: Object.keys(input).length ? input : undefined },
  }) as unknown as Part


describe('serverIdOfSessionKey / rawSessionIdOfKey', () => {
  it('splits a composite key', () => {
    expect(serverIdOfSessionKey('local::ses_1')).toBe('local')
    expect(rawSessionIdOfKey('local::ses_1')).toBe('ses_1')
  })

  it('treats a key without separator as a raw session id', () => {
    expect(serverIdOfSessionKey('ses_1')).toBe('')
    expect(rawSessionIdOfKey('ses_1')).toBe('ses_1')
  })

  it('handles a tunnel serverId containing a colon', () => {
    expect(serverIdOfSessionKey('aiagent:inst_x::ses_1')).toBe('aiagent:inst_x')
    expect(rawSessionIdOfKey('aiagent:inst_x::ses_1')).toBe('ses_1')
  })
})

describe('preferCompatibleText', () => {
  it('returns incoming when equal', () => {
    expect(preferCompatibleText('abc', 'abc')).toBe('abc')
  })

  it('keeps the longer local text when it is a superset (server is a prefix)', () => {
    // 服务端快照是本地 live 的前缀：本地更新，不回退
    expect(preferCompatibleText('hello world', 'hello')).toBe('hello world')
  })

  it('follows incoming when the server text is longer', () => {
    expect(preferCompatibleText('hello', 'hello world')).toBe('hello world')
  })

  it('prefers the server text on divergence', () => {
    expect(preferCompatibleText('aaa', 'bbb')).toBe('bbb')
  })
})

describe('mergePartPreferLiveText', () => {
  it('returns incoming when there is no local part', () => {
    const incoming = textPart('p1', 'x')
    expect(mergePartPreferLiveText(undefined, incoming)).toBe(incoming)
  })

  it('returns incoming when part ids differ', () => {
    const incoming = textPart('p2', 'x')
    expect(mergePartPreferLiveText(textPart('p1', 'y'), incoming)).toBe(incoming)
  })

  it('keeps the longer local live text when compatible', () => {
    const merged = mergePartPreferLiveText(textPart('p1', 'hello world'), textPart('p1', 'hello'))
    expect((merged as { text: string }).text).toBe('hello world')
  })

  it('follows the server part when it is longer', () => {
    const merged = mergePartPreferLiveText(textPart('p1', 'hello'), textPart('p1', 'hello world'))
    expect((merged as { text: string }).text).toBe('hello world')
  })

  it('returns the incoming object reference when no text change is needed', () => {
    const incoming = textPart('p1', 'hello world')
    const merged = mergePartPreferLiveText(textPart('p1', 'hello'), incoming)
    expect(merged).toBe(incoming)
  })
})

describe('mergePartsPreferLiveText', () => {
  it('returns incoming parts when local is empty', () => {
    const incoming = [textPart('p1', 'a')]
    expect(mergePartsPreferLiveText([], incoming)).toBe(incoming)
  })

  it('merges per id and keeps unmatched incoming parts', () => {
    const local = [textPart('p1', 'hello world')]
    const incoming = [textPart('p1', 'hello'), textPart('p2', 'other')]
    const merged = mergePartsPreferLiveText(local, incoming)
    expect((merged[0] as { text: string }).text).toBe('hello world')
    expect((merged[1] as { text: string }).text).toBe('other')
  })
})

describe('messageIsIncomplete / shouldPreserveLiveParts', () => {
  it('treats streaming messages as incomplete', () => {
    expect(messageIsIncomplete({ isStreaming: true, info: { time: {} } })).toBe(true)
  })

  it('treats a message with a completed time as complete', () => {
    expect(messageIsIncomplete({ info: { time: { completed: 123 } } })).toBe(false)
  })

  it('preserves live parts only while both sides are incomplete', () => {
    const incomplete = { isStreaming: true, info: { time: {} } }
    const complete = { info: { time: { completed: 1 } } }
    expect(shouldPreserveLiveParts(incomplete)).toBe(true)
    expect(shouldPreserveLiveParts(incomplete, incomplete)).toBe(true)
    // incoming 已完成：强制服务端
    expect(shouldPreserveLiveParts(incomplete, complete)).toBe(false)
    // previous 已完成：不 preserve
    expect(shouldPreserveLiveParts(complete, incomplete)).toBe(false)
  })
})

describe('isServerPartId', () => {
  it('recognizes server part ids', () => {
    expect(isServerPartId('prt_0001')).toBe(true)
    // v2 服务端 / 适配层派生的 part id（dash 分隔）也视为 canonical
    expect(isServerPartId('msg_x-text')).toBe(true)
    expect(isServerPartId('msg_x-text-0')).toBe(true)
    // 乐观本地占位 part（colon 分隔）不是
    expect(isServerPartId('msg_x:text')).toBe(false)
  })
})

describe('mergeToolPart', () => {
  it('keeps the tool name when a later event omits it', () => {
    // input.started 落下名字，tool.called 只有 input 没有 name
    const pending = toolPart('call_1', 'read', 'pending')
    const running = toolPart('call_1', '', 'running', { path: '/x' })
    const merged = mergeToolPart(pending, running) as { tool: string; state: { status: string; input: unknown } }
    expect(merged.tool).toBe('read')
    expect(merged.state.status).toBe('running')
    expect(merged.state.input).toEqual({ path: '/x' })
  })

  it('does not regress a settled tool back to running/pending', () => {
    const completed = toolPart('call_1', 'read', 'completed', { path: '/x' })
    const lateRunning = toolPart('call_1', 'read', 'running', { path: '/x' })
    const merged = mergeToolPart(completed, lateRunning) as { state: { status: string } }
    expect(merged.state.status).toBe('completed')
  })

  it('returns incoming for a different id', () => {
    const a = toolPart('call_1', 'read', 'running')
    const b = toolPart('call_2', 'write', 'completed')
    expect(mergeToolPart(a, b)).toBe(b)
  })
})
