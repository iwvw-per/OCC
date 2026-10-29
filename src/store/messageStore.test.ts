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

  it('deep-merges info.time so streamed does not wipe created', () => {
    /**
     * 回归：v2 把一条 assistant 消息的时间拆成多个事件发
     * （step.started→created、step.streamed→streamed、step.ended→completed）。
     * 早先 info 是浅合并，后来的 `time:{streamed}` 会把 created 整个顶掉，
     * 速度统计的分母随之失效（created 缺失 → 窗口算不出来）。
     */
    messageStore.handleMessageUpdated({
      ...createAssistantMessage('message-1'),
      time: { created: 1000 },
    })
    messageStore.handleMessageUpdated({
      ...createAssistantMessage('message-1'),
      time: { streamed: 3000 },
    } as never)

    const time = messageStore.getSessionState('session-1')?.messages[0].info.time
    expect(time).toMatchObject({ created: 1000, streamed: 3000 })
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

  /**
   * 停止后不应继续追加迟到增量。
   *
   * handlePartDelta 已经靠 part.time.end 丢弃已定稿 part 的 delta，但**回放路径**
   * （part 先于 delta 不存在时暂存、part 建立后回放）原先没有这条检查，于是
   * 「text.ended 已定稿 → 仍有在途 delta 进缓冲 → 回放时补到完整文本后面」，
   * 表现为用户按下停止后内容还在往里流。
   */
  it('does not replay buffered deltas into an already finalized part', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    // delta 先到，此时 part 还不存在 → 进缓冲
    messageStore.handlePartDelta({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
      field: 'text',
      delta: 'late',
    })
    // 服务端随后发来已定稿的完整文本（带 time.end）
    messageStore.handlePartUpdated({
      ...createTextPart('part-1', 'message-1', 'final'),
      time: { start: 1, end: 2 },
    } as ApiPart & { sessionID: string; messageID: string })

    const state = messageStore.getSessionState('session-1')
    expect(state?.messages[0].content[0]).toMatchObject({ id: 'part-1', text: 'final' })
  })

  it('replays a delta that arrives before its message is created (D5)', () => {    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
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

  it('records the post-compaction context usage and moves compactedAt forward', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    const tokens = { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }

    messageStore.recordCompactionResult('session-1', { tokens, cost: 0.1, at: 5000 })

    expect(messageStore.getCompactionUsage('session-1')).toMatchObject({ tokens, cost: 0.1, at: 5000 })
    expect(messageStore.getSessionState('session-1')?.compactedAt).toBe(5000)

    // 更早的压缩结果不得把分隔条时间往回拨
    messageStore.recordCompactionResult('session-1', { tokens, at: 4000 })
    expect(messageStore.getSessionState('session-1')?.compactedAt).toBe(5000)
  })

  it('records server cumulative usage and ignores unknown sessions', () => {
    messageStore.setMessages('session-1', [createMessageWithParts('message-1', 'hello')])
    const tokens = { input: 4000, output: 800, reasoning: 0, cache: { read: 100, write: 20 } }

    messageStore.recordSessionUsage('session-1', tokens, 2.5)
    expect(messageStore.getSessionUsage('session-1')).toEqual({ tokens, cost: 2.5 })

    // 为不存在的会话建档会在侧栏冒出幽灵项，必须忽略
    messageStore.recordSessionUsage('session-does-not-exist', tokens, 1)
    expect(messageStore.getSessionState('session-does-not-exist')).toBeUndefined()
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

/**
 * v2 的实时事件流没有 message.updated，用户消息的唯一信号是
 * `session.inbox.enqueued`。它必须落成一条**带正文**的用户消息：
 * 只建骨架不建 part 会渲染成空白气泡，完全不建则其他端看不到（吞消息）。
 */
describe('upsertRemoteUserMessage (v2 session.inbox.enqueued)', () => {
  beforeEach(() => {
    messageStore.clearAll()
  })

  const KEY = 'local::ses_inbox'
  const MSG_ID = 'msg_inbox1'

  it('creates a user message with a text part so other clients see it immediately', () => {
    messageStore.upsertRemoteUserMessage(KEY, { messageId: MSG_ID, text: 'from another device', createdAt: 200 })

    const state = messageStore.getSessionState(KEY)!
    const row = state.messages.find(m => m.info.id === MSG_ID)!
    expect(row.info.role).toBe('user')
    expect(row.info.time?.created).toBe(200)
    const textParts = row.content.filter(p => p.type === 'text')
    expect(textParts).toHaveLength(1)
    expect((textParts[0] as { text: string }).text).toBe('from another device')
    // 复合 key：part/info 上都用权威 bucket，UI 与 store 内部一致
    expect(row.info.sessionID).toBe(KEY)
  })

  it('replaces the local optimistic row instead of duplicating it', () => {
    messageStore.upsertLocalMessage({
      info: {
        id: MSG_ID,
        sessionID: 'ses_inbox',
        role: 'user',
        time: { created: 200 },
        agent: 'build',
        model: { providerID: 'p', modelID: 'm' },
      },
      content: [
        { id: `${MSG_ID}:text`, sessionID: 'ses_inbox', messageID: MSG_ID, type: 'text', text: 'from another device' },
      ],
      isStreaming: false,
    } as import('../types/message').Message)

    messageStore.upsertRemoteUserMessage(KEY, { messageId: MSG_ID, text: 'from another device', createdAt: 200 })

    const userRows = messageStore.getSessionState(KEY)!.messages.filter(m => m.info.role === 'user')
    expect(userRows).toHaveLength(1)
    // 保留下来的 model/agent 不被清空（服务端事件不带这些字段）
    expect((userRows[0].info as { agent?: string }).agent).toBe('build')
  })

  it('does not resurrect a removed inbox message', () => {
    messageStore.upsertRemoteUserMessage(KEY, { messageId: MSG_ID, text: 'x', createdAt: 200 })
    messageStore.removeMessage(KEY, MSG_ID)
    expect(messageStore.getSessionState(KEY)!.messages.find(m => m.info.id === MSG_ID)).toBeUndefined()
  })
})

/**
 * 轮次结论的权威来源：消息列表里的 `type: "idle"` 记录。
 *
 * 事件流（session.execution.succeeded）负责「及时」，但它**是易失的** ——
 * 服务端对 /api/event 的契约写明「慢消费者会溢出并断开、断线期间的事件会丢失」。
 * 一旦收尾事件丢了（隧道抖动、主机重启、浏览器后台被冻结），界面就会永远
 * 显示「生成中」：停止按钮不消失、项目行一直转圈、消息永远半透明。
 *
 * idle 记录写在消息列表里，刷新即可恢复，所以用它做校正。
 */
describe('settleByAuthoritativeIdle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  function seedStreamingAssistant(id: string, created: number) {
    messageStore.handleMessageUpdated(createAssistantMessage(id))
    messageStore.setStreaming('session-1', true)
    // 标记这条 assistant 仍在流式中（渲染层据此显示光标）
    const state = messageStore.getSessionState('session-1')!
    state.messages = state.messages.map(m => ({ ...m, isStreaming: true }))
    const msg = state.messages.find(m => m.info.id === id)!
    msg.info.time = { created } as never
  }

  it('settles a stuck streaming state when an idle record covers it', () => {
    seedStreamingAssistant('message-1', 1000)
    messageStore.updateSessionMetadata('session-1', { lastTurn: { at: 2000, outcome: 'succeeded' } })

    expect(messageStore.getIsStreaming('session-1')).toBe(true)
    expect(messageStore.settleByAuthoritativeIdle('session-1')).toBe(true)
    expect(messageStore.getIsStreaming('session-1')).toBe(false)
    // 消息上的流式标记也要落定，否则光标还在闪
    expect(messageStore.getSessionState('session-1')!.messages[0].isStreaming).toBe(false)
  })

  it('does not settle when the idle record predates the last assistant message', () => {
    // 上一轮的 idle 还留在页里，而新一轮已经产生了更晚的 assistant 消息：
    // 此时绝不能据此落定，否则会把正在跑的轮次误判成已结束。
    seedStreamingAssistant('message-1', 5000)
    messageStore.updateSessionMetadata('session-1', { lastTurn: { at: 2000, outcome: 'succeeded' } })

    expect(messageStore.settleByAuthoritativeIdle('session-1')).toBe(false)
    expect(messageStore.getIsStreaming('session-1')).toBe(true)
  })

  it('is a no-op when there is no idle record', () => {
    seedStreamingAssistant('message-1', 1000)
    expect(messageStore.settleByAuthoritativeIdle('session-1')).toBe(false)
    expect(messageStore.getIsStreaming('session-1')).toBe(true)
  })

  it('is a no-op when the session is not streaming', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.setStreaming('session-1', false)
    messageStore.updateSessionMetadata('session-1', { lastTurn: { at: 2000, outcome: 'succeeded' } })
    expect(messageStore.settleByAuthoritativeIdle('session-1')).toBe(false)
  })

  it('records interrupted/failed outcomes so the UI can distinguish them', () => {
    seedStreamingAssistant('message-1', 1000)
    messageStore.updateSessionMetadata('session-1', {
      lastTurn: { at: 2000, outcome: 'interrupted', error: 'shutdown' },
    })
    messageStore.settleByAuthoritativeIdle('session-1')
    expect(messageStore.getSessionState('session-1')!.lastTurn).toEqual({
      at: 2000,
      outcome: 'interrupted',
      error: 'shutdown',
    })
  })
})

/**
 * 工具执行中的进度（v2 `session.tool.progress`，ephemeral）。
 *
 * 实测载荷（bash）：{ sessionID, assistantMessageID, id: "call_x",
 *                     metadata: { shellID: "sh_x" } }
 *
 * 它是 ephemeral、不落库，且可能与 tool.success 乱序到达。
 */
describe('applyUsageBackfill（骨架投影缺 tokens 的兜底）', () => {
  const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const SNAPSHOT = {
    tokens: { input: 400, output: 418, reasoning: 97, cache: { read: 9088, write: 0 } },
    cost: 0.12,
    created: 1000,
    streamed: 6000,
    completed: 6100,
  }

  /** 骨架投影产出的 assistant：tokens 全 0、created===completed（轮次时间） */
  function skeletonAssistant(id: string) {
    return {
      info: {
        ...createAssistantMessage(id),
        time: { created: 1000, completed: 1000 },
        tokens: ZERO,
        cost: 0,
      },
      content: [],
      isCompressed: true,
    }
  }

  beforeEach(() => {
    messageStore.clearAll()
  })

  /** 取第一条消息的 assistant info（测试里都是 assistant，收窄避免联合类型报错） */
  function assistantInfoOf(sessionKey: string) {
    const info = messageStore.getSessionState(sessionKey)!.messages[0].info
    return info as Extract<typeof info, { role: 'assistant' }>
  }

  it('fills tokens and authoritative time for skeleton messages', () => {
    messageStore.setMessages('session-1', [skeletonAssistant('reply-1')] as never)
    messageStore.applyUsageBackfill('session-1', new Map([['reply-1', SNAPSHOT]]))

    const info = assistantInfoOf('session-1')
    expect(info.tokens).toMatchObject({ input: 400, output: 418, reasoning: 97 })
    expect(info.tokens.cache.read).toBe(9088)
    // created===completed 会让统计判定「未结算」而整条跳过，必须换成权威时间
    expect(info.time).toMatchObject({ created: 1000, streamed: 6000, completed: 6100 })
  })

  it('never overwrites messages that already carry measured tokens', () => {
    const measured = {
      info: {
        ...createAssistantMessage('reply-1'),
        time: { created: 2000, streamed: 3000, completed: 3500 },
        tokens: { input: 111, output: 22, reasoning: 0, cache: { read: 33, write: 0 } },
      },
      content: [],
    }
    messageStore.setMessages('session-1', [measured] as never)
    messageStore.applyUsageBackfill('session-1', new Map([['reply-1', SNAPSHOT]]))

    const info = assistantInfoOf('session-1')
    expect(info.tokens).toMatchObject({ input: 111, output: 22 })
    expect(info.time?.streamed).toBe(3000)
  })

  it('leaves messages without a matching snapshot untouched', () => {
    messageStore.setMessages('session-1', [skeletonAssistant('reply-unknown')] as never)
    messageStore.applyUsageBackfill('session-1', new Map([['reply-1', SNAPSHOT]]))

    expect(assistantInfoOf('session-1').tokens).toMatchObject(ZERO)
  })

  it('is a no-op for an unknown session', () => {
    expect(() => messageStore.applyUsageBackfill('missing', new Map([['a', SNAPSHOT]]))).not.toThrow()
  })
})

describe('applyToolProgress', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('merges metadata into a running tool part', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))

    messageStore.applyToolProgress('session-1', 'call-1', { shellID: 'sh_abc' })

    const part = messageStore.getSessionState('session-1')!.messages[0].content[0] as {
      state: { status: string; metadata?: Record<string, unknown> }
    }
    expect(part.state.metadata).toEqual({ shellID: 'sh_abc' })
    // 状态必须保持 running：progress 不能把工具落定
    expect(part.state.status).toBe('running')
  })

  it('never downgrades a completed tool back to running', () => {
    // 乱序场景：success 先到，迟到的 progress 不能把它改回运行中
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))
    messageStore.settleToolByCallID('session-1', 'call-1', { status: 'completed', output: 'done' })

    messageStore.applyToolProgress('session-1', 'call-1', { shellID: 'sh_late' })

    const part = messageStore.getSessionState('session-1')!.messages[0].content[0] as {
      state: { status: string; metadata?: Record<string, unknown> }
    }
    expect(part.state.status).toBe('completed')
    expect(part.state.metadata).toBeUndefined()
  })

  it('merges progressively instead of replacing previous progress', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))

    messageStore.applyToolProgress('session-1', 'call-1', { shellID: 'sh_abc' })
    messageStore.applyToolProgress('session-1', 'call-1', { stage: 'downloading' })

    const part = messageStore.getSessionState('session-1')!.messages[0].content[0] as {
      state: { metadata?: Record<string, unknown> }
    }
    expect(part.state.metadata).toEqual({ shellID: 'sh_abc', stage: 'downloading' })
  })

  it('ignores progress for an unknown callID', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))
    messageStore.applyToolProgress('session-1', 'other-call', { shellID: 'sh_x' })
    const part = messageStore.getSessionState('session-1')!.messages[0].content[0] as {
      state: { metadata?: Record<string, unknown> }
    }
    expect(part.state.metadata).toBeUndefined()
  })
})

