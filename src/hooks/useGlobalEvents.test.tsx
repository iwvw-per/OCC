import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSessionConsumer, useGlobalEvents } from './useGlobalEvents'
import { messageStore } from '../store'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

/** 测试用：把扁平目录列表归到活动服务器（mock 的 getActiveServerId 返回 'local'）。 */
function dirsFor(directories: string[], serverId = 'local'): Map<string, string[]> {
  return new Map([[serverId, directories]])
}

const {
  subscribeToEventsMock,
  getSessionStatusMock,
  getPendingPermissionsMock,
  getPendingQuestionsMock,
  getSessionMock,
  replyPermissionMock,
  childBelongsToSessionMock,
  getSessionInfoMock,
  getFocusedSessionIdMock,
  getSessionAndDescendantsMock,
  notificationPushMock,
  notificationToastMock,
  markSessionNotificationsReadMock,
  removeSessionNotificationsMock,
  playNotificationSoundDedupedMock,
  getSoundSnapshotMock,
  isSystemEnabledMock,
  activeSessionStoreMock,
  applyServerConnectedTimestampMock,
  getActiveServerIdMock,
  checkHealthMock,
  getServerMock,
  onServerChangeMock,
  autoApproveStoreMock,
  clearSessionRuntimeStateMock,
  clearPaneSessionMock,
  markIdleMock,
} = vi.hoisted(() => ({
  subscribeToEventsMock: vi.fn(),
  getSessionStatusMock: vi.fn<(directory?: string) => Promise<Record<string, { type: string }>>>(() =>
    Promise.resolve({}),
  ),
  getPendingPermissionsMock: vi.fn(() =>
    Promise.resolve([] as Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>),
  ),
  getPendingQuestionsMock: vi.fn(() => Promise.resolve([])),
  getSessionMock: vi.fn((_sessionId: string) => Promise.resolve({ id: _sessionId, directory: '' })),
  replyPermissionMock: vi.fn(() => Promise.resolve()),
  childBelongsToSessionMock: vi.fn<(sessionId: string, rootSessionId: string) => boolean>(() => false),
  getSessionInfoMock: vi.fn<(sessionId: string) => unknown>(() => undefined),
  getFocusedSessionIdMock: vi.fn<() => string | null>(() => null),
  getSessionAndDescendantsMock: vi.fn((sessionId: string) => [sessionId]),
  notificationPushMock: vi.fn(),
  notificationToastMock: vi.fn(),
  markSessionNotificationsReadMock: vi.fn(),
  removeSessionNotificationsMock: vi.fn(),
  playNotificationSoundDedupedMock: vi.fn(),
  isSystemEnabledMock: vi.fn((type: string) => type !== 'permission'),
  applyServerConnectedTimestampMock: vi.fn(),
  getActiveServerIdMock: vi.fn(() => 'local'),
  getServerMock: vi.fn(() => ({ id: 'local', name: 'Local', url: 'http://localhost:4242' })),
  checkHealthMock: vi.fn(() => Promise.resolve({ status: 'online' })),
  onServerChangeMock: vi.fn((_listener: (serverId: string) => void) => vi.fn()),
  clearSessionRuntimeStateMock: vi.fn(),
  clearPaneSessionMock: vi.fn(),
  markIdleMock: vi.fn(),
  getSoundSnapshotMock: vi.fn(() => ({
    currentSessionEnabled: true,
  })),
  activeSessionStoreMock: {
    initialize: vi.fn(),
    initializePendingRequests: vi.fn(),
    mergeStatusRefresh: vi.fn(),
    mergePendingRequests: vi.fn(),
    setSessionMetaBulk: vi.fn(),
    setSessionMeta: vi.fn(),
    getSessionMeta: vi.fn((sessionId?: string) => ({
      title: sessionId || 'Child Session',
      directory: '/workspace' as string | undefined,
    })),
    addPendingRequest: vi.fn(),
    resolvePendingRequest: vi.fn(),
    updateStatus: vi.fn(() => true),
    removeSession: vi.fn(),
    replaceServerStatus: vi.fn(),
    getSnapshot: vi.fn(() => ({ statusMap: {} })),
  },
  autoApproveStoreMock: {
    fullAutoMode: 'off' as 'off' | 'session' | 'global',
    approvePendingOnFullAuto: false,
    subscribe: vi.fn((_listener: () => void) => vi.fn()),
    getPaneFullAutoMode: vi.fn((_paneId: string) => 'off' as 'off' | 'session' | 'global'),
    claimAutoReply: vi.fn((_requestId: string) => true),
    releaseAutoReply: vi.fn((_requestId: string) => undefined),
  },
}))

vi.mock('../api', () => ({
  subscribeToEvents: subscribeToEventsMock,
  subscribeToServerEvents: (_serverId: string, cb: unknown) => subscribeToEventsMock(cb),
  getSession: getSessionMock,
  getSessionStatus: getSessionStatusMock,
  getPendingPermissions: getPendingPermissionsMock,
  getPendingQuestions: getPendingQuestionsMock,
}))

