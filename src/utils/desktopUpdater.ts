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
import { stageRewrittenManifest } from './manifestStaging'
import { applyRoute, describeRoute, fetchManifestContent, getRouteChain, rewriteManifestUrls, routeFor } from './updateRoutes'

export type UpdaterPhase = 'idle' | 'checking' | 'downloading' | 'installing' | 'ready' | 'error'

export interface UpdaterProgress {
  phase: UpdaterPhase
  /** 已下载字节，仅在 downloading 阶段有意义 */
  downloadedBytes: number
  /** 总字节，服务端未提供 Content-Length 时为 null */
  totalBytes: number | null
  error: string | null
  /** 当前正在尝试第几条线路（1 起；多线路回退时用于提示「正在换线路」） */
  attempt?: number
  /** 本次安装总共准备了几条线路 */
  attemptCount?: number
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
   * @param manifestUrls 候选清单 URL，按顺序尝试（见 updateStore.getManifestCandidates）：
   *                     第 1 个是线路首选地址，其余为备用线路。任一条成功即返回；
   *                     全部失败时抛错并带上每次失败的原因。空数组 / 不传则回退到
   *                     tauri.conf.json 配置的静态 endpoints（稳定通道）。
   *
   * 返回是否**真的装好了**：
   *   - true  ：安装完成（Windows 安装器已启动；macOS/Linux 字节已就位，需 relaunchApp）
   *   - false ：清单版本不高于当前版本（无更新可装）
   *
   * 返回布尔而不是让调用方去读 phase：phase 是给 UI 展示的全局状态，
   * 自动更新流程要的是「这次安装到底成不成」，两者语义不同。
   *
   * ⚠️ 返回 false 有两种含义（「无需安装」与「全部线路失败」），调用方需要区分时
   * 看 phase：失败会落到 'error' 并带原因。
   */
  async installLatest(manifestUrls?: string | string[]): Promise<boolean> {
    // 已有安装在跑：等它结束并复用它「到底装成了没有」的结论。
    // 不能读 phase 代替 —— phase 是给 UI 的全局状态，安装失败也会停在 error，
    // 而并发调用方关心的是「这次能不能算装好」。
    if (this.running) return this.running

    // 传入单条原始清单地址时，按当前线路设置展开成候选链（首选 → 直连 → 其它代理）。
    // 这样检查更新与安装更新用同一份顺序，不会出现「清单走 A、安装包走 B」。
    // 去重：非 GitHub 地址无法被代理改写（见 applyRoute），展开后每个都相同，
    // 不去重会让同一个地址被重复尝试多次、错误信息也重复。
    const expanded =
      typeof manifestUrls === 'string' ? getRouteChain().map(route => applyRoute(manifestUrls, route)) : []
    const candidates =
      typeof manifestUrls === 'string'
        ? [...new Set(expanded)]
        : manifestUrls
          ? [...new Set(manifestUrls.filter(Boolean))]
          : []

    this.running = (async () => {
      // 兜底路径：没有候选清单，让 Rust 使用静态 endpoints（可能为空 → 抛错）。
      const attempts: Array<string | null> = candidates.length > 0 ? candidates : [null]
      const failures: string[] = []

      for (let index = 0; index < attempts.length; index += 1) {
        const manifestUrl = attempts[index]
        const isLast = index === attempts.length - 1
        try {
          const stage = await this.prepareManifest(manifestUrl, index, attempts.length)
          if (!stage) return false // 清单版本不高于当前版本：无需安装，不是失败
          const result = await this.runInstall(stage.localUrl, stage.effectiveUrl, index, attempts.length)
          if (!result.installedVersion) return false
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(attempts.length > 1 ? `${describeRoute(manifestUrl)}: ${message}` : message)
          if (isLast) {
            /**
             * 全部线路都失败。以前这里只透出最后一个错误（往往是与真实原因无关的
             * 备用线路报错），用户看到「更新总出错」却不知道是 GitHub 直连被墙。
             * 现在把每条线路的结果一起给出。
             */
            this.setProgress({
              phase: 'error',
              error:
                failures.length > 1
                  ? `${i18n.t('settings:about.updateAllRoutesFailed')}: ${failures.join(' | ')}`
                  : message,
            })
            return false
          }
          // 还有下一条线路：回到 checking 态，让界面显示「正在换线路重试」
          this.setProgress({ phase: 'checking', downloadedBytes: 0, totalBytes: null, error: null })
        }
      }

      return false
    })()

    return this.running
  }