describe('applyToolProgress performance contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('keeps untouched messages by reference so React can skip them', () => {
    // progress 事件在长命令期间每秒来多条。若每次全量 map 重建 messages，
    // React 会认为整条会话都变了、每秒全量重渲染 —— 长会话里就是「卡」。
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))
    messageStore.handleMessageUpdated(createAssistantMessage('message-2'))
    messageStore.handlePartUpdated(createTextPart('part-2', 'message-2', 'other content'))

    const before = messageStore.getSessionState('session-1')!.messages
    const untouchedBefore = before.find(m => m.info.id === 'message-2')!

    messageStore.applyToolProgress('session-1', 'call-1', { shellID: 'sh_1' })

    const after = messageStore.getSessionState('session-1')!.messages
    const untouchedAfter = after.find(m => m.info.id === 'message-2')!
    // 同一对象引用：虚拟列表与 memo 化的行可以直接跳过重渲染
    expect(untouchedAfter).toBe(untouchedBefore)
    // 命中的那条必须是新对象（否则 React 看不到变化）
    expect(after.find(m => m.info.id === 'message-1')).not.toBe(before.find(m => m.info.id === 'message-1'))
  })
})

describe('onSessionEvicted（会话状态被丢弃的通知）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('clearSession 会通知订阅者，且带上复合 key', () => {
    /**
     * 会话状态（含 usage / contextUsage）只在内存里，清掉即丢失。
     * 依赖这些字段的模块（contextBackfill 的去重集合）必须能感知到，
     * 否则重新打开会话时会被「已补过」挡掉，圆环永久退化为字符估算。
     */
    const seen: string[] = []
    const off = messageStore.onSessionEvicted(key => seen.push(key))
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.clearSession('session-1')
    off()
    expect(seen).toEqual(['session-1'])
  })

  it('clearAll 会为每个被丢弃的会话各通知一次', () => {
    const seen: string[] = []
    const off = messageStore.onSessionEvicted(key => seen.push(key))
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handleMessageUpdated({ ...createAssistantMessage('message-2'), sessionID: 'session-2' })
    messageStore.clearAll()
    off()
    expect(seen.sort()).toEqual(['session-1', 'session-2'])
  })

  it('取消订阅后不再收到通知', () => {
    const seen: string[] = []
    const off = messageStore.onSessionEvicted(key => seen.push(key))
    off()
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.clearSession('session-1')
    expect(seen).toEqual([])
  })

  it('订阅者抛错不影响其它订阅者与清空流程', () => {
    const seen: string[] = []
    const offBad = messageStore.onSessionEvicted(() => {
      throw new Error('boom')
    })
    const offGood = messageStore.onSessionEvicted(key => seen.push(key))
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    expect(() => messageStore.clearSession('session-1')).not.toThrow()
    offBad()
    offGood()
    expect(seen).toEqual(['session-1'])
    expect(messageStore.getSessionState('session-1')).toBeUndefined()
  })
})

