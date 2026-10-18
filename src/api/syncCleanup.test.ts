import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = { domain: 'https://panel.example.com', username: 'u', token: 'tok', loginAt: 0 }

vi.mock('./aiagent', () => ({
  readAccount: () => ACCOUNT,
  accountRequest: vi.fn(),
}))

describe('cleanupDeprecatedSyncKeys', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('deletes deprecated keys once and records the marker', async () => {
    const { accountRequest } = await import('./aiagent')
    vi.mocked(accountRequest).mockResolvedValue({ removed: [] })
    const { cleanupDeprecatedSyncKeys } = await import('./syncCleanup')

    await cleanupDeprecatedSyncKeys()

    expect(vi.mocked(accountRequest)).toHaveBeenCalled()
    const [account, path, init] = vi.mocked(accountRequest).mock.calls[0] as [
      unknown,
      string,
      RequestInit,
    ]
    expect(account).toMatchObject({ domain: ACCOUNT.domain })
    expect(path).toBe('/api/aiagent/preferences')
    expect(init.method).toBe('DELETE')
    const keys = JSON.parse(String(init.body)).keys as string[]
    // 只删服务端的：本地键仍然生效，因此这里不应触碰 localStorage
    expect(keys).toContain('font-scale')
    expect(keys).toContain('theme-custom-css')
    expect(localStorage.getItem('font-scale')).toBeNull()

    expect(localStorage.getItem('opencode-sync-cleanup-deprecated-v1')).toBe('1')
  })

  it('does nothing on subsequent runs', async () => {
    const { accountRequest } = await import('./aiagent')
    vi.mocked(accountRequest).mockResolvedValue({ removed: [] })
    const { cleanupDeprecatedSyncKeys } = await import('./syncCleanup')

    await cleanupDeprecatedSyncKeys()
    vi.mocked(accountRequest).mockClear()
    const second = await cleanupDeprecatedSyncKeys()

    expect(second).toBe(0)
    expect(vi.mocked(accountRequest)).not.toHaveBeenCalled()
  })

  it('never exceeds the per-request key limit', async () => {
    const { accountRequest } = await import('./aiagent')
    vi.mocked(accountRequest).mockResolvedValue({ removed: [] })
    const { cleanupDeprecatedSyncKeys } = await import('./syncCleanup')
    const { DEPRECATED_SYNCABLE_KEYS } = await import('./preferencesSync')

    await cleanupDeprecatedSyncKeys()

    const sizes = vi
      .mocked(accountRequest)
      .mock.calls.map(call => JSON.parse(String((call[2] as RequestInit).body)).keys.length)
    // 每批不超过上限，且所有废弃键都被覆盖
    expect(Math.max(...sizes)).toBeLessThanOrEqual(32)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(DEPRECATED_SYNCABLE_KEYS.length)
  })
})
