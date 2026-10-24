// ============================================
// androidUpdater — Android 端一键更新
//
// 桌面端的自更新走 tauri-plugin-updater（Rust 侧下载 + 安装 + 重启），
// 但该插件**不支持 Android**（capabilities/updater.json 也按平台限定排除了它）。
//
// Android 的正确路径只有一条：下载 APK → 交给系统安装器。
// 系统安装器负责签名校验、用户确认与覆盖安装，应用自己不能静默安装。
//
// 因此这里做三件事：
//   1. 从 release 资产里挑出**与当前 CPU 架构匹配**的 APK；
//   2. 下载到应用缓存目录（带进度）；
//   3. 用 opener 打开该文件，触发系统安装界面。
//
// 为什么按架构挑：release 同时提供 arm64 与 armv7 两个包，装错架构的包
// 要么装不上，要么在 32 位设备上跑不起来。用 Rust 侧的 `target_arch`
// 判定，比在前端猜 `navigator.userAgent` 可靠。
// ============================================

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri'
import i18n from '../i18n'
import type { UpdateRelease } from '../store/updateStore'
import { RELEASE_REPO } from '../store/updateStore'

export type AndroidUpdatePhase =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'error'

export interface AndroidUpdateProgress {
  phase: AndroidUpdatePhase
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
}

type Listener = (progress: AndroidUpdateProgress) => void

const INITIAL_PROGRESS: AndroidUpdateProgress = {
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
}

/** 下载超时：5 分钟，与桌面端一致（APK 约 30MB，慢网下也够） */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Android 端是否支持应用内一键更新。
 *
 * 仅 Tauri Android 客户端支持：浏览器版没有下载/打开本地文件的权限，
 * iOS 未分发（且同样不支持安装外部 IPA）。
 */
export function isAndroidUpdaterAvailable(): boolean {
  return isTauri() && isAndroidPlatform()
}

function isAndroidPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android/i.test(navigator.userAgent)
}

/** 当前设备需要的 APK 架构后缀（arm64 / armv7） */
async function resolveApkArch(): Promise<'arm64' | 'armv7'> {
  try {
    const arch = await invoke<string>('device_target_arch')
    // aarch64 → arm64；armv7 / arm → armv7
    if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
    return 'armv7'
  } catch {
    // 取不到架构时按 arm64 兜底：现代 Android 设备绝大多数是 64 位，
    // 且 64 位包在 64 位设备上是唯一可装的那个。
    return 'arm64'
  }
}

/**
 * 从 release 里挑出匹配当前架构的 APK 下载地址。
 *
 * 资产命名规则见 .github/workflows/release.yml：
 *   OCC-${tag}-android-${label}.apk     （label = arm64 | armv7）
 */
export function pickApkUrl(release: UpdateRelease, arch: 'arm64' | 'armv7'): string | null {
  const tag = release.tagName
  if (!tag) return null
  const fileName = `OCC-${tag}-android-${arch}.apk`
  return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${fileName}`
}

interface DownloadEvent {
  event: 'Started' | 'Progress' | 'Finished'
  data?: { contentLength?: number; chunkLength?: number }
}

interface AndroidDownloadResult {
  path: string
}

export class AndroidUpdater {
  private progress: AndroidUpdateProgress = INITIAL_PROGRESS
  private listeners = new Set<Listener>()
  private running: Promise<void> | null = null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AndroidUpdateProgress => this.progress

  private setProgress(next: Partial<AndroidUpdateProgress>): void {
    this.progress = { ...this.progress, ...next }
    this.listeners.forEach(listener => listener(this.progress))
  }

  /**
   * 下载并触发安装。
   *
   * 完成后 phase 为 'installing'：系统安装界面已经弹出，后续由用户确认。
   * 应用本身不会重启，安装完成后系统会提示「打开」。
   */
  async installLatest(release: UpdateRelease): Promise<void> {
    if (this.running) return this.running

    this.running = (async () => {
      try {
        const arch = await resolveApkArch()
        const url = pickApkUrl(release, arch)
        if (!url) {
          throw new Error(i18n.t('settings:about.androidNoApk'))
        }

        this.setProgress({ phase: 'downloading', downloadedBytes: 0, totalBytes: null, error: null })

        const { Channel } = await import('@tauri-apps/api/core')
        const channel = new Channel<DownloadEvent>()
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

        const result = await invoke<AndroidDownloadResult>('android_download_apk', {
          url,
          fileName: `OCC-${release.tagName}.apk`,
          onEvent: channel,
          options: { timeout: DOWNLOAD_TIMEOUT_MS },
        })

        this.setProgress({ phase: 'installing' })

        // 交给系统安装器：打开 APK 文件会触发「是否安装」的确认界面。
        // 用 opener 插件的 openPath —— 它对 file:// 路径会走系统 Intent。
        const { openPath } = await import('@tauri-apps/plugin-opener')
        await openPath(result.path)
      } catch (error) {
        this.setProgress({
          phase: 'error',
          error: error instanceof Error ? error.message : i18n.t('settings:about.updateFailed'),
        })
      } finally {
        this.running = null
      }
    })()

    return this.running
  }

  reset(): void {
    this.setProgress({ ...INITIAL_PROGRESS })
  }
}

export const androidUpdater = new AndroidUpdater()
