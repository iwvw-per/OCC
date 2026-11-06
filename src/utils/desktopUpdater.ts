// ============================================
// 桌面端自更新（tauri-plugin-updater 的 Rust 侧能力，经自定义命令调用）
//
// 与 updateStore 的分工：
//   - updateStore：查 GitHub Releases，判定「有没有新版本」，跨平台通用（含 Android）。
//   - 这里：在桌面客户端上真正执行下载 + 安装 + 重启，一端完成。
//
// 为什么不用 @tauri-apps/plugin-updater 的 JS `check()`：它只能读取
// tauri.conf.json 里静态配置的 endpoints，无法按通道切换。canary 的更新清单
// 在各自 release tag 下，静态 endpoint（releases/latest）永远解析不到。
// 因此改调自定义命令 `updater_install`，把目标清单 URL 动态传给 Rust 侧。
//
// 命令只在桌面平台注册（见 src-tauri/src/app/mod.rs 与 capabilities），
// 移动端调用会失败，因此所有入口都先过 isDesktopUpdaterAvailable()。
// ============================================

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri, isTauriMobile } from './tauri'
import i18n from '../i18n'

export type UpdaterPhase = 'idle' | 'checking' | 'downloading' | 'installing' | 'ready' | 'error'

export interface UpdaterProgress {
  phase: UpdaterPhase
  /** 已下载字节，仅在 downloading 阶段有意义 */
  downloadedBytes: number
  /** 总字节，服务端未提供 Content-Length 时为 null */
  totalBytes: number | null
  error: string | null
}

type Listener = (progress: UpdaterProgress) => void

const INITIAL_PROGRESS: UpdaterProgress = {
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
}

/** 下载清单请求超时：5 分钟，足以覆盖慢网络下几十 MB 的安装包 */
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000

interface UpdaterDownloadEvent {
  event: 'Started' | 'Progress' | 'Finished'
  data?: { contentLength?: number; chunkLength?: number }
}

interface UpdaterInstallResult {
  installedVersion: string | null
}

/**
 * 桌面端是否支持应用内自更新。
 *
 * tauri-plugin-updater 仅覆盖 Windows/macOS/Linux；Android 上该插件未注册，
 * 只能引导用户去 Releases 下载 APK。
 */
export function isDesktopUpdaterAvailable(): boolean {
  return isTauri() && !isTauriMobile()
}

export class DesktopUpdater {
  private progress: UpdaterProgress = INITIAL_PROGRESS
  private listeners = new Set<Listener>()
  private running: Promise<boolean> | null = null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): UpdaterProgress => this.progress

  private setProgress(next: Partial<UpdaterProgress>): void {
    this.progress = { ...this.progress, ...next }
    this.listeners.forEach(listener => listener(this.progress))
  }

  /**
   * 按指定清单 URL 下载并安装更新。
   *
   * @param manifestUrl release 的 latest.json 地址（见 updateStore.getReleaseManifestUrl）；
   *                    不传则回退到 tauri.conf.json 配置的静态 endpoints（稳定通道）。
   *
   * 返回是否**真的装好了**：
   *   - true  ：安装完成（Windows 安装器已启动；macOS/Linux 字节已就位，需 relaunchApp）
   *   - false ：清单版本不高于当前版本（无更新可装），或安装过程中出错
   *
   * 返回布尔而不是让调用方去读 phase：phase 是给 UI 展示的全局状态，
   * 自动更新流程要的是「这次安装到底成不成」，两者语义不同。
   */
  async installLatest(manifestUrl?: string): Promise<boolean> {
    // 已有安装在跑：等它结束并复用它「到底装成了没有」的结论。
    // 不能读 phase 代替 —— phase 是给 UI 的全局状态，安装失败也会停在 error，
    // 而并发调用方关心的是「这次能不能算装好」。
    if (this.running) return this.running

    this.running = (async () => {
      try {
        this.setProgress({ phase: 'checking', downloadedBytes: 0, totalBytes: null, error: null })

        // 未指定清单时（异常兜底路径）仍走自定义命令，让 Rust 使用静态 endpoints。
        const channel = new Channel<UpdaterDownloadEvent>()
        let total: number | null = null
        let downloaded = 0
        channel.onmessage = event => {
          if (event.event === 'Started') {
            total = event.data?.contentLength ?? null
            this.setProgress({ phase: 'downloading', downloadedBytes: 0, totalBytes: total })
            return
          }
          if (event.event === 'Progress') {
            downloaded += event.data?.chunkLength ?? 0
            this.setProgress({ phase: 'downloading', downloadedBytes: downloaded, totalBytes: total })
            return
          }
          this.setProgress({ phase: 'installing' })
        }

        const result = await invoke<UpdaterInstallResult>('updater_install', {
          manifestUrl: manifestUrl ?? null,
          onEvent: channel,
          options: { timeout: UPSTREAM_TIMEOUT_MS },
        })

        if (!result.installedVersion) {
          this.setProgress({ phase: 'idle' })
          return false
        }

        this.setProgress({ phase: 'ready' })
        return true
      } catch (error) {
        this.setProgress({
          phase: 'error',
          error: error instanceof Error ? error.message : i18n.t('settings:about.updateFailed'),
        })
        return false
      } finally {
        this.running = null
      }
    })()

    return this.running
  }

  /** macOS / Linux 安装完成后重启到新版本；Windows 由安装器接管，无需调用。 */
  async relaunchApp(): Promise<void> {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  }

  reset(): void {
    this.setProgress({ ...INITIAL_PROGRESS })
  }
}

export const desktopUpdater = new DesktopUpdater()