  /**
   * 决定这一次要把什么地址交给 Rust。
   *
   * 两种情况：
   * 1. **直连**（线路无代理前缀）：清单里的 asset 本来就是 github.com 绝对地址，
   *    无需改写 —— 直接把原地址交给插件，不多发一次请求、不写本地文件。
   * 2. **经代理**：必须先取回清单并把 asset 地址改写到同一条线路，否则会出现
   *    「检查更新正常、下载必然失败」（asset 仍直连 github.com）。
   *
   * ⚠️ 返回 null 表示无需安装（清单版本不高于当前版本）。
   */
  private async prepareManifest(
    manifestUrl: string | null,
    attemptIndex: number,
    attemptCount: number,
  ): Promise<{ localUrl: string; effectiveUrl: string } | null> {
    // 无原始清单（静态 endpoints 兜底）：原样交给 Rust，无 asset 可改写。
    if (!manifestUrl) return { localUrl: '', effectiveUrl: '' }

    this.setProgress({
      phase: 'checking',
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      attempt: attemptIndex + 1,
      attemptCount,
    })

    const route = routeFor(manifestUrl)
    // 直连：无需改写，直接把清单地址交给插件（保持原有行为与响应速度）
    if (!route.prefix) return { localUrl: manifestUrl, effectiveUrl: manifestUrl }

    const content = await fetchManifestContent(manifestUrl, [route])
    if (!content) throw new Error(i18n.t('settings:about.manifestUnreachable'))
    // 版本不高于当前版本：交给 Rust 判定即可（它内部有同样的 semver 检查），
    // 这里不额外判断 —— 避免两处版本比较逻辑分叉。
    const rewritten = rewriteManifestUrls(content, route)
    const localUrl = await stageRewrittenManifest(rewritten)
    return { localUrl, effectiveUrl: manifestUrl }
  }

  /** 用准备好的清单执行一次「检查 → 下载 → 安装」 */
  private async runInstall(
    localManifestUrl: string,
    effectiveUrl: string,
    attemptIndex: number,
    attemptCount: number,
  ): Promise<{ installedVersion: string | null }> {
    if (!localManifestUrl) {
      // 走静态 endpoints 的兜底路径：不重设进度（已由调用方设置）
      const channel = new Channel<UpdaterDownloadEvent>()
      const result = await invoke<UpdaterInstallResult>('updater_install', {
        manifestUrl: null,
        onEvent: channel,
        options: { timeout: UPSTREAM_TIMEOUT_MS },
      })
      if (!result.installedVersion) {
        this.setProgress({ phase: 'idle' })
        return { installedVersion: null }
      }
      this.setProgress({ phase: 'ready' })
      return result
    }

    this.setProgress({
      phase: 'checking',
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      attempt: attemptIndex + 1,
      attemptCount,
    })

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
      // 指向本地改写后的清单（asset 地址已是当前线路）
      manifestUrl: localManifestUrl,
      onEvent: channel,
      options: { timeout: UPSTREAM_TIMEOUT_MS },
    })

    if (!result.installedVersion) {
      this.setProgress({ phase: 'idle' })
      return { installedVersion: null }
    }

    if (import.meta.env.DEV) {
      console.info(`[desktopUpdater] installed ${result.installedVersion} via ${effectiveUrl}`)
    }
    this.setProgress({ phase: 'ready' })
    return result
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