describe('recordSessionUsageFallback（服务端快照兜底累计用量）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  const usage = (input: number) => ({
    input,
    output: 10,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  it('没有现有值时直接写入', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.recordSessionUsageFallback('session-1', usage(100), 0.5)
    expect(messageStore.getSessionUsage('session-1')?.tokens.input).toBe(100)
  })

  it('服务端快照更大时覆盖（纠正丢事件留下的偏小值）', () => {
    /**
     * 回归：旧实现「已有值就不覆盖」。一旦某次 usage 事件丢失、写进了偏小的
     * 值，后续任何对账都纠正不回来，数字永久偏小。
     * 服务端累计用量单调递增，所以「更大 = 更新」。
     */
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.recordSessionUsageFallback('session-1', usage(100), 0.5)
    messageStore.recordSessionUsageFallback('session-1', usage(900), 2)
    expect(messageStore.getSessionUsage('session-1')?.tokens.input).toBe(900)
    expect(messageStore.getSessionUsage('session-1')?.cost).toBe(2)
  })

  it('服务端快照更小时保留现有值（不回退）', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.recordSessionUsageFallback('session-1', usage(900), 2)
    messageStore.recordSessionUsageFallback('session-1', usage(100), 0.5)
    expect(messageStore.getSessionUsage('session-1')?.tokens.input).toBe(900)
  })

  it('会话不在内存时不建档', () => {
    messageStore.recordSessionUsageFallback('session-unknown', usage(100), 0.5)
    expect(messageStore.getSessionState('session-unknown')).toBeUndefined()
  })
})

