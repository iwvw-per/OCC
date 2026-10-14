import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UpdateStore,
  compareVersions,
  getReleaseManifestUrl,
  hasUpdateAvailable,
  isPrereleaseVersion,
  shouldShowUpdateToast,
} from './updateStore'

describe('updateStore helpers', () => {
  it('compares versions with optional v prefix', () => {
    expect(compareVersions('v0.5.2', '0.5.1')).toBeGreaterThan(0)
    expect(compareVersions('0.5.1', 'v0.5.1')).toBe(0)
    expect(compareVersions('0.5', '0.5.1')).toBeLessThan(0)
  })

  it('compares prerelease versions with semver semantics', () => {
    // canary 之间：序号大者更新
    expect(compareVersions('0.6.125-canary.2', '0.6.125-canary.1')).toBeGreaterThan(0)
    expect(compareVersions('0.6.125-canary.10', '0.6.125-canary.9')).toBeGreaterThan(0)
    // 同号正式版 > 预发布
    expect(compareVersions('0.6.125', '0.6.125-canary.2')).toBeGreaterThan(0)
    expect(compareVersions('0.6.125-canary.2', '0.6.125')).toBeLessThan(0)
    // 高号预发布 > 低号正式版
    expect(compareVersions('0.6.125-canary.1', '0.6.124')).toBeGreaterThan(0)
    // 完全相同
    expect(compareVersions('0.6.125-canary.1', 'v0.6.125-canary.1')).toBe(0)
  })

  it('detects the update channel from the running version', () => {
    expect(isPrereleaseVersion('0.6.125-canary.1')).toBe(true)
    expect(isPrereleaseVersion('v0.6.125-beta.2')).toBe(true)
    expect(isPrereleaseVersion('0.6.125')).toBe(false)
  })

  it('builds the per-release manifest url', () => {
    expect(
      getReleaseManifestUrl({
        version: '0.6.125-canary.1',
        tagName: 'v0.6.125-canary.1',
        url: 'https://example.com',
        publishedAt: null,
        name: null,
      }),
    ).toBe('https://github.com/iwvw-per/OpenCodeUI/releases/download/v0.6.125-canary.1/latest.json')
  })

  it('detects whether an update toast should be shown', () => {
    const baseState = {
      currentVersion: '0.5.1',
      currentChannel: 'stable' as const,
      latestRelease: {
        version: '0.5.2',
        tagName: 'v0.5.2',
        url: 'https://example.com',
        publishedAt: null,
        name: null,
        prerelease: false,
      },
      lastCheckedAt: Date.now(),
      dismissedVersion: null,
      hiddenToastVersion: null,
      checking: false,
      error: null,
    }

    expect(hasUpdateAvailable(baseState)).toBe(true)
    expect(shouldShowUpdateToast(baseState)).toBe(true)
    expect(shouldShowUpdateToast({ ...baseState, hiddenToastVersion: '0.5.2' })).toBe(false)
    expect(shouldShowUpdateToast({ ...baseState, dismissedVersion: '0.5.2' })).toBe(false)
  })
})