vi.mock('../api/permission', () => ({
  replyPermission: replyPermissionMock,
}))

/**
 * `useGlobalEvents` 直接从 `../api/events` 取缺口订阅入口（不走 `../api` 的
 * 再导出），因此必须单独 mock，否则会拉起真实的 SSE 连接管理器。
 */
const { seqGapHandlers, ackSeqGapMock } = vi.hoisted(() => ({
  seqGapHandlers: new Set<(serverId: string, aggregateID: string) => void>(),
  ackSeqGapMock: vi.fn(),
}))
vi.mock('../api/events', () => ({
  onSeqGap: (fn: (serverId: string, aggregateID: string) => void) => {
    seqGapHandlers.add(fn)
    return () => seqGapHandlers.delete(fn)
  },
  ackSeqGap: ackSeqGapMock,
  subscribeToServerEvents: (_serverId: string, cb: unknown) => subscribeToEventsMock(cb),
}))

vi.mock('../store', () => ({
  messageStore: {
    handleMessageUpdated: vi.fn(),
    handlePartUpdated: vi.fn(),
    handlePartDelta: vi.fn(),
    handlePartRemoved: vi.fn(),
    handleSessionIdle: vi.fn(),
    handleSessionError: vi.fn(),
    markServerSessionsStale: vi.fn(),
    markSessionStale: vi.fn(),
    getAllSessionKeys: vi.fn(() => [] as string[]),
    getIsStreaming: vi.fn(() => false),
    settleByAuthoritativeIdle: vi.fn(() => false),
    recordCompactionResult: vi.fn(),
    recordSessionUsage: vi.fn(),
    getSessionState: vi.fn(() => null),
    updateSessionMetadata: vi.fn(),
  },
  childSessionStore: {
    belongsToSession: childBelongsToSessionMock,
    getSessionAndDescendants: getSessionAndDescendantsMock,
    getSessionInfo: getSessionInfoMock,
    markIdle: markIdleMock,
    markError: vi.fn(),
    registerChildSession: vi.fn(),
  },
  paneLayoutStore: {
    getFocusedSessionId: getFocusedSessionIdMock,
    clearSession: clearPaneSessionMock,
    closeSubtaskSession: vi.fn(),
    allLeaves: () => [],
    subscribe: () => () => {},
  },
  serverStore: {
    applyServerConnectedTimestamp: applyServerConnectedTimestampMock,
    getActiveServerId: getActiveServerIdMock,
    getServer: getServerMock,
    checkHealth: checkHealthMock,
    onServerChange: onServerChangeMock,
    // fetchAndInitialize 会先确认 API 版本；已连接场景一律视为 v1，
    // 保证数据拉取不排在探测之后
    getApiVersion: vi.fn(() => 'v1'),
    ensureApiVersion: vi.fn(() => Promise.resolve('v1' as const)),
    // collectActiveServerIds 遍历所有「已启用」服务器并订阅其变化
    getEnabledServers: () => [],
    subscribe: () => () => {},
  },
}))

vi.mock('../store/activeSessionStore', () => ({
  activeSessionStore: activeSessionStoreMock,
}))

vi.mock('../store/notificationStore', () => ({
  notificationStore: {
    push: notificationPushMock,
    toast: notificationToastMock,
    markSessionNotificationsRead: markSessionNotificationsReadMock,
    removeSessionNotifications: removeSessionNotificationsMock,
  },
}))

vi.mock('../store/soundStore', () => ({
  soundStore: {
    getSnapshot: () => getSoundSnapshotMock(),
  },
}))

vi.mock('../store/notificationEventSettingsStore', () => ({
  notificationEventSettingsStore: {
    isSystemEnabled: (type: 'completed' | 'permission' | 'question' | 'error') => isSystemEnabledMock(type),
  },
}))

vi.mock('../utils/notificationSoundBridge', () => ({
  playNotificationSoundDeduped: playNotificationSoundDedupedMock,
}))

vi.mock('../utils/sessionLifecycle', () => ({
  clearSessionRuntimeState: (...args: unknown[]) => clearSessionRuntimeStateMock(...args),
}))

vi.mock('../store/autoApproveStore', () => ({
  autoApproveStore: autoApproveStoreMock,
}))

