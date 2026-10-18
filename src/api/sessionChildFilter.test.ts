// v2 session.list 会把子代理会话（parentID）一并返回；getSessions 必须把它们从
// 列表里剔除，否则子对话泄漏进侧栏。roots===false（归档全量）时保留。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from './types'

const { nativeListSessionsMock } = vi.hoisted(() => ({
  nativeListSessionsMock: vi.fn(),
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

import { getSessions } from './session'

function session(id: string, parentID?: string): ApiSession {
  return { id, parentID, time: { created: 0, updated: 0 } } as ApiSession
}

describe('getSessions child-session filtering', () => {
  beforeEach(() => {
    nativeListSessionsMock.mockReset()
  })

  it('drops child sessions for the default roots list', async () => {
    nativeListSessionsMock.mockResolvedValue({ sessions: [session('root'), session('child', 'root')] })

    const result = await getSessions({ directory: '/repo', roots: true }, 'srv')

    expect(result.map(item => item.id)).toEqual(['root'])
  })

  it('drops child sessions even when roots is omitted (default roots list)', async () => {
    nativeListSessionsMock.mockResolvedValue({ sessions: [session('root'), session('child', 'root')] })

    const result = await getSessions({ directory: '/repo' }, 'srv')

    expect(result.map(item => item.id)).toEqual(['root'])
  })

  it('keeps child sessions when roots is explicitly false (archived full list)', async () => {
    nativeListSessionsMock.mockResolvedValue({ sessions: [session('root'), session('child', 'root')] })

    const result = await getSessions({ directory: '/repo', roots: false, includeArchived: true }, 'srv')

    expect(result.map(item => item.id)).toEqual(['root', 'child'])
  })
})
