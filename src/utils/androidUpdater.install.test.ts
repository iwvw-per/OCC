/**
 * Android 一键更新：安装阶段的桥调用。
 *
 * 回归（用户反馈「安卓无法一键更新」）：
 * 旧实现下载完 APK 后调用 `@tauri-apps/plugin-opener` 的 `openPath()`，
 * 而该插件的 **Android 实现只注册了 `open` 命令，没有 `open_path`**
 * （见插件仓库 plugins/opener/android/src/main/java/OpenerPlugin.kt，
 * 全文只有 `@Command fun open`）。因此 `invoke('plugin:opener|open_path')`
 * 在安卓上必然失败：APK 明明下载完成，界面却停在「下载完成」或直接报错，
 * 系统安装界面永远不会出现。
 *
 * 现在改为调用 MainActivity 暴露的原生桥 `__opencode_android_apk`：
 * FileProvider 生成 content:// URI → ACTION_VIEW(package-archive)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateRelease } from '../store/updateStore'

const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null
  },
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
}))

const release: UpdateRelease = {
  version: '2.0.53',
  tagName: 'v2.0.53',
  url: 'https://github.com/iwvw-per/OCC/releases/tag/v2.0.53',
  publishedAt: null,
  name: 'v2.0.53',
  prerelease: false,
}

interface Bridge {
  canRequestInstall: () => boolean
  openInstallPermissionSettings: () => boolean
  install: (fileName: string) => string | null
}

function installBridge(bridge: Bridge) {
  ;(window as unknown as { __opencode_android_apk?: Bridge }).__opencode_android_apk = bridge
}

describe('androidUpdater 安装阶段', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string, args?: { fileName?: string }) => {
      if (command === 'device_target_arch') return 'aarch64'
      if (command === 'android_download_apk') {
        // 模拟 Rust 侧：把 APK 写到 cacheDir/updates/<传入的 fileName>，返回绝对路径
        return { path: `/data/user/0/com.opencodeui.occ/cache/updates/${args?.fileName}` }
      }
      throw new Error(`unexpected command: ${command}`)
    })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)' })
  })

  afterEach(() => {
    delete (window as unknown as { __opencode_android_apk?: Bridge }).__opencode_android_apk
    vi.unstubAllGlobals()
  })

  it('下载完成后调用原生桥按文件名安装（不是 openPath）', async () => {
    const install = vi.fn(() => null)
    installBridge({ canRequestInstall: () => true, openInstallPermissionSettings: () => true, install })

    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)

    expect(install).toHaveBeenCalledTimes(1)
    // 只传文件名：桥内部拼 cacheDir/updates，避免通过 JS 桥传递任意路径
    // 文件名与下载资产一致（含架构），便于事后判断装的是哪个包
    expect(install).toHaveBeenCalledWith('OCC-v2.0.53-android-arm64.apk')
    expect(updater.getSnapshot().phase).toBe('installing')
    expect(updater.getSnapshot().error).toBeNull()
  })

  /**
   * 回归（用户反馈）：「首次授权后不应该弹无权限报错」。
   *
   * 旧实现下载完发现没权限，先跳设置页、再 `throw` —— 用户授权返回后看到的是
   * 「更新失败：需要允许安装未知应用」，明明已经授权了。
   * 正确行为：进入 awaitingPermission（不是 error），原生侧挂起这次安装，
   * 用户返回后自动续装。
   */
  it('没有「安装未知应用」权限时进入等待授权状态，而不是报错', async () => {
    const install = vi.fn(() => null)
    const openInstallPermissionSettings = vi.fn(() => true)
    installBridge({ canRequestInstall: () => false, openInstallPermissionSettings, install })

    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)

    expect(openInstallPermissionSettings).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
    expect(updater.getSnapshot().phase).toBe('awaitingPermission')
    expect(updater.getSnapshot().error).toBeNull()
  })

  it('授权返回后（回前台）自动推进到安装中，且不产生错误', async () => {
    let granted = false
    installBridge({
      canRequestInstall: () => granted,
      openInstallPermissionSettings: () => true,
      install: () => null,
    })

    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)
    expect(updater.getSnapshot().phase).toBe('awaitingPermission')

    // 用户在系统设置里点了允许，然后回到应用
    granted = true
    updater.syncAfterResume()

    expect(updater.getSnapshot().phase).toBe('installing')
    expect(updater.getSnapshot().error).toBeNull()
  })

  it('授权前回到前台保持等待，不误报也不误推进', async () => {
    installBridge({
      canRequestInstall: () => false,
      openInstallPermissionSettings: () => true,
      install: () => null,
    })

    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)

    updater.syncAfterResume()
    expect(updater.getSnapshot().phase).toBe('awaitingPermission')
    expect(updater.getSnapshot().error).toBeNull()
  })

  it('桥返回错误时把原因带到界面上，而不是静默失败', async () => {
    installBridge({
      canRequestInstall: () => true,
      openInstallPermissionSettings: () => true,
      install: () => 'installer file missing',
    })

    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)

    expect(updater.getSnapshot().phase).toBe('error')
    expect(updater.getSnapshot().error).toBe('installer file missing')
  })

  it('老版本客户端没有该桥时给出可操作的提示', async () => {
    // 不注入 __opencode_android_apk
    const { AndroidUpdater } = await import('./androidUpdater')
    const updater = new AndroidUpdater()
    await updater.installLatest(release)

    expect(updater.getSnapshot().phase).toBe('error')
    expect(updater.getSnapshot().error).not.toBeNull()
  })
})
