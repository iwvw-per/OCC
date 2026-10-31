import { beforeEach, describe, expect, it } from 'vitest'
import { isSessionRunning } from './useSessionRunning'
import { messageStore } from '../store/messageStore'
import type { ApiMessage } from '../api/types'

function assistant(id: string, time: { created: number; completed?: number }): { info: ApiMessage; parts: unknown[] } {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      parentID: 'user-1',
      modelID: 'm',
      providerID: 'p',
      mode: 'chat',
      agent: 'build',
      path: { cwd: '/w', root: '/w' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time,
    } as ApiMessage,
    parts: [],
  }
}

function user(id: string, created: number): { info: ApiMessage; parts: unknown[] } {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'user',
      time: { created },
    } as ApiMessage,
    parts: [],
  }
}

describe('isSessionRunning：统一判据', () => {
  it('trusts the server while this turn is still live', () => {
    // 本地快照显示未定稿，服务端也在跑 → 必须算在跑
    expect(
      isSessionRunning({
        serverRunning: true,
        localStreaming: false,
        lastAssistant: { isStreaming: false, info: { time: { created: 5 } } },
      }),
    ).toBe(true)
  })

  /**
   * 回归（2026-10-31 实测，arm 主机 ses_e6e0b3d23ffe7YEJI1DItkyUuv）：
   * 会话已 `succeeded`、`time.idle` 早于现在 10 分钟，`/api/session/active`
   * 却仍报 running（该会话最后一条 assistant 也没 completed）。
   *
   * 这时若继续无条件采信服务端，界面就永久停在「处理中」——
   * 用户看到的是「回复已经写完并渲染出来，但标题一直 Working」。
   */
  it('treats a settled last assistant as finished even if the server still reports running', () => {
    expect(
      isSessionRunning({
        serverRunning: true,
        localStreaming: false,
        lastAssistant: { isStreaming: false, info: { time: { created: 5, completed: 9 } }, content: [] },
      }),
    ).toBe(false)
  })

  it('still counts as running when a settled assistant has a live tool', () => {
    // 工具循环间隙：上一条已定稿，但下一步还在执行 —— 这一轮确实没完
    expect(
      isSessionRunning({
        serverRunning: true,
        localStreaming: false,
        lastAssistant: {
          isStreaming: false,
          info: { time: { created: 5, completed: 9 } },
          content: [{ type: 'tool', state: { status: 'running' } }],
        },
      }),
    ).toBe(true)
  })

  it('treats an unfinished assistant as running even when the session flag is false', () => {
    /**
     * 回归：会话级 isStreaming 可能已被收尾路径清掉，而消息仍未定稿。
     * 只看会话标志会让界面认为已结束（或反过来卡在「处理中」）。
     */
    expect(
      isSessionRunning({
        serverRunning: false,
        localStreaming: false,
        lastAssistant: { isStreaming: false, info: { time: { created: 5 } } },
      }),
    ).toBe(true)
  })

  it('treats a settled assistant with no server activity as finished', () => {
    expect(
      isSessionRunning({
        serverRunning: false,
        localStreaming: false,
        lastAssistant: { isStreaming: false, info: { time: { created: 5, completed: 9 } } },
      }),
    ).toBe(false)
  })

  it('falls back to the session flag when there is no assistant yet', () => {
    expect(isSessionRunning({ serverRunning: false, localStreaming: true, lastAssistant: null })).toBe(true)
    expect(isSessionRunning({ serverRunning: false, localStreaming: false, lastAssistant: null })).toBe(false)
  })
})

describe('messageStore.isLastTurnComplete：轮次定稿判据', () => {
  beforeEach(() => {
    messageStore.clearAll()
  })

  it('is false while the last turn has an unfinished assistant', () => {
    messageStore.setMessages('session-1', [user('u1', 1), assistant('a1', { created: 2 })] as never, {})
    expect(messageStore.isLastTurnComplete('session-1')).toBe(false)
  })

  it('is true when the last turn is fully settled', () => {
    messageStore.setMessages('session-1', [user('u1', 1), assistant('a1', { created: 2, completed: 3 })] as never, {})
    expect(messageStore.isLastTurnComplete('session-1')).toBe(true)
  })

  /**
   * 快照里的 text part 根本不带 time，按「缺 end」判会把每个正常轮次都算成
   * 不完整，收敛点就会每轮都重拉。判据必须是「有 time 但没有 end」。
   */
  it('only flags parts that have a start time but no end time', () => {
    const snapshot = assistant('a1', { created: 2, completed: 3 })
    snapshot.parts = [{ id: 'a1-text-0', sessionID: 'session-1', messageID: 'a1', type: 'text', text: 'done' }]
    messageStore.setMessages('session-1', [user('u1', 1), snapshot] as never, {})
    expect(messageStore.isLastTurnComplete('session-1')).toBe(true)

    const live = assistant('a2', { created: 2, completed: 3 })
    live.parts = [
      {
        id: 'a2-text-0',
        sessionID: 'session-1',
        messageID: 'a2',
        type: 'text',
        text: 'streaming',
        time: { start: 2 },
      },
    ]
    messageStore.setMessages('session-1', [user('u1', 1), live] as never, {})
    expect(messageStore.isLastTurnComplete('session-1')).toBe(false)
  })
})