describe('UpdateStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('loads the latest release and persists dismissal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: 'v0.5.2',
          html_url: 'https://github.com/iwvw-per/OpenCodeUI/releases/tag/v0.5.2',
          published_at: '2026-04-15T00:00:00Z',
          name: 'OpenCodeUI v0.5.2',
          prerelease: false,
        }),
      }),
    )

    const store = new UpdateStore('0.5.1')
    await store.checkForUpdates({ force: true })

    expect(store.getSnapshot().latestRelease?.version).toBe('0.5.2')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)

    store.dismissCurrentVersion()

    expect(store.getSnapshot().dismissedVersion).toBe('0.5.2')
    expect(shouldShowUpdateToast(store.getSnapshot())).toBe(false)
    expect(localStorage.getItem('opencode:update-check')).toContain('0.5.2')
  })

  it('stable 通道走列表接口并按主版本过滤（产品线隔离）', async () => {
    // v1 用户（1.0.1）：即使存在更高的 v2.0.0，也只看自己主版本(1.x)的更新。
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v2.0.0', html_url: 'https://example.com/v2', prerelease: false, draft: false },
        { tag_name: 'v1.0.1', html_url: 'https://example.com/v1', prerelease: false, draft: false },
        { tag_name: 'v1.0.2', html_url: 'https://example.com/v1-2', prerelease: false, draft: false },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)

    const store = new UpdateStore('1.0.1')
    await store.checkForUpdates({ force: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/iwvw-per/OpenCodeUI/releases?per_page=20',
      expect.anything(),
    )
    // v2.0.0 语义最大但主版本(2)与当前(1)不同 → 被产品线隔离过滤，选 1.x 最大者
    expect(store.getSnapshot().latestRelease?.version).toBe('1.0.2')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)
  })

  it('v2 用户只在自己主版本内更新，不被 v1 release 干扰', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v2.0.0', html_url: 'https://example.com/v2', prerelease: false, draft: false },
        { tag_name: 'v2.0.1-canary.1', html_url: 'https://example.com/c', prerelease: true, draft: false },
        { tag_name: 'v1.9.9', html_url: 'https://example.com/v1', prerelease: false, draft: false },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)

    const store = new UpdateStore('2.0.0')
    await store.checkForUpdates({ force: true })

    expect(store.getSnapshot().latestRelease?.version).toBe('2.0.0')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(false)
  })

  it('canary 版本走列表接口并取语义最大的 prerelease', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: 'v0.6.125-canary.1',
          html_url: 'https://example.com/canary1',
          prerelease: true,
          draft: false,
        },
        {
          tag_name: 'v0.6.126-canary.0',
          html_url: 'https://example.com/canary0',
          prerelease: true,
          draft: false,
        },
        { tag_name: 'v0.6.124', html_url: 'https://example.com/stable', prerelease: false, draft: false },
        { tag_name: 'v0.6.130-canary.9', html_url: 'https://example.com/draft', prerelease: true, draft: true },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)

    const store = new UpdateStore('0.6.125-canary.1')
    expect(store.getSnapshot().currentChannel).toBe('canary')

    await store.checkForUpdates({ force: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/iwvw-per/OpenCodeUI/releases?per_page=5',
      expect.anything(),
    )
    // draft 被跳过；稳定版 0.6.124 语义低于 0.6.126-canary.0，canary 通道取更大者
    expect(store.getSnapshot().latestRelease?.version).toBe('0.6.126-canary.0')
    expect(store.getSnapshot().latestRelease?.prerelease).toBe(true)
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)
  })

  it('canary 用户能收到更高号的正式版', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { tag_name: 'v0.6.125-canary.3', html_url: 'https://example.com', prerelease: true, draft: false },
          { tag_name: 'v0.6.125', html_url: 'https://example.com', prerelease: false, draft: false },
        ],
      }),
    )

    const store = new UpdateStore('0.6.125-canary.2')
    await store.checkForUpdates({ force: true })

    // 同号正式版语义大于其预发布
    expect(store.getSnapshot().latestRelease?.version).toBe('0.6.125')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)
  })

  it('canary 通道列表里只有更低号的正式版时不报更新', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { tag_name: 'v0.6.124', html_url: 'https://example.com', prerelease: false, draft: false },
        ],
      }),
    )

    const store = new UpdateStore('0.6.126-canary.1')
    await store.checkForUpdates({ force: true })

    // 候选是正式版 0.6.124，但语义低于当前 canary → 无更新、无错误
    expect(store.getSnapshot().latestRelease?.version).toBe('0.6.124')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(false)
    expect(store.getSnapshot().error).toBeNull()
  })
})

describe('importUpdateSettingsBackup', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('updates in-memory state and notifies subscribers', async () => {
    vi.resetModules()
    const { updateStore, importUpdateSettingsBackup, exportUpdateSettingsBackup } = await import('./updateStore')

    let notifications = 0
    const unsubscribe = updateStore.subscribe(() => {
      notifications += 1
    })

    importUpdateSettingsBackup({
      latestRelease: {
        version: '9.9.9',
        tagName: 'v9.9.9',
        url: 'https://example.com/9.9.9',
        publishedAt: null,
        name: null,
      },
      lastCheckedAt: 1700000000000,
      dismissedVersion: '9.9.9',
    })

    expect(updateStore.getSnapshot().latestRelease?.version).toBe('9.9.9')
    expect(updateStore.getSnapshot().lastCheckedAt).toBe(1700000000000)
    expect(updateStore.getSnapshot().dismissedVersion).toBe('9.9.9')
    expect(notifications).toBeGreaterThan(0)
    // 再次导出必须反映导入值，而不是旧内存状态
    expect(exportUpdateSettingsBackup().latestRelease?.version).toBe('9.9.9')

    unsubscribe()
  })
})