describe('useGlobalEvents', () => {
  beforeEach(() => {
    subscribeToEventsMock.mockReset()
    getSessionStatusMock.mockClear()
    getPendingPermissionsMock.mockClear()
    getPendingQuestionsMock.mockClear()
    getSessionMock.mockClear()
    replyPermissionMock.mockClear()
    childBelongsToSessionMock.mockReset()
    getSessionInfoMock.mockReset()
    getFocusedSessionIdMock.mockReset()
    getSessionAndDescendantsMock.mockReset()
    notificationPushMock.mockReset()
    notificationToastMock.mockReset()
    markSessionNotificationsReadMock.mockReset()
    removeSessionNotificationsMock.mockReset()
    playNotificationSoundDedupedMock.mockReset()
    getSoundSnapshotMock.mockReset()
    isSystemEnabledMock.mockReset()
    applyServerConnectedTimestampMock.mockReset()
    getActiveServerIdMock.mockReset()
    checkHealthMock.mockReset()
    onServerChangeMock.mockReset()
    clearSessionRuntimeStateMock.mockReset()
    clearPaneSessionMock.mockReset()
    autoApproveStoreMock.fullAutoMode = 'off'
    autoApproveStoreMock.approvePendingOnFullAuto = false
    autoApproveStoreMock.subscribe.mockReset()
    autoApproveStoreMock.getPaneFullAutoMode.mockReset()
    autoApproveStoreMock.claimAutoReply.mockReset()
    autoApproveStoreMock.releaseAutoReply.mockReset()
    Object.values(activeSessionStoreMock).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    })

    subscribeToEventsMock.mockImplementation(() => vi.fn())
    getSoundSnapshotMock.mockReturnValue({
      currentSessionEnabled: true,
    })
    isSystemEnabledMock.mockImplementation((type: string) => type !== 'permission')
    getActiveServerIdMock.mockReturnValue('local')
    checkHealthMock.mockResolvedValue({ status: 'online' })
    onServerChangeMock.mockReturnValue(vi.fn())
    getSessionAndDescendantsMock.mockImplementation((sessionId: string) => [sessionId])
    getSessionInfoMock.mockReturnValue(undefined)
    autoApproveStoreMock.subscribe.mockReturnValue(vi.fn())
    autoApproveStoreMock.getPaneFullAutoMode.mockReturnValue('off')
    autoApproveStoreMock.claimAutoReply.mockReturnValue(true)
    activeSessionStoreMock.getSessionMeta.mockReturnValue({ title: 'Child Session', directory: '/workspace' })
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: {} })
  })

  it('setSessionMetaBulk does not stamp every running session with the same directory', async () => {
    // 回归：v2 的 /api/session/active 是全局接口、不接受 directory（permission
    // 列表同样）。旧实现按项目目录循环调用它，并把返回的每个会话都记成「当前
    // 目录」，最后一个目录覆盖全部 —— 别的项目里正在跑的会话被算到该项目上，
    // 折叠行一直转圈，展开却看不到在跑的会话。
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    // 只有 komidash 在跑
    getSessionStatusMock.mockResolvedValue({ ses_running: { type: 'busy' } })
    getPendingPermissionsMock.mockResolvedValue([])
    getPendingQuestionsMock.mockResolvedValue([])
    // meta 里还没有这个会话的目录（应用启动前就在跑）：必须回落到会话详情，
    // 而不是套用「当前正在查询的目录」。
    activeSessionStoreMock.getSessionMeta.mockReturnValue({ title: 'Running', directory: undefined })
    getSessionMock.mockResolvedValue({ id: 'ses_running', directory: '/repo/komidash' })

    renderHook(() => useGlobalEvents(dirsFor(['/repo/komidash', '/repo/cf-optimize-ip'])))

    await waitFor(() => expect(activeSessionStoreMock.setSessionMetaBulk).toHaveBeenCalled())

    const entries = activeSessionStoreMock.setSessionMetaBulk.mock.calls
      .flatMap((call: unknown[]) => call[0] as Array<{ sessionId: string; directory?: string }>)
      .filter(entry => entry.sessionId === 'local::ses_running')

    // 绝不能出现「同一个会话被打上多个目录」，否则最后一个目录会赢
    expect(new Set(entries.map(entry => entry.directory))).toEqual(new Set(['/repo/komidash']))
    // 而且全局状态只拉一次，不是每个目录各拉一次
    expect(getSessionStatusMock).toHaveBeenCalledTimes(1)
    expect(getSessionStatusMock).toHaveBeenCalledWith(undefined, 'local')
    expect(callbacks).toBeDefined()
  })

  it('stores server clock calibration when server.connected arrives', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onServerConnected?.({ timestamp: '2026-04-22T15:00:00.000Z' })

    expect(applyServerConnectedTimestampMock).toHaveBeenCalledWith('local', '2026-04-22T15:00:00.000Z')
  })

  it('refreshes active server health on mount', async () => {
    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(checkHealthMock).toHaveBeenCalledWith('local'))
  })

  it('refreshes health for the selected server when active server changes', async () => {
    let onServerChange: ((serverId: string) => void) | undefined
    onServerChangeMock.mockImplementation(listener => {
      onServerChange = listener
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(onServerChange).toBeDefined())
    checkHealthMock.mockClear()

    onServerChange!('remote')

    expect(checkHealthMock).toHaveBeenCalledWith('remote')
  })

  it('refreshes active server health when SSE reconnects', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    checkHealthMock.mockClear()

    callbacks!.onReconnected?.('network')

    expect(checkHealthMock).toHaveBeenCalledWith('local')
  })

  it('clears runtime state and panes when a session is deleted', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionAndDescendantsMock.mockReturnValue(['local::deleted-session', 'local::child-session'])

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onSessionDeleted?.('deleted-session')

    expect(clearSessionRuntimeStateMock).toHaveBeenCalledWith('local::deleted-session')
    expect(clearPaneSessionMock).toHaveBeenCalledWith('local::deleted-session')
    expect(clearPaneSessionMock).toHaveBeenCalledWith('local::child-session')
  })

  it('clears active state and notifications when a session is archived by another client', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onSessionUpdated?.({
      id: 'archived-session',
      time: { archived: Date.now() },
    } as never)

    // 归档后会话不再出现在侧栏：活跃条目与通知都要清掉，否则项目行/会话行
    // 会残留「运行中」标识或未读点。
    expect(activeSessionStoreMock.removeSession).toHaveBeenCalledWith('local::archived-session')
    expect(removeSessionNotificationsMock).toHaveBeenCalledWith('local::archived-session')
  })

  it('toasts when a manual compaction fails (e.g. nothing to compact)', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onSessionCompacted?.({
      sessionID: 'ses_1',
      status: 'failed',
      reason: 'manual',
      error: 'Nothing to compact yet',
    })

    // 用户手动 /compact 后必须得到反馈，否则会以为功能失效
    expect(notificationToastMock).toHaveBeenCalledWith('error', expect.any(String), 'Nothing to compact yet')
    expect(messageStore.markServerSessionsStale).not.toHaveBeenCalled()
  })

  it('invalidates cached messages when a manual compaction succeeds', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onSessionCompacted?.({ sessionID: 'ses_1', status: 'completed', reason: 'manual' })

    // 压缩改写了历史，必须重拉，否则看不到压缩后的内容
    expect(messageStore.markServerSessionsStale).toHaveBeenCalled()
  })

  it('records the post-compaction context size before invalidating messages', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    // v2 压缩事件的 tokens 是**压缩前**用量，不能拿来显示压缩后的占用；
    // 真实构成是摘要 + 保留的近期消息（summaryChars / recentChars）。
    const tokens = { input: 342_383, output: 2443, reasoning: 0, cache: { read: 577_024, write: 0 } }
    callbacks!.onSessionCompacted?.({
      sessionID: 'ses_1',
      status: 'completed',
      reason: 'manual',
      tokens,
      cost: 0.02,
      summaryChars: 5442,
      recentChars: 92_322,
      time: 1_700_000_000_000,
    })

    expect(messageStore.recordCompactionResult).toHaveBeenCalledWith(
      expect.stringContaining('ses_1'),
      expect.objectContaining({
        summaryChars: 5442,
        recentChars: 92_322,
        at: 1_700_000_000_000,
      }),
    )
    // 关键：不能把压缩前的 tokens 当成压缩后的占用写进去
    expect(messageStore.recordCompactionResult).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tokens }),
    )
    expect(messageStore.markServerSessionsStale).toHaveBeenCalled()
  })

  it('does not write a zero-size marker when the event carries no sizes', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    // message.part.updated 的 compaction part 只带 tail_start_id，没有摘要规模。
    // 若写成 {summaryChars:0, recentChars:0}，圆环会被误算成 0。
    callbacks!.onSessionCompacted?.({
      sessionID: 'ses_1',
      status: 'completed',
      reason: 'manual',
      tailStartID: 'msg_tail',
      time: 1_700_000_000_000,
    })

    const lastCall = vi.mocked(messageStore.recordCompactionResult).mock.calls.at(-1) as
      | [unknown, Record<string, unknown>]
      | undefined
    expect(lastCall).toBeDefined()
    const options = lastCall![1]
    expect(options.summaryChars).toBeUndefined()
    expect(options.recentChars).toBeUndefined()
    // 分隔条仍要前移
    expect(options.at).toBe(1_700_000_000_000)
  })

  it('records session cumulative usage from session.usage.updated', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    const tokens = { input: 5000, output: 900, reasoning: 100, cache: { read: 300, write: 20 } }
    callbacks!.onSessionUsageUpdated?.({ sessionID: 'ses_1', tokens, cost: 1.25 })

    // 压缩裁掉旧轮次后，按可见消息汇总会变小；这份是服务端累计口径
    expect(messageStore.recordSessionUsage).toHaveBeenCalledWith(expect.stringContaining('ses_1'), tokens, 1.25)
  })

  it('reconciles full server status when SSE reconnects to drop stale busy entries', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionStatusMock.mockResolvedValue({})

    renderHook(() => useGlobalEvents())
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onReconnected?.('network')

    // 重连必须做一次整台替换：断连期间漏掉的 idle/归档事件靠 merge 清不掉，
    // 会让侧栏项目行/会话行一直显示运行中。
    await waitFor(() => {
      expect(activeSessionStoreMock.replaceServerStatus).toHaveBeenCalledWith('local', {})
    })
  })

  it('ignores stale initialization responses after directories change', async () => {
    const statusDeferreds: Array<ReturnType<typeof createDeferred<Record<string, { type: string }>>>> = []
    getPendingPermissionsMock.mockResolvedValue([])
    getPendingQuestionsMock.mockResolvedValue([])
    getSessionStatusMock.mockImplementation(() => {
      const deferred = createDeferred<Record<string, { type: string }>>()
      statusDeferreds.push(deferred)
      return deferred.promise
    })

    const { rerender } = renderHook(({ directories }) => useGlobalEvents(directories), {
      initialProps: { directories: dirsFor(['/one']) },
    })

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(undefined, 'local'))

    rerender({ directories: dirsFor(['/two']) })

    await waitFor(() => expect(statusDeferreds.length).toBe(2))

    statusDeferreds[1]?.resolve({ 'new-session': { type: 'busy' } })

    await waitFor(() => {
      expect(activeSessionStoreMock.mergeStatusRefresh).toHaveBeenCalledTimes(1)
      expect(activeSessionStoreMock.mergeStatusRefresh).toHaveBeenCalledWith({ 'local::new-session': { type: 'busy' } })
    })

    statusDeferreds[0]?.resolve({ 'old-session': { type: 'idle' } })
    await Promise.resolve()
    await Promise.resolve()

    expect(activeSessionStoreMock.mergeStatusRefresh).toHaveBeenCalledTimes(1)
    expect(activeSessionStoreMock.mergeStatusRefresh).not.toHaveBeenCalledWith({
      'local::old-session': { type: 'idle' },
    })
  })

  it('replays pending requests that arrive while initialization is in flight', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    const statusDeferred = createDeferred<Record<string, { type: string }>>()

    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionStatusMock.mockImplementation(() => statusDeferred.promise)
    getPendingPermissionsMock.mockResolvedValue([])
    getPendingQuestionsMock.mockResolvedValue([])

    renderHook(() => useGlobalEvents(dirsFor(['/workspace'])))

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(undefined, 'local'))
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-1',
      sessionID: 'child-session',
      permission: 'edit',
      patterns: ['src/app.tsx'],
    } as never)

    statusDeferred.resolve({})

    await waitFor(() => expect(activeSessionStoreMock.initializePendingRequests).toHaveBeenCalled())

    expect(activeSessionStoreMock.addPendingRequest).toHaveBeenNthCalledWith(
      1,
      'perm-1',
      'local::child-session',
      'permission',
      'edit: src/app.tsx',
    )
    expect(activeSessionStoreMock.addPendingRequest).toHaveBeenNthCalledWith(
      2,
      'perm-1',
      'local::child-session',
      'permission',
      'edit: src/app.tsx',
    )
  })

  it('keeps replaying pending requests across overlapping initialization fetches', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    const statusDeferreds: Array<ReturnType<typeof createDeferred<Record<string, { type: string }>>>> = []

    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    activeSessionStoreMock.getSessionMeta.mockImplementation((sessionId?: string) => {
      if (sessionId === 'local::child-session') return { title: 'Child Session', directory: '/one' }
      if (sessionId === 'local::question-session') return { title: 'Question Session', directory: '/two' }
      return { title: 'Session', directory: '/workspace' }
    })
    getSessionStatusMock.mockImplementation(() => {
      const deferred = createDeferred<Record<string, { type: string }>>()
      statusDeferreds.push(deferred)
      return deferred.promise
    })
    getPendingPermissionsMock.mockResolvedValue([])
    getPendingQuestionsMock.mockResolvedValue([])

    const { rerender } = renderHook(({ directories }) => useGlobalEvents(directories), {
      initialProps: { directories: dirsFor(['/one']) },
    })

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(undefined, 'local'))
    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-1',
      sessionID: 'child-session',
      permission: 'edit',
      patterns: ['src/app.tsx'],
    } as never)

    rerender({ directories: dirsFor(['/two']) })

    await waitFor(() => expect(statusDeferreds.length).toBe(2))

    callbacks!.onQuestionAsked?.({
      id: 'question-1',
      sessionID: 'question-session',
      questions: [{ header: 'Need input' }],
    } as never)

    statusDeferreds[1]?.resolve({})

    await waitFor(() => expect(activeSessionStoreMock.mergePendingRequests).toHaveBeenCalledTimes(1))

    expect(activeSessionStoreMock.addPendingRequest.mock.calls.filter(call => call[0] === 'perm-1')).toHaveLength(1)
    expect(activeSessionStoreMock.addPendingRequest.mock.calls.filter(call => call[0] === 'question-1')).toHaveLength(2)
  })

  it('does not play current-session sound for child session events when parent session is focused', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::parent-session')
    childBelongsToSessionMock.mockImplementation((sessionId: string, rootSessionId: string) => {
      return sessionId === 'local::child-session' && rootSessionId === 'local::parent-session'
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-1',
      sessionID: 'child-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).not.toHaveBeenCalled()
  })

  it('keeps later pending question requests for the same session after one reply arrives', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    const consumerAskedMock = vi.fn()
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onQuestionAsked?.({
      id: 'question-1',
      sessionID: 'child-session',
      questions: [{ header: 'First question' }],
    })
    callbacks!.onQuestionAsked?.({
      id: 'question-2',
      sessionID: 'child-session',
      questions: [{ header: 'Second question' }],
    })

    expect(consumerAskedMock).not.toHaveBeenCalled()

    callbacks!.onQuestionReplied?.({
      sessionID: 'child-session',
      requestID: 'question-1',
    })

    getFocusedSessionIdMock.mockReturnValue('local::parent-session')
    childBelongsToSessionMock.mockImplementation((sessionId: string, rootSessionId: string) => {
      return sessionId === 'local::child-session' && rootSessionId === 'local::parent-session'
    })

    const unregister = registerSessionConsumer('pane-1', 'local::parent-session', {
      onQuestionAsked: consumerAskedMock,
    })

    callbacks!.onSessionCreated?.({
      id: 'child-session',
      parentID: 'parent-session',
      title: 'Child Session',
      directory: '/workspace',
    } as never)

    expect(consumerAskedMock).toHaveBeenCalledTimes(1)
    expect(consumerAskedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-2', sessionID: 'local::child-session' }),
    )

    unregister()
  })

  it('approves already waiting permissions when global full auto pending sweep is enabled', async () => {
    const consumerRepliedMock = vi.fn()
    const unregister = registerSessionConsumer('pane-global', 'local::background-session', {
      onPermissionReplied: consumerRepliedMock,
    })
    autoApproveStoreMock.fullAutoMode = 'global'
    autoApproveStoreMock.approvePendingOnFullAuto = true
    getPendingPermissionsMock.mockResolvedValue([
      {
        id: 'perm-global',
        sessionID: 'background-session',
        permission: 'bash',
        patterns: ['npm test'],
      },
    ])
    activeSessionStoreMock.getSessionMeta.mockReturnValue({ title: 'Background', directory: '/workspace' })

    renderHook(() => useGlobalEvents(dirsFor(['/workspace'])))

    await waitFor(() => {
      expect(replyPermissionMock).toHaveBeenCalledWith(
        'perm-global',
        'once',
        undefined,
        '/workspace',
        'background-session',
        'local',
      )
    })
    expect(autoApproveStoreMock.claimAutoReply).toHaveBeenCalledWith('perm-global')
    await waitFor(() => {
      expect(consumerRepliedMock).toHaveBeenCalledWith({
        sessionID: 'local::background-session',
        requestID: 'perm-global',
      })
    })
    expect(activeSessionStoreMock.resolvePendingRequest).toHaveBeenCalledWith('perm-global')

    unregister()
  })

  it('broadcasts permission replied events to consumers even when the current session does not match', async () => {
    const consumerRepliedMock = vi.fn()
    const unregister = registerSessionConsumer('pane-mismatch', 'local::other-session', {
      onPermissionReplied: consumerRepliedMock,
    })
    autoApproveStoreMock.fullAutoMode = 'global'
    autoApproveStoreMock.approvePendingOnFullAuto = true
    getPendingPermissionsMock.mockResolvedValue([
      {
        id: 'perm-mismatch',
        sessionID: 'background-session',
        permission: 'bash',
        patterns: ['npm test'],
      },
    ])
    activeSessionStoreMock.getSessionMeta.mockReturnValue({ title: 'Background', directory: '/workspace' })

    renderHook(() => useGlobalEvents(dirsFor(['/workspace'])))

    await waitFor(() => {
      expect(replyPermissionMock).toHaveBeenCalledWith(
        'perm-mismatch',
        'once',
        undefined,
        '/workspace',
        'background-session',
        'local',
      )
    })
    await waitFor(() => {
      expect(consumerRepliedMock).toHaveBeenCalledWith({
        sessionID: 'local::background-session',
        requestID: 'perm-mismatch',
      })
    })

    unregister()
  })

  it('does not approve already waiting permissions when the pending sweep is disabled', async () => {
    autoApproveStoreMock.fullAutoMode = 'global'
    autoApproveStoreMock.approvePendingOnFullAuto = false
    getPendingPermissionsMock.mockResolvedValue([
      {
        id: 'perm-global',
        sessionID: 'background-session',
        permission: 'bash',
        patterns: ['npm test'],
      },
    ])

    renderHook(() => useGlobalEvents(dirsFor(['/workspace'])))

    await waitFor(() => expect(getPendingPermissionsMock).toHaveBeenCalled())
    expect(replyPermissionMock).not.toHaveBeenCalled()
  })

  it('still plays current-session sound for the directly focused session', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::child-session')

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-2',
      sessionID: 'child-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).toHaveBeenCalledWith('permission')
  })

  it('still plays current-session sound when the matching system notification toggle is disabled', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::child-session')
    isSystemEnabledMock.mockImplementation(type => type !== 'permission')

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-sound',
      sessionID: 'child-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).toHaveBeenCalledWith('permission')
  })

  it('does not play permission sound for a session full-auto pane', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::child-session')
    autoApproveStoreMock.getPaneFullAutoMode.mockImplementation(paneId => (paneId === 'test-pane' ? 'session' : 'off'))
    const unregister = registerSessionConsumer('test-pane', 'local::child-session', {})

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-session-auto',
      sessionID: 'child-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).not.toHaveBeenCalled()

    unregister()
  })

  it('does not play permission sound for a child session of a session full-auto pane', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    childBelongsToSessionMock.mockImplementation((sessionId, rootSessionId) => {
      return sessionId === 'local::child-session' && rootSessionId === 'local::parent-session'
    })
    getFocusedSessionIdMock.mockReturnValue('local::child-session')
    autoApproveStoreMock.getPaneFullAutoMode.mockImplementation(paneId => (paneId === 'test-pane' ? 'session' : 'off'))
    const unregister = registerSessionConsumer('test-pane', 'local::parent-session', {})

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-child-session-auto',
      sessionID: 'child-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).not.toHaveBeenCalled()

    unregister()
  })

  it('still plays permission sound for another pane without session full auto', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::other-session')
    autoApproveStoreMock.getPaneFullAutoMode.mockImplementation(paneId => (paneId === 'auto-pane' ? 'session' : 'off'))
    const unregisterAutoPane = registerSessionConsumer('auto-pane', 'local::auto-session', {})
    const unregisterOtherPane = registerSessionConsumer('other-pane', 'local::other-session', {})

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())

    callbacks!.onPermissionAsked?.({
      id: 'perm-other-pane',
      sessionID: 'other-session',
      permission: 'bash',
      patterns: [],
    })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(playNotificationSoundDedupedMock).toHaveBeenCalledWith('permission')

    unregisterAutoPane()
    unregisterOtherPane()
  })

  it.each([
    {
      disabledType: 'permission',
      trigger: 'onPermissionAsked',
      payload: { id: 'perm-3', sessionID: 'background-session', permission: 'bash', patterns: [] },
    },
    {
      disabledType: 'question',
      trigger: 'onQuestionAsked',
      payload: {
        id: 'question-3',
        sessionID: 'background-session',
        questions: [{ header: 'Need input' }],
      },
    },
    {
      disabledType: 'completed',
      trigger: 'onSessionStatus',
      beforeTrigger: () => {
        activeSessionStoreMock.getSnapshot.mockReturnValue({
          statusMap: { 'local::background-session': { type: 'busy' } },
        })
      },
      payload: { sessionID: 'background-session', status: { type: 'idle' } },
    },
    {
      disabledType: 'error',
      trigger: 'onSessionError',
      payload: { sessionID: 'background-session', name: 'Error' },
    },
  ])(
    'keeps background notifications working when the $disabledType system notification toggle is disabled',
    async ({ disabledType, trigger, payload, beforeTrigger }) => {
      let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
      subscribeToEventsMock.mockImplementation(cb => {
        callbacks = cb
        return vi.fn()
      })
      isSystemEnabledMock.mockImplementation(type => type !== disabledType)
      beforeTrigger?.()

      renderHook(() => useGlobalEvents())

      await waitFor(() => expect(callbacks).toBeDefined())

      callbacks![trigger as keyof typeof callbacks]?.(payload as never)

      expect(notificationPushMock).toHaveBeenCalledTimes(1)
      expect(playNotificationSoundDedupedMock).not.toHaveBeenCalled()
    },
  )

  it('does not push completed notification for a child session', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionInfoMock.mockReturnValue({ id: 'local::child-session', parentID: 'local::parent' })
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::child-session': { type: 'busy' } } })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionStatus?.({ sessionID: 'child-session', status: { type: 'idle' } })

    expect(notificationPushMock).not.toHaveBeenCalled()
  })

  it('does not push error notification for a child session', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionInfoMock.mockReturnValue({ id: 'local::child-session', parentID: 'local::parent' })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionError?.({ sessionID: 'child-session', name: 'Error', data: {} })

    expect(notificationPushMock).not.toHaveBeenCalled()
  })

  it('syncs child session status to idle on session.status', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionInfoMock.mockReturnValue({ id: 'local::child-session', parentID: 'local::parent' })
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::child-session': { type: 'busy' } } })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionStatus?.({ sessionID: 'child-session', status: { type: 'idle' } })

    expect(markIdleMock).toHaveBeenCalledWith('local::child-session')
  })

  it('settles an idle session from session.idle even without session.status', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::bg': { type: 'busy' } } })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionIdle?.({ sessionID: 'bg' })

    expect(activeSessionStoreMock.updateStatus).toHaveBeenCalledWith('local::bg', { type: 'idle' })
  })

  it('does not double-fire completed when session.idle precedes session.status idle', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::bg': { type: 'busy' } } })
    activeSessionStoreMock.updateStatus.mockImplementationOnce(() => true).mockImplementationOnce(() => false)

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionIdle?.({ sessionID: 'bg' })
    callbacks!.onSessionStatus?.({ sessionID: 'bg', status: { type: 'idle' } })

    expect(notificationPushMock).toHaveBeenCalledTimes(1)
  })

  it('marks notifications read when the completed session is currently focused', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::background-session')
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::background-session': { type: 'busy' } } })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionStatus?.({ sessionID: 'background-session', status: { type: 'idle' } })

    expect(markSessionNotificationsReadMock).toHaveBeenCalledWith('local::background-session', 'completed')
    expect(notificationPushMock).not.toHaveBeenCalled()
  })

  it('treats another server prefix of the focused session as already open', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getFocusedSessionIdMock.mockReturnValue('local::ses_shared')
    activeSessionStoreMock.getSnapshot.mockReturnValue({ statusMap: { 'local::ses_shared': { type: 'busy' } } })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionStatus?.({ sessionID: 'ses_shared', status: { type: 'idle' } })

    expect(notificationPushMock).not.toHaveBeenCalled()
    expect(markSessionNotificationsReadMock).toHaveBeenCalledWith('local::ses_shared', 'completed')
  })

  it('removes notifications when a session is deleted', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })
    getSessionAndDescendantsMock.mockReturnValue(['local::deleted-session', 'local::child-session'])

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionDeleted?.('deleted-session')

    expect(removeSessionNotificationsMock).toHaveBeenCalledWith('local::deleted-session')
    expect(removeSessionNotificationsMock).toHaveBeenCalledWith('local::child-session')
  })

  it('removes notifications when a session is archived', async () => {
    let callbacks: Parameters<typeof subscribeToEventsMock>[0] | undefined
    subscribeToEventsMock.mockImplementation(cb => {
      callbacks = cb
      return vi.fn()
    })

    renderHook(() => useGlobalEvents())

    await waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onSessionUpdated?.({ id: 'archived-session', time: { archived: 123 } } as never)

    expect(removeSessionNotificationsMock).toHaveBeenCalledWith('local::archived-session')
  })
})

