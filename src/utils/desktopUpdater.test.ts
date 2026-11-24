import { afterEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock, isTauriMobileMock, invokeMock, relaunchMock, stageManifestMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  isTauriMobileMock: vi.fn(() => false),
  invokeMock: vi.fn(),
  relaunchMock: vi.fn(),
  stageManifestMock: vi.fn(async (_content: Record<string, unknown>) => 'file:///tmp/manifest.json'),
}))

vi.mock('../utils/tauri', () => ({
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('../utils/manifestStaging', () => ({
  stageRewrittenManifest: (content: Record<string, unknown>) => stageManifestMock(content),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}))

import { DesktopUpdater, isDesktopUpdaterAvailable } from '../utils/desktopUpdater'

describe('isDesktopUpdaterAvailable', () => {
  afterEach(() => {
    isTauriMock.mockReset()
    isTauriMobileMock.mockReset()
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
  })

  it('is available on desktop Tauri only', () => {
    expect(isDesktopUpdaterAvailable()).toBe(true)

    isTauriMobileMock.mockReturnValue(true)
    expect(isDesktopUpdaterAvailable()).toBe(false)

    isTauriMock.mockReturnValue(false)
    isTauriMobileMock.mockReturnValue(false)
    expect(isDesktopUpdaterAvailable()).toBe(false)
  })
})

describe('DesktopUpdater', () => {
  afterEach(() => {
    invokeMock.mockReset()
    relaunchMock.mockReset()
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
  })

  it('returns to idle when the manifest has no newer version', async () => {
    invokeMock.mockResolvedValue({ installedVersion: null })
    const updater = new DesktopUpdater()

    await updater.installLatest('https://example.com/latest.json')

    expect(updater.getSnapshot().phase).toBe('idle')
    expect(updater.getSnapshot().error).toBeNull()
  })

  it('passes the manifest url to the custom command', async () => {
    invokeMock.mockResolvedValue({ installedVersion: '0.6.125-canary.2' })
    const updater = new DesktopUpdater()

    await updater.installLatest('https://example.com/v0.6.125-canary.2/latest.json')

    expect(invokeMock).toHaveBeenCalledWith(
      'updater_install',
      expect.objectContaining({ manifestUrl: 'https://example.com/v0.6.125-canary.2/latest.json' }),
    )
  })

  it('reports download progress and reaches ready', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { onEvent: { onmessage: (event: unknown) => void } }) => {
      args.onEvent.onmessage({ event: 'Started', data: { contentLength: 100 } })
      args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 40 } })
      args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 60 } })
      args.onEvent.onmessage({ event: 'Finished' })
      return { installedVersion: '0.6.125' }
    })

    const updater = new DesktopUpdater()
    const phases: string[] = []
    updater.subscribe(progress => phases.push(progress.phase))

    await updater.installLatest('https://example.com/latest.json')

    const final = updater.getSnapshot()
    expect(final.phase).toBe('ready')
    expect(final.downloadedBytes).toBe(100)
    expect(final.totalBytes).toBe(100)
    expect(phases).toContain('downloading')
    expect(phases).toContain('installing')
  })

  it('captures errors without throwing', async () => {
    invokeMock.mockRejectedValue(new Error('network down'))
    const updater = new DesktopUpdater()

    await updater.installLatest('https://example.com/latest.json')

    expect(updater.getSnapshot().phase).toBe('error')
    expect(updater.getSnapshot().error).toBe('network down')
  })

  it('rewrites the manifest asset urls when the route is a proxy', async () => {
    // 回归：只把清单地址换成代理、不改写 asset，会导致「检查能过、下载必失败」。
    // 走代理时先把清单取回来，把 asset 地址一起改写，再把改写结果交给 Rust。
    const manifest = {
      version: '2.2.18',
      platforms: {
        'windows-x86_64': { url: 'https://github.com/iwvw-per/OCC/releases/download/v2.2.18/a.exe', signature: 's' },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => manifest })),
    )
    invokeMock.mockResolvedValue({ installedVersion: '2.2.18' })

    const updater = new DesktopUpdater()
    // 直接给一条「已走代理」的清单地址
    await updater.installLatest('https://gh-proxy.com/https://github.com/iwvw-per/OCC/releases/download/v2.2.18/latest.json')

    // 交给 Rust 的是本地改写后的清单
    expect(invokeMock).toHaveBeenCalledWith(
      'updater_install',
      expect.objectContaining({ manifestUrl: 'file:///tmp/manifest.json' }),
    )
    expect(stageManifestMock).toHaveBeenCalled()
    const staged = stageManifestMock.mock.calls.at(-1)?.[0] as {
      platforms: Record<string, { url: string }>
    }
    expect(staged.platforms['windows-x86_64'].url.startsWith('https://gh-proxy.com/https://github.com/')).toBe(true)
  })

  it('deduplicates concurrent install requests', async () => {    let resolveInstall: ((value: { installedVersion: string | null }) => void) | undefined
    invokeMock.mockImplementation(
      () =>
        new Promise<{ installedVersion: string | null }>(resolve => {
          resolveInstall = resolve
        }),
    )

    const updater = new DesktopUpdater()
    const first = updater.installLatest('https://example.com/latest.json')
    const second = updater.installLatest('https://example.com/latest.json')

    // 第二次调用必须复用同一个 in-flight promise，不再发起新的命令调用。
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    resolveInstall?.({ installedVersion: '0.6.125' })
    await Promise.all([first, second])
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
