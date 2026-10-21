import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPTIMISTIC_BUSY_TTL_MS, activeSessionStore } from './activeSessionStore'

// 「折叠的项目行右侧一直转圈」的回归保护。
//
// 根因：pending（等用户回复）产生的 busy、以及本地乐观置忙，都不是「服务端在跑」。
// 前者让一个从没点开的权限请求把目录显示成运行中；后者在没有 status 收尾时永远不消失。

describe('activeSessionStore running sources', () => {
  beforeEach(() => {
    activeSessionStore.initialize({})
    activeSessionStore.initializePendingRequests([], [])
    vi.useRealTimers()
  })

  it('does not expose the session status when idle arrived before the reply', () => {
    activeSessionStore.updateStatus('local::ses_1', { type: 'busy' })
    expect(activeSessionStore.getBusySessions()[0]?.source).toBe('server')

    // 服务端 idle，但请求还悬着：条目保留，但只算 pending，不算在跑
    activeSessionStore.addPendingRequest('req-1', 'local::ses_1', 'permission', 'bash')
    activeSessionStore.updateStatus('local::ses_1', { type: 'idle' })
    const entry = activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_1')
    expect(entry?.source).toBe('pending')

    // 处理完请求：条目彻底移除，不再有任何残留
    activeSessionStore.resolvePendingRequest('req-1')
    expect(activeSessionStore.getBusySessions()).toEqual([])
  })

  it('drops a slot created only by a pending request right after it is resolved', () => {
    // 从来没跑过的会话：只有权限请求，没有服务端 busy
    activeSessionStore.addPendingRequest('req-2', 'local::ses_2', 'question', 'pick one')
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_2')?.source).toBe('pending')

    activeSessionStore.resolvePendingRequest('req-2')
    expect(activeSessionStore.getBusySessions()).toEqual([])
  })

  it('expires optimistic busy that never received any evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    activeSessionStore.applyOptimisticBusy('local::ses_3')
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_3')?.source).toBe('local')

    vi.setSystemTime(1_000 + OPTIMISTIC_BUSY_TTL_MS + 1)
    expect(activeSessionStore.expireStaleOptimisticEntries()).toBe(true)
    expect(activeSessionStore.getBusySessions()).toEqual([])
  })

  it('promotes optimistic busy as soon as real session activity arrives', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    activeSessionStore.applyOptimisticBusy('local::ses_4')
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_4')?.source).toBe('local')

    // 消息/工具事件 = 确实在跑。此前 touchSession 只续期乐观计时、不改 source，
    // 条目一直停在 'local'，超时后被回收 —— 用户看到「运行中不转圈，跑完反而
    // 冒出状态点」。这里必须升级为有佐证。
    activeSessionStore.touchSession('local::ses_4')
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_4')?.source).toBe('server')

    // 有佐证后不再被乐观超时回收：长轮次中途不会掉状态
    vi.setSystemTime(1_000 + OPTIMISTIC_BUSY_TTL_MS + 1)
    expect(activeSessionStore.expireStaleOptimisticEntries()).toBe(false)
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_4')?.source).toBe('server')
  })

  it('promotes optimistic busy to server source once the server confirms it', () => {
    activeSessionStore.applyOptimisticBusy('local::ses_5')
    activeSessionStore.updateStatus('local::ses_5', { type: 'busy' })
    expect(activeSessionStore.getBusySessions().find(e => e.sessionId === 'local::ses_5')?.source).toBe('server')
  })
})
