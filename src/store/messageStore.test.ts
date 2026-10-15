import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiMessage, ApiMessageWithParts, ApiPart } from '../api/types'
import { messageStore } from './messageStore'

function createAssistantMessage(id: string, sessionID = 'session-1'): ApiMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'chat',
    agent: 'build',
    path: {
      cwd: '/workspace',
      root: '/workspace',
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: 1,
      completed: 2,
    },
  }
}

function createTextPart(
  id: string,
  messageID: string,
  text: string,
  sessionID = 'session-1',
): ApiPart & { sessionID: string; messageID: string } {
  return {
    id,
    sessionID,
    messageID,
    type: 'text',
    text,
  }
}

function createMessageWithParts(id: string, text: string, sessionID = 'session-1'): ApiMessageWithParts {
  return {
    info: createAssistantMessage(id, sessionID),
    parts: [createTextPart(`part-${id}`, id, text, sessionID)],
  }
}

function createRunningToolPart(
  id: string,
  messageID: string,
  status: 'running' | 'pending' = 'running',
  callID = `call-${id}`,
  sessionID = 'session-1',
): ApiPart & { sessionID: string; messageID: string } {
  return {
    id,
    sessionID,
    messageID,
    type: 'tool',
    callID,
    tool: 'bash',
    state: {
      status,
      input: { command: 'sleep 999' },
      time: { start: 1000 },
    },
  } as unknown as ApiPart & { sessionID: string; messageID: string }
}