describe('getAllSessionKeys（周期对账的枚举入口）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('只返回内存里真实存在的会话', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handleMessageUpdated({ ...createAssistantMessage('message-2'), sessionID: 'session-2' })
    expect(messageStore.getAllSessionKeys().sort()).toEqual(['session-1', 'session-2'])
    messageStore.clearSession('session-1')
    expect(messageStore.getAllSessionKeys()).toEqual(['session-2'])
  })
})

describe('settleByAuthoritativeIdle：外部权威时间 + 悬空工具兜底', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('可用外部传入的权威 idle 时间落定（不依赖加载时记下的 lastTurn）', () => {
    /**
     * 回归：`lastTurn` 只在 loadSession 时写一次，之后不随 SSE 更新。
     * 运行期「收尾事件丢失」时，只靠 lastTurn 的判定永远返回 false，
     * 界面就永久卡在「生成中」—— 这正是这条兜底要解决的问题。
     */
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.setStreaming('session-1', true)
    const state = messageStore.getSessionState('session-1')!
    state.messages = state.messages.map(m => ({ ...m, isStreaming: true }))
    state.messages[0].info.time = { created: 1000 } as never
    // 没有任何 lastTurn
    expect(messageStore.getSessionState('session-1')!.lastTurn).toBeUndefined()

    expect(messageStore.settleByAuthoritativeIdle('session-1', 5000)).toBe(true)
    expect(messageStore.getIsStreaming('session-1')).toBe(false)
    expect(messageStore.getSessionState('session-1')!.messages[0].isStreaming).toBe(false)
  })

  it('外部时间早于最后一条 assistant 时仍拒绝落定（避免误杀新一轮）', () => {
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.setStreaming('session-1', true)
    const state = messageStore.getSessionState('session-1')!
    state.messages[0].info.time = { created: 9000 } as never

    expect(messageStore.settleByAuthoritativeIdle('session-1', 5000)).toBe(false)
    expect(messageStore.getIsStreaming('session-1')).toBe(true)
  })

  it('落定时一并把悬空工具标为 interrupted（不依赖 tool 事件）', () => {
    /**
     * 工具的落定原本只有两个入口：settleToolByCallID（SSE 驱动）与
     * finalizeSession（idle 事件驱动）。两者都依赖同一条事件流，
     * 事件一丢，工具卡片就永久转圈。这里让权威 idle 也能收尾。
     */
    messageStore.handleMessageUpdated(createAssistantMessage('message-1'))
    messageStore.handlePartUpdated(createRunningToolPart('part-1', 'message-1', 'running', 'call-1'))
    messageStore.setStreaming('session-1', true)
    const state = messageStore.getSessionState('session-1')!
    state.messages[0].info.time = { created: 1000 } as never

    expect(messageStore.settleByAuthoritativeIdle('session-1', 5000)).toBe(true)
    const part = messageStore.getSessionState('session-1')!.messages[0].content[0]
    expect(part.type).toBe('tool')
    expect(part.type === 'tool' ? part.state.status : null).toBe('interrupted')
  })
})