describe('seq 缺口批量处理（节流）', () => {
  it('同一窗口内的多个缺口只触发一次批量处理，且按会话去重', async () => {
    /**
     * 一次断连/背压恢复后，同一台服务器上可能有多个会话同时报缺口。
     * 逐个立即重拉会在隧道上打出并发风暴（实测经网关单次往返约 1.1s）。
     */
    vi.useFakeTimers()
    try {
      const { messageStore } = await import('../store')
      renderHook(() => useGlobalEvents())

      const handler = [...seqGapHandlers][0]
      expect(handler).toBeDefined()

      ackSeqGapMock.mockClear()
      ;(messageStore.markSessionStale as ReturnType<typeof vi.fn>).mockClear()

      // 三个会话同时报缺口（其中 ses_a 报两次，应去重）
      handler!('local', 'ses_a')
      handler!('local', 'ses_b')
      handler!('local', 'ses_a')
      handler!('local', 'ses_c')

      // 窗口内还没处理
      expect(ackSeqGapMock).not.toHaveBeenCalled()

      vi.advanceTimersByTime(400)

      // 三个会话各 ack 一次（去重后）
      expect(ackSeqGapMock).toHaveBeenCalledTimes(3)
      const acked = ackSeqGapMock.mock.calls.map(c => c[1]).sort()
      expect(acked).toEqual(['ses_a', 'ses_b', 'ses_c'])
      expect(messageStore.markSessionStale).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载时清掉挂起的批量任务，不再回调已卸载的 consumer', async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = renderHook(() => useGlobalEvents())
      const handler = [...seqGapHandlers][0]
      expect(handler).toBeDefined()

      ackSeqGapMock.mockClear()
      handler!('local', 'ses_x')
      // 还没到窗口就卸载
      unmount()
      vi.advanceTimersByTime(400)

      expect(ackSeqGapMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