describe('messageStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('applies a part update when the message already exists', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', 'hello'))

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].content).toHaveLength(1)
    expect(state?.messages[0].content[0]).toMatchObject({ id: 'part-1', type: 'text', text: 'hello' })
  })

  it('silently drops a part update when the message does not exist yet', () => {
    // Part arrives before message — should be silently dropped (no pending queue)
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', 'hello'))

    const state = messageStore.getSessionState('session-1')
    // session-1 doesn't exist because handlePartUpdated doesn't ensureSession
    expect(state).toBeUndefined()
  })

  it('replays a delta that arrives before its part is created (D5)', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    // delta 先于 part.updated 到达：暂存
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
      field: 'text',
      delta: 'hello',
    })
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
      field: 'text',
      delta: ' world',
    })

    // part.updated 到达：应回放此前暂存的 delta
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', ''))

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages[0].content[0]).toMatchObject({ id: 'part-1', text: 'hello world' })
  })

  it('replays a delta that arrives before its message is created (D5)', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createTextPart('part-1', 'message-1', 'base'))

    // 消息已存在但 part 未建立时暂存的 delta，应在 part 建立后回放
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-2',
      partID: 'part-2',
      field: 'text',
      delta: 'queued',
    })
    messageStore.handleMessageUpdated(createAssistantMessage('message-2'))
    messageStore.handlePartUpdated(createTextPart('part-2', 'message-2', ''))

    const state = messageStore.getSessionState('session-1')
    const msg2 = state?.messages.find(m => m.info.id === 'message-2')
    expect(msg2?.content[0]).toMatchObject({ id: 'part-2', text: 'queued' })
  })

  it('ignores a delta that arrives after its text part was finalized by text.ended (D-dup)', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    // text.ended 携带完整文本 + end 时间，定稿 part
    messageStore.handlePartUpdated({
      ...createTextPart('part-1', 'message-1', '完整句子'),
      time: { start: 1000, end: 2000 },
    } as unknown as ApiPart & { sessionID: string; messageID: string })
    // 乱序/重发的迟到 delta：不得拼到完整文本后面
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
      field: 'text',
      delta: '（重复尾巴）',
    })
    const state = messageStore.getSessionState('session-1')
    expect(state?.messages[0].content[0]).toMatchObject({ id: 'part-1', text: '完整句子' })
  })

  it('marks cached sessions stale after reconnect and clears the flag after a fresh load', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])

    expect(messageStore.isSessionStale('session-1')).toBe(false)

    messageStore.markAllSessionsStale()
    expect(messageStore.isSessionStale('session-1')).toBe(true)

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello again')])
    expect(messageStore.isSessionStale('session-1')).toBe(false)
  })

  it('accepts exported message envelopes that use message instead of info', () => {
    messageStore.setMessages('session-1', [
      {
        message: createAssistantMessage('message-1'),
        parts: [createTextPart('part-message-1', 'message-1', 'hello')],
      } as unknown as ApiMessageWithParts,
    ])

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.messages[0].content[0]).toMatchObject({ id: 'part-message-1', type: 'text', text: 'hello' })
  })

  it('truncates messages after revert point', () => {
    messageStore.setMessages('session-1', [
      createMessageWithParts('message-1', 'one'),
      createMessageWithParts('message-2', 'two'),
      createMessageWithParts('message-3', 'three'),
    ])
    messageStore.setRevertState('session-1', {
      messageId: 'message-2',
      history: [],
    })

    messageStore.truncateAfterRevert('session-1')

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(1)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.revertState).toBeNull()
  })

  it('removes a part from a message', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])

    messageStore.handlePartRemoved({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-message-1',
    })

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages[0].content).toHaveLength(0)
  })

  it('deduplicates messages in prependMessages', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-2', 'two')])

    messageStore.prependMessages(
      'session-1',
      [createMessageWithParts('message-1', 'one'), createMessageWithParts('message-2', 'duplicate')],
      true,
    )

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages).toHaveLength(2)
    expect(state?.messages[0].info.id).toBe('message-1')
    expect(state?.messages[1].info.id).toBe('message-2')
  })

  it('stores the history cursor alongside hasMoreHistory', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-2', 'two')], {
      hasMoreHistory: true,
      historyCursor: 'cursor-1',
    })

    expect(messageStore.getHistoryCursor('session-1')).toBe('cursor-1')

    messageStore.prependMessages('session-1', [createMessageWithParts('message-1', 'one')], false, undefined)

    expect(messageStore.getHistoryCursor('session-1')).toBeUndefined()
    expect(messageStore.getHasMoreHistory('session-1')).toBe(false)
  })

  it('creates a session when starting streaming', () => {
    messageStore.setStreaming('session-1', true)

    const state = messageStore.getSessionState('session-1')
    expect(state?.isStreaming).toBe(true)
    expect(state?.messages).toHaveLength(0)
    expect(state?.loadState).toBe('idle')
  })

  it('does not create a session when stopping streaming for a missing session', () => {
    messageStore.setStreaming('session-1', false)

    expect(messageStore.getSessionState('session-1')).toBeUndefined()
  })

  it('does not regress longer live part text when a shorter snapshot arrives while streaming', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.handlePartUpdated({
      ...createTextPart('part-message-1', 'message-1', 'hello'),
    })

    expect(messageStore.getSessionState('session-1')?.messages[0].content[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('adopts a longer server snapshot when reloading messages', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello world')])

    expect(messageStore.getSessionState('session-1')?.messages[0].content[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('keeps longer live text when setMessages receives a shorter server snapshot while streaming', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello')],
      },
    ])

    expect(messageStore.getSessionState('session-1')?.messages[0].content[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('adopts completed server text even when local live text was longer', () => {
    messageStore.setMessages('session-1', [
      {
        info: {
          ...createAssistantMessage('message-1'),
          time: { created: 1 },
        },
        parts: [createTextPart('part-message-1', 'message-1', 'hello world extra')],
      },
    ])
    messageStore.setStreaming('session-1', true)
    const live = messageStore.getSessionState('session-1')?.messages[0]
    if (live) live.isStreaming = true

    // 定稿：completed 快照强制采用服务端，不再 preserve
    const completed = createMessageWithParts('message-1', 'hello world')
    if (completed.info.role === 'assistant') {
      completed.info.time = { created: 1, completed: 99 }
    }
    messageStore.setMessages('session-1', [completed])

    expect(messageStore.getSessionState('session-1')?.messages[0].content[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('forces completed message part updates from the server', () => {
    const completed = createMessageWithParts('message-1', 'hello world extra')
    if (completed.info.role === 'assistant') {
      completed.info.time = { created: 1, completed: 10 }
    }
    messageStore.setMessages('session-1', [completed])

    messageStore.handlePartUpdated({
      ...createTextPart('part-message-1', 'message-1', 'hello world'),
    })

    expect(messageStore.getSessionState('session-1')?.messages[0].content[0]).toMatchObject({
      text: 'hello world',
    })
  })

  it('flushes mutable part deltas for multiple sessions in the same frame', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    messageStore.setMessages('session-2', [createMessageWithParts('message-2', 'world', 'session-2')])

    const beforeMessage1 = messageStore.getSessionState('session-1')?.messages[0]
    const beforeMessage2 = messageStore.getSessionState('session-2')?.messages[0]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-message-1',
      field: 'text',
      delta: '!',
    })
    messageStore.handlePartDelta({
      sessionID: 'session-2',
      messageID: 'message-2',
      partID: 'part-message-2',
      field: 'text',
      delta: '?',
    })

    const scheduledFrame = rafCallbacks[0]
    if (!scheduledFrame) {
      throw new Error('Expected requestAnimationFrame callback to be scheduled')
    }
    scheduledFrame(0)

    const afterMessage1 = messageStore.getSessionState('session-1')?.messages[0]
    const afterMessage2 = messageStore.getSessionState('session-2')?.messages[0]

    expect(afterMessage1?.content[0]).toMatchObject({ text: 'hello!' })
    expect(afterMessage2?.content[0]).toMatchObject({ text: 'world?' })
    expect(afterMessage1).not.toBe(beforeMessage1)
    expect(afterMessage2).not.toBe(beforeMessage2)
  })

  it('preserves settled part references when another part receives a delta', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })

    const message = createMessageWithParts('message-1', 'settled')
    message.parts.push(createTextPart('part-live', 'message-1', 'live'))
    messageStore.setMessages('session-1', [message])

    const beforeMessage = messageStore.getSessionState('session-1')?.messages[0]
    const beforeSettledPart = beforeMessage?.content[0]
    const beforeLivePart = beforeMessage?.content[1]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-live',
      field: 'text',
      delta: ' text',
    })
    rafCallbacks[0]?.(0)

    const afterMessage = messageStore.getSessionState('session-1')?.messages[0]
    expect(afterMessage).not.toBe(beforeMessage)
    expect(afterMessage?.content[0]).toBe(beforeSettledPart)
    expect(afterMessage?.content[1]).not.toBe(beforeLivePart)
    expect(afterMessage?.content[1]).toMatchObject({ text: 'live text' })
  })

  it('preserves references of untouched messages when flushing a delta', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })

    const first = createMessageWithParts('message-1', 'first')
    const second = createMessageWithParts('message-2', 'second')
    messageStore.setMessages('session-1', [first, second])

    const beforeMessages = messageStore.getSessionState('session-1')?.messages
    const beforeFirst = beforeMessages?.[0]
    const beforeSecond = beforeMessages?.[1]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-2',
      partID: 'part-message-2',
      field: 'text',
      delta: '!',
    })
    rafCallbacks[0]?.(0)

    const afterMessages = messageStore.getSessionState('session-1')?.messages
    expect(afterMessages).not.toBe(beforeMessages)
    // 未脏消息复用引用，只有热消息换新
    expect(afterMessages?.[0]).toBe(beforeFirst)
    expect(afterMessages?.[1]).not.toBe(beforeSecond)
    expect(afterMessages?.[1].content[0]).toMatchObject({ text: 'second!' })
  })

  it('resolves deltas by id after the message array is replaced', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })

    messageStore.setMessages('session-1', [
      createMessageWithParts('message-1', 'a'),
      createMessageWithParts('message-2', 'b'),
    ])
    // 触发一次 flush，让索引缓存绑定到旧数组
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-message-1',
      field: 'text',
      delta: '1',
    })
    rafCallbacks[0]?.(0)

    // 用新数组替换（模拟重载/追加），随后 delta 仍应命中正确消息
    messageStore.setMessages('session-1', [
      createMessageWithParts('message-1', 'a1'),
      createMessageWithParts('message-2', 'b'),
      createMessageWithParts('message-3', 'c'),
    ])

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-3',
      partID: 'part-message-3',
      field: 'text',
      delta: '!',
    })
    rafCallbacks[1]?.(0)

    const messages = messageStore.getSessionState('session-1')?.messages
    expect(messages?.[2].content[0]).toMatchObject({ text: 'c!' })
  })

  it('ignores deltas for parts that do not exist', () => {
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return 1
    })

    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    const before = messageStore.getSessionState('session-1')?.messages[0]

    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'missing-part',
      field: 'text',
      delta: 'x',
    })
    rafCallbacks[0]?.(0)

    expect(messageStore.getSessionState('session-1')?.messages[0]).toBe(before)
  })

  it('keeps a session intact when it fits the byte budget, even far beyond 500 messages', () => {
    // 投影后单条约 0.8KB：1200 条约 1MB，远低于 12MB 预算。
    // 旧实现按 500 条裁剪会丢掉最前面 700 条，导致首屏看不到最早几轮。
    const total = 1200
    const messages = Array.from({ length: total }, (_, i) => createMessageWithParts(`message-${i}`, `text-${i}`))

    messageStore.setMessages('session-1', messages)

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages.length).toBe(total)
    expect(state?.messages[0].info.id).toBe('message-0')
    expect(messageStore.getTrimmedCount('session-1')).toBe(0)
  })

  it('caps a session by byte budget, dropping the oldest and keeping the newest', () => {
    // 每条 ~2MB 文本（命中单条计费上限），10 条即 20MB，超过 12MB 预算。
    const total = 10
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const messages = Array.from({ length: total }, (_, i) => createMessageWithParts(`message-${i}`, huge))

    messageStore.setMessages('session-1', messages)

    const state = messageStore.getSessionState('session-1')
    expect(state!.messages.length).toBeLessThan(total)
    expect(state!.messages.length).toBeGreaterThan(0)
    // 保留的是最新的那一段：末条必须还在，首条必须已被裁掉
    expect(state?.messages[state.messages.length - 1].info.id).toBe(`message-${total - 1}`)
    expect(state?.messages[0].info.id).not.toBe('message-0')
  })

  it('records a trimmed gap after capping without claiming the server has more', () => {
    const total = 10
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const messages = Array.from({ length: total }, (_, i) => createMessageWithParts(`message-${i}`, huge))

    messageStore.setMessages('session-1', messages, { hasMoreHistory: false, historyCursor: undefined })

    const state = messageStore.getSessionState('session-1')
    const kept = state!.messages.length
    expect(kept).toBeLessThan(total)
    // 裁剪后旧游标必须失效（它已指向被裁窗口之后）
    expect(messageStore.getHistoryCursor('session-1')).toBeUndefined()
    // 缺口被如实记账，供 loadMoreHistory 识别并按缺口补拉
    expect(messageStore.getTrimmedCount('session-1')).toBe(total - kept)
    // 但「服务端是否还有更早」必须仍以服务端为准（此处传入了 false）。
    // 若这里强行置 true，大会话「一次拉全」后会陷入空拉循环：
    // 上滑 → 重拉最新一页（与内存重叠、无新内容）→ 仍报还有 → 再上滑。
    expect(messageStore.getHasMoreHistory('session-1')).toBe(false)
  })

  it('clears revert state when its target message is capped away', () => {
    const total = 10
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const messages = Array.from({ length: total }, (_, i) => createMessageWithParts(`message-${i}`, huge))

    messageStore.setMessages('session-1', messages, {
      revertState: { messageID: 'message-0' } as never,
    })

    const state = messageStore.getSessionState('session-1')
    expect(state!.messages.length).toBeLessThan(total)
    // revert 指向的 message-0 被裁掉后，撤销点不能悬空
    expect(state?.revertState).toBeNull()
  })

  it('does not cap or mark history when appending within the limit', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'one')], {
      hasMoreHistory: false,
    })

    expect(messageStore.getHasMoreHistory('session-1')).toBe(false)
    expect(messageStore.getHistoryCursor('session-1')).toBeUndefined()
  })

  it('reconciles in-flight tool parts to interrupted on session idle', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hi')])
    messageStore.handlePartUpdated(createRunningToolPart('tool-1', 'message-1'))

    const before = messageStore.getSessionState('session-1')
    const beforeTool = before?.messages[0].content.find(p => p.type === 'tool') as { state: { status: string } }
    expect(beforeTool.state.status).toBe('running')

    messageStore.handleSessionIdle('session-1')

    const after = messageStore.getSessionState('session-1')
    const toolPart = after?.messages[0].content.find(p => p.type === 'tool') as {
      state: { status: string; metadata?: Record<string, unknown>; time?: { end?: number } }
    }
    expect(toolPart.state.status).toBe('interrupted')
    expect(toolPart.state.metadata?.interrupted).toBe(true)
    expect(toolPart.state.time?.end).toBeTypeOf('number')
  })

  it('reconciles in-flight tool parts to interrupted on session error', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hi')])
    messageStore.handlePartUpdated(createRunningToolPart('tool-1', 'message-1', 'pending'))

    messageStore.handleSessionError('session-1')

    const state = messageStore.getSessionState('session-1')
    const toolPart = state?.messages[0].content.find(p => p.type === 'tool') as { state: { status: string } }
    expect(toolPart.state.status).toBe('interrupted')
  })

  it('does not touch already-completed tool parts on session idle', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hi')])
    messageStore.handlePartUpdated(createRunningToolPart('tool-1', 'message-1'))
    messageStore.handlePartUpdated({
      ...createRunningToolPart('tool-1', 'message-1'),
      state: { status: 'completed', input: {}, output: 'ok', title: 'bash', metadata: {}, time: { start: 1000, end: 2000 } },
    } as never)

    messageStore.handleSessionIdle('session-1')

    const state = messageStore.getSessionState('session-1')
    const toolPart = state?.messages[0].content.find(p => p.type === 'tool') as { state: { status: string } }
    expect(toolPart.state.status).toBe('completed')
  })

  it('does not reopen streaming when the session idled before send returned (D7)', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    // 发送前记录结束世代
    const idleGenerationBeforeSend = messageStore.getIdleGeneration('session-1')
    // 请求返回前，会话已 idle
    messageStore.handleSessionIdle('session-1')

    // 发送路径带旧世代置 streaming：应被守卫拒绝
    messageStore.setStreaming('session-1', true, idleGenerationBeforeSend)

    expect(messageStore.getIsStreaming('session-1')).toBe(false)
  })

  it('still opens streaming when no idle happened before send returned (D7)', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    const idleGenerationBeforeSend = messageStore.getIdleGeneration('session-1')

    messageStore.setStreaming('session-1', true, idleGenerationBeforeSend)

    expect(messageStore.getIsStreaming('session-1')).toBe(true)
  })

  it('settles a running tool by callID from next.* events', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hi')])
    messageStore.handlePartUpdated(createRunningToolPart('tool-1', 'message-1', 'running', 'call-abc'))

    messageStore.settleToolByCallID('session-1', 'call-abc', { status: 'completed', output: 'done' })

    const state = messageStore.getSessionState('session-1')
    const toolPart = state?.messages[0].content.find(p => p.type === 'tool') as { state: { status: string; output?: string } }
    expect(toolPart.state.status).toBe('completed')
    expect(toolPart.state.output).toBe('done')
  })

  it('does not overwrite an authoritative tool result when next.* arrives late', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hi')])
    messageStore.handlePartUpdated({
      ...createRunningToolPart('tool-1', 'message-1', 'running', 'call-abc'),
      state: { status: 'completed', input: {}, output: 'server-result', title: 'bash', metadata: {}, time: { start: 1, end: 2 } },
    } as never)

    messageStore.settleToolByCallID('session-1', 'call-abc', { status: 'error', error: 'stale' })

    const state = messageStore.getSessionState('session-1')
    const toolPart = state?.messages[0].content.find(p => p.type === 'tool') as { state: { status: string; output?: string } }
    expect(toolPart.state.status).toBe('completed')
    expect(toolPart.state.output).toBe('server-result')
  })

  it('notifies only subscribers for changed sessions', () => {    const session1Subscriber = vi.fn()
    const session2Subscriber = vi.fn()
    const allSubscriber = vi.fn()
    const rafCallbacks: Array<(time: number) => void> = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      rafCallbacks.push(cb as (time: number) => void)
      return rafCallbacks.length
    })

    const unsubscribeSession1 = messageStore.subscribeSession('session-1', session1Subscriber)
    const unsubscribeSession2 = messageStore.subscribeSession('session-2', session2Subscriber)
    const unsubscribeAll = messageStore.subscribe(allSubscriber)

    messageStore.setMessages('session-2', [createMessageWithParts('message-2', 'world', 'session-2')])
    rafCallbacks.shift()?.(0)

    expect(session1Subscriber).not.toHaveBeenCalled()
    expect(session2Subscriber).toHaveBeenCalledTimes(1)
    expect(allSubscriber).toHaveBeenCalledTimes(1)

    unsubscribeSession1()
    unsubscribeSession2()
    unsubscribeAll()
  })

  it('compresses only turns older than the recent window', () => {
    const userMsg = (id: string, created: number): ApiMessageWithParts => ({
      info: { id, sessionID: 'session-1', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as ApiMessage,
      parts: [],
    })
    const assistantWithReasoning = (id: string, created: number): ApiMessageWithParts => ({
      info: { ...createAssistantMessage(id), time: { created, completed: created + 1 } } as ApiMessage,
      parts: [
        { id: `reasoning-${id}`, sessionID: 'session-1', messageID: id, type: 'reasoning', text: 'thinking', time: { start: created, end: created + 1 } },
      ],
    })

    messageStore.setMessages('session-1', [
      userMsg('u1', 1),
      assistantWithReasoning('a1', 2),
      userMsg('u2', 3),
      assistantWithReasoning('a2', 4),
      userMsg('u3', 5),
      assistantWithReasoning('a3', 6),
    ])

    // 保留最近 2 轮：u1 轮被压缩，u2/u3 轮保持完整
    const changed = messageStore.compressHistoricalTurns('session-1', 2)
    expect(changed).toBe(true)

    const state = messageStore.getSessionState('session-1')!
    const byId = new Map(state.messages.map(m => [m.info.id, m]))
    expect(byId.get('a1')!.isCompressed).toBe(true)
    expect(byId.get('a1')!.content).toHaveLength(0)
    expect(byId.get('a1')!.compressedStats).toEqual({ reasoningCount: 1, stepCount: 0 })
    expect(byId.get('a2')!.isCompressed).toBeUndefined()
    expect(byId.get('a2')!.content).toHaveLength(1)
  })

  it('does not compress when within the recent window', () => {
    const userMsg: ApiMessageWithParts = {
      info: { id: 'u1', sessionID: 'session-1', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as ApiMessage,
      parts: [],
    }
    messageStore.setMessages('session-1', [userMsg, createMessageWithParts('a1', 'answer')])
    expect(messageStore.compressHistoricalTurns('session-1', 5)).toBe(false)
  })

  it('hydrates compressed messages back to full parts', () => {
    const userMsg = (id: string, created: number): ApiMessageWithParts => ({
      info: { id, sessionID: 'session-1', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as ApiMessage,
      parts: [],
    })
    const assistant = (id: string, created: number, text = ''): ApiMessageWithParts => ({
      info: { ...createAssistantMessage(id), time: { created, completed: created + 1 } } as ApiMessage,
      parts: text
        ? [{ id: `reasoning-${id}`, sessionID: 'session-1', messageID: id, type: 'reasoning', text, time: { start: created, end: created + 1 } }]
        : [],
    })

    messageStore.setMessages('session-1', [
      userMsg('u1', 1),
      assistant('a1', 2, 'old thinking'),
      userMsg('u2', 3),
      assistant('a2', 4),
    ])
    messageStore.compressHistoricalTurns('session-1', 1)
    expect(messageStore.getSessionState('session-1')!.messages[1].isCompressed).toBe(true)

    const changed = messageStore.hydrateMessages('session-1', [assistant('a1', 2, 'restored thinking')])
    expect(changed).toBe(true)

    const message = messageStore.getSessionState('session-1')!.messages[1]
    expect(message.isCompressed).toBeUndefined()
    expect(message.content).toHaveLength(1)
    expect((message.content[0] as { text: string }).text).toBe('restored thinking')
  })
})

/**
 * 同一后端被多前缀连接（本机 local 与隧道 aiagent:inst）时，同一条会话会以
 * 不同 serverId 前缀推事件。store 应把它们归并进同一个权威 bucket，
 * 否则会出现「UI 订阅的 bucket 收不到事件，事件写进了另一个 bucket」。
 */
describe('multi-prefix session coalescing', () => {
  beforeEach(() => {
    messageStore.clearAll()
  })

  const LOCAL = 'local::ses_abc'
  const TUNNEL = 'aiagent:inst_x::ses_abc'

  it('coalesces events from another serverId prefix into the subscribed bucket', () => {
    // UI 打开会话：订阅 local 前缀，成为权威 bucket
    const unsubscribe = messageStore.subscribeSession(LOCAL, () => {})
    messageStore.setMessages(LOCAL, [createMessageWithParts('m1', 'hello')])

    // 隧道前缀推来增量事件（与 useGlobalEvents 一致：sessionID 已按 serverId scope）
    messageStore.handleMessageUpdated(createAssistantMessage('m2', TUNNEL))
    messageStore.handlePartUpdated(createTextPart('part-m2', 'm2', 'from-tunnel', TUNNEL))
    messageStore.handleMessageUpdated(createAssistantMessage('m3', TUNNEL))

    // 事件必须落在 UI 订阅的 local bucket
    const state = messageStore.getSessionState(LOCAL)!
    const ids = state.messages.map(m => m.info.id)
    expect(ids).toContain('m2')
    expect(ids).toContain('m3')
    // m2 的 part 也归并进来（不是被丢到另一个 bucket）
    const m2 = state.messages.find(m => m.info.id === 'm2')!
    expect(m2.content.some(p => p.id === 'part-m2')).toBe(true)

    // 另一个前缀读取到的是同一份状态（归并）
    expect(messageStore.getSessionState(TUNNEL)!.messages).toBe(state.messages)
    unsubscribe()
  })

  it('does not create a duplicate bucket for the second prefix', () => {
    messageStore.setMessages(LOCAL, [createMessageWithParts('m1', 'hello')])
    // 隧道前缀先推 message.updated（新消息）
    messageStore.handleMessageUpdated(createAssistantMessage('m2', 'ses_abc'))

    // 无论用哪个前缀读，都是同一份、且只有两条
    expect(messageStore.getSessionState(LOCAL)!.messages).toHaveLength(2)
    expect(messageStore.getSessionState(TUNNEL)!.messages).toHaveLength(2)
  })

  it('keeps distinct sessions separate', () => {
    messageStore.setMessages('local::ses_a', [createMessageWithParts('a1', 'A')])
    messageStore.setMessages('local::ses_b', [createMessageWithParts('b1', 'B')])
    expect(messageStore.getSessionState('local::ses_a')!.messages[0].info.id).toBe('a1')
    expect(messageStore.getSessionState('local::ses_b')!.messages[0].info.id).toBe('b1')
  })
})

/**
 * 发送时用客户端生成的 msg id，服务端 prompt 复用同一 id。canonical 用户消息
 * 到达时应靠 id 精确替换乐观消息，而不是再追加一条；且服务端 part 到达时要清掉
 * 乐观的本地占位 part，避免正文重复。
 */
describe('optimistic user message reconciliation by id', () => {
  beforeEach(() => {
    messageStore.clearAll()
  })

  const KEY = 'local::ses_dup'
  const MSG_ID = 'msg_abc123'

  function optimisticUserMessage(): import('../types/message').Message {
    return {
      info: {
        id: MSG_ID,
        sessionID: 'ses_dup',
        role: 'user',
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'p', modelID: 'm' },
      },
      content: [
        {
          id: `${MSG_ID}:text`,
          sessionID: 'ses_dup',
          messageID: MSG_ID,
          type: 'text',
          text: 'hello world',
        },
      ],
      isStreaming: false,
    }
  }

  it('replaces the optimistic row instead of appending a duplicate', () => {
    messageStore.upsertLocalMessage(optimisticUserMessage())

    // 服务端 canonical user 消息（不带 parts）到达，id 与乐观消息相同
    messageStore.handleMessageUpdated({
      id: MSG_ID,
      sessionID: 'ses_dup',
      role: 'user',
      time: { created: 100 },
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
    } as ApiMessage)

    const userRows = messageStore
      .getSessionState(KEY)!
      .messages.filter(m => m.info.role === 'user')
    expect(userRows).toHaveLength(1)
    // 乐观 part 被保留（canonical 事件不带 parts）
    expect(userRows[0].content).toHaveLength(1)
  })

  it('drops the local placeholder part when the canonical part arrives', () => {
    messageStore.upsertLocalMessage(optimisticUserMessage())

    // 服务端 part 使用 prt 前缀 id
    messageStore.handlePartUpdated({
      id: 'prt_0001',
      sessionID: 'ses_dup',
      messageID: MSG_ID,
      type: 'text',
      text: 'hello world',
    } as ApiPart & { sessionID: string; messageID: string })

    const row = messageStore.getSessionState(KEY)!.messages.find(m => m.info.id === MSG_ID)!
    const textParts = row.content.filter(p => p.type === 'text')
    expect(textParts).toHaveLength(1)
    expect(textParts[0].id).toBe('prt_0001')
  })
})
