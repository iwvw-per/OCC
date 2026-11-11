// A1：getSessions 列表成功返回后，后台预热「轮次骨架」能力探测。
//
// 动机：探测不挑会话（limit=1 + 掐断 body），列表是「这台主机第一个会话大概率
// 会被打开」的前置信号。趁热探一次，首屏 loadSession 就能命中内存缓存、
// 不再为探测多等一个隧道往返。
//
// 只测「预热触发逻辑」：peek/probe 换成 spy，探测不发真实网络。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from './types'

const { nativeListSessionsMock, peekLightweightMock, probeLightweightMock } = vi.hoisted(() => ({
  nativeListSessionsMock: vi.fn(),
  peekLightweightMock: vi.fn(),
  probeLightweightMock: vi.fn(async () => true),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'srv',
  },
}))

vi.mock('./v2NativeSession', () => ({
  nativeListSessions: nativeListSessionsMock,
  nativeGetSession: vi.fn(),
  nativeCreateSession: vi.fn(),
  nativeUpdateSession: vi.fn(),
  nativeRemoveSession: vi.fn(),
  nativeInterruptSession: vi.fn(),
  nativeRevertMessage: vi.fn(),
  nativeUnrevertSession: vi.fn(),
  nativeForkSession: vi.fn(),
  nativeCompactSession: vi.fn(),
  nativeListChildSessions: vi.fn(),
  nativeActiveSessions: vi.fn(),
}))

vi.mock('./sdkV2', () => ({ getV2Client: () => ({}) }))
vi.mock('./sessionListCache', () => ({
  readSessionListCache: () => undefined,
  writeSessionListCache: () => {},
  invalidateSessionListCache: () => {},
  dedupeSessionListRequest: async (_s: string, _q: unknown, factory: () => Promise<ApiSession[]>) => factory(),
}))
vi.mock('../utils/ephemeralSessions', () => ({ isEphemeralSession: () => false }))
vi.mock('./sanitize', () => ({ stripSessionListDetails: (session: ApiSession) => session }))
vi.mock('./message', () => ({
  peekLightweightSupport: (...args: unknown[]) => peekLightweightMock(...(args as [])),
  probeLightweightSupport: (...args: unknown[]) => probeLightweightMock(...(args as [])),
  // session.ts 还从 './message' 拉 getSessionMessages（本测试不触发该路径）
  getSessionMessages: vi.fn(),
}))

import { getSessions } from './session'

function session(id: string): ApiSession {
  return { id, time: { created: 0, updated: 0 } } as ApiSession
}

describe('getSessions lightweight-probe prefetch (A1)', () => {
  beforeEach(() => {
    nativeListSessionsMock.mockReset()
    peekLightweightMock.mockReset()
    probeLightweightMock.mockReset()
    probeLightweightMock.mockResolvedValue(true)
  })

  it('prefetches the skeleton probe with the first session after a real list fetch', async () => {
    peekLightweightMock.mockReturnValue(undefined)
    nativeListSessionsMock.mockResolvedValue({ sessions: [session('ses-1'), session('ses-2')] })

    await getSessions({ directory: '/repo' }, 'srv')

    // 预热只认「该服务器能力尚未确认」；用列表首个可见会话探测
    expect(peekLightweightMock).toHaveBeenCalledWith('srv')
    expect(probeLightweightMock).toHaveBeenCalledWith('ses-1', undefined, 'srv')
  })

  it('skips the probe when the server capability is already known', async () => {
    peekLightweightMock.mockReturnValue(true)
    nativeListSessionsMock.mockResolvedValue({ sessions: [session('ses-1')] })

    await getSessions({ directory: '/repo' }, 'srv')

    expect(probeLightweightMock).not.toHaveBeenCalled()
  })
})