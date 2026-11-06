// ============================================
// 桌面端自动更新协调器
// ============================================
//
// 职责：按设定间隔定时检查；发现新版本后**静默**下载安装；装完后等会话空闲
// 再重启，不打断正在跑的对话。
//
// 与既有模块的分工：
//   - updateStore：只回答「有没有新版本」（跨平台，含 Android）
//   - desktopUpdater：只负责「下载 + 安装 + 重启」这个动作
//   - 本模块：把两者串成「定时 → 检查 → 安装 → 空闲后重启」，并持有重试策略
//
// 三条刻意的约束：
//
// 1. **只在真正空闲时重启**。macOS/Linux 装完必须重启才生效；若在对话进行中
//    重启，正在跑的一轮直接丢失。判据是「无 busy 会话 + 无未发送草稿」，且要求
//    持续空闲一段时间，避免用户刚停下来吸口气就被重启。
//
// 2. **同一版本失败后不无限重试**。定时器每 30 分钟跑一轮，若安装持续失败
//    （磁盘满、权限不足、下载被墙），每轮都重下几十 MB 是纯浪费。失败后进入
//    长时间退避，且不阻塞后续新版本的检测。
//
// 3. **失败不打扰用户**。静默失败不该弹 toast 抢注意力；状态留在 updateStore /
//    desktopUpdater 里，设置页可见。

import { activeSessionStore } from '../store/activeSessionStore'
import { autoUpdateSettingsStore, type AutoUpdateSettings } from '../store/autoUpdateSettings'
import { inputDraftStore } from '../store/inputDraftStore'
import {
  getReleaseManifestUrl,
  hasUpdateAvailable,
  updateStore,
  type UpdateRelease,
  type UpdateState,
} from '../store/updateStore'
import { desktopUpdater, isDesktopUpdaterAvailable } from './desktopUpdater'

/** 会话空闲多久之后才允许自动重启（ms） */
export const RELAUNCH_IDLE_GRACE_MS = 60_000

/** 安装失败后等多久再试（ms） */
export const INSTALL_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000

/** 空闲轮询间隔（ms）：没有会话事件时也要能推进重启判断 */
export const IDLE_POLL_MS = 30_000

export type AutoUpdateOutcome = 'idle' | 'skipped' | 'installed' | 'failed'

/** 可注入依赖。生产走默认实现，测试整体替换。 */
export interface AutoUpdateDeps {
  now: () => number
  isDesktopAvailable: () => boolean
  getSettings: () => AutoUpdateSettings
  getUpdateState: () => UpdateState
  check: (options: { force: boolean }) => Promise<void>
  /** 执行安装；返回是否真的装好了（清单版本不高于当前版本也算 false） */
  install: (release: UpdateRelease) => Promise<boolean>
  relaunch: () => Promise<void>
  /** 是否有会话在跑，或正等着用户回复权限/提问 */
  hasBusySessions: () => boolean
  /** 是否有未发送的输入草稿 */
  hasUnsavedDrafts: () => boolean
  /** 订阅会话活跃状态变化；返回取消订阅函数 */
  subscribeSessions: (listener: () => void) => () => void
}

export const defaultAutoUpdateDeps: AutoUpdateDeps = {
  now: () => Date.now(),
  isDesktopAvailable: isDesktopUpdaterAvailable,
  getSettings: () => autoUpdateSettingsStore.get(),
  getUpdateState: () => updateStore.getSnapshot(),
  check: options => updateStore.checkForUpdates(options),
  install: async release => {
    // desktopUpdater 内部把失败吞进 phase 而不抛出，因此由它直接回答「这次装成了没有」。
    return desktopUpdater.installLatest(getReleaseManifestUrl(release))
  },
  relaunch: () => desktopUpdater.relaunchApp(),
  hasBusySessions: () => activeSessionStore.getBusySessions().length > 0,
  hasUnsavedDrafts: () => inputDraftStore.hasAnyDraft(),
  subscribeSessions: listener => activeSessionStore.subscribe(listener),
}

/**
 * 是否应为本轮检测到的版本执行自动安装。
 *
 * 抽成纯函数：判定条件有五个（开关、平台、有更新、同版本失败过、退避期），
 * 散在流程里极易漏掉「同一版本反复重装」这一条。
 */
export function shouldAutoInstall(input: {
  settings: AutoUpdateSettings
  state: UpdateState
  desktopAvailable: boolean
  now: number
  /** 上次安装失败的版本；从未失败为 null */
  failedVersion: string | null
  /** 上次安装失败的时刻；从未失败为 null */
  failedAt: number | null
  retryBackoffMs?: number
}): boolean {
  const { settings, state, desktopAvailable, now, failedVersion, failedAt } = input
  if (!settings.enabled) return false
  if (!desktopAvailable) return false
  if (!hasUpdateAvailable(state)) return false
  const version = state.latestRelease?.version
  if (!version) return false
  if (failedVersion === version && failedAt !== null) {
    const backoff = input.retryBackoffMs ?? INSTALL_RETRY_BACKOFF_MS
    return now - failedAt >= backoff
  }
  return true
}

/**
 * 是否到了下一次检测的时间。
 *
 * 用「上次检查时刻 + 用户设定间隔」判定，而不是沿用 updateStore 内部的 12h 门槛：
 * 后者是为「启动时顺手查一次」设计的，用户把间隔调到 30 分钟时会被静默跳过。
 */
export function isCheckDue(input: {
  settings: AutoUpdateSettings
  lastCheckedAt: number | null
  now: number
}): boolean {
  const { settings, lastCheckedAt, now } = input
  if (!settings.enabled) return false
  if (lastCheckedAt === null) return true
  return now - lastCheckedAt >= settings.intervalMinutes * 60_000
}

export class DesktopAutoUpdateCoordinator {
  private deps: AutoUpdateDeps
  private timer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeSessions: (() => void) | null = null
  private unsubscribeSettings: (() => void) | null = null
  private running = false
  /** 已装好、等空闲重启的版本 */
  private pendingRelaunchVersion: string | null = null
  private failedVersion: string | null = null
  private failedAt: number | null = null
  /** 进入空闲的起始时刻；不空闲时为 null */
  private idleSince: number | null = null

  constructor(deps: Partial<AutoUpdateDeps> = {}) {
    this.deps = { ...defaultAutoUpdateDeps, ...deps }
  }

  /** 已装好但还没重启的版本（供设置页展示「重启后生效」） */
  getPendingRelaunchVersion(): string | null {
    return this.pendingRelaunchVersion
  }

  /**
   * 启动定时检测并立即跑一轮。
   *
   * 幂等：重复调用只重排定时器，不会叠加多个 interval。
   * 关闭自动更新时不启动（但设置变化会重新触发 start）。
   */
  start(): void {
    this.stop()
    // 设置变化（开关/间隔）后按新间隔重排，不等当前周期走完
    this.unsubscribeSettings = autoUpdateSettingsStore.subscribe(() => this.start())
    if (!this.deps.isDesktopAvailable()) return

    const settings = this.deps.getSettings()
    if (!settings.enabled) return

    this.timer = setInterval(() => void this.tick(), settings.intervalMinutes * 60_000)
    this.unrefTimer(this.timer)
    void this.tick()
  }

  /** 停止所有定时器（设置页关闭、应用卸载前） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stopIdleWatcher()
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = null
  }

  /** 单个检测周期：检查 → 判定 → 安装 */
  async tick(): Promise<AutoUpdateOutcome> {
    // 上一轮还没结束（网络慢/正在下载）时不叠加第二轮
    if (this.running) return 'skipped'
    if (!this.deps.isDesktopAvailable()) return 'skipped'

    const settings = this.deps.getSettings()
    if (!settings.enabled) return 'skipped'

    this.running = true
    try {
      /**
       * 先看「已知有更新」再决定要不要重新查。
       *
       * 启动时 App 已经调过一次 checkForUpdates，它把 lastCheckedAt 刷新了；
       * 若这里无条件先判「到点没」，第一次 tick 就会因为「刚查过」而空转，
       * 明明已经发现新版本却要再等一个完整间隔才安装。
       */
      if (!shouldAutoInstall(this.installInput())) {
        const state = this.deps.getUpdateState()
        if (
          !isCheckDue({ settings: this.deps.getSettings(), lastCheckedAt: state.lastCheckedAt, now: this.deps.now() })
        ) {
          return 'idle'
        }
        await this.deps.check({ force: true })
      }

      if (!shouldAutoInstall(this.installInput())) return 'idle'
      const release = this.deps.getUpdateState().latestRelease
      if (!release) return 'idle'

      const installed = await this.deps.install(release)
      if (!installed) {
        this.failedVersion = release.version
        this.failedAt = this.deps.now()
        return 'failed'
      }
      this.failedVersion = null
      this.failedAt = null
      this.pendingRelaunchVersion = release.version
      this.startIdleWatcher()
      return 'installed'
    } finally {
      this.running = false
    }
  }

  private installInput() {
    return {
      settings: this.deps.getSettings(),
      state: this.deps.getUpdateState(),
      desktopAvailable: this.deps.isDesktopAvailable(),
      now: this.deps.now(),
      failedVersion: this.failedVersion,
      failedAt: this.failedAt,
    }
  }

  /**
   * 装完后等会话空闲再重启。
   *
   * 订阅会话状态而不是只轮询：会话结束那一刻就能重启，不必等下一个轮询点；
   * 轮询只作为「长时间没有会话事件」时的兜底。
   */
  private startIdleWatcher(): void {
    if (this.idleTimer !== null) return
    this.idleSince = null

    const check = () => this.checkIdleRelaunch()

    this.unsubscribeSessions = this.deps.subscribeSessions(check)
    this.idleTimer = setInterval(check, IDLE_POLL_MS)
    this.unrefTimer(this.idleTimer)
    // 装完时本来就空闲：立刻开始计时空闲期
    check()
  }

  private stopIdleWatcher(): void {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    this.unsubscribeSessions?.()
    this.unsubscribeSessions = null
    this.idleSince = null
  }

  private checkIdleRelaunch(): void {
    if (this.pendingRelaunchVersion === null) return
    if (!this.isIdle()) {
      this.idleSince = null
      return
    }
    const now = this.deps.now()
    if (this.idleSince === null) {
      this.idleSince = now
      return
    }
    if (now - this.idleSince < RELAUNCH_IDLE_GRACE_MS) return
    this.relaunchNow()
  }

  private isIdle(): boolean {
    // 草稿单独判：用户可能停在一轮之后正在输入下一条，此时重启会丢内容
    if (this.deps.hasBusySessions()) return false
    if (this.deps.hasUnsavedDrafts()) return false
    return true
  }

  private relaunchNow(): void {
    const version = this.pendingRelaunchVersion
    if (version === null) return
    this.pendingRelaunchVersion = null
    this.stopIdleWatcher()
    void this.deps.relaunch().catch(() => {
      // 重启失败：恢复待重启状态，下轮再试。否则用户会以为更新已完成却仍跑旧版本
      this.pendingRelaunchVersion = version
      this.startIdleWatcher()
    })
  }

  /** Node/测试环境下让定时器不阻止进程退出 */
  private unrefTimer(timer: ReturnType<typeof setInterval>): void {
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
}

export const desktopAutoUpdate = new DesktopAutoUpdateCoordinator()
