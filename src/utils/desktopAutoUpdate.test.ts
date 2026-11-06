import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopAutoUpdateCoordinator,
  IDLE_POLL_MS,
  INSTALL_RETRY_BACKOFF_MS,
  RELAUNCH_IDLE_GRACE_MS,
  isCheckDue,
  shouldAutoInstall,
  type AutoUpdateDeps,
} from './desktopAutoUpdate'
import type { AutoUpdateSettings } from '../store/autoUpdateSettings'
import type { UpdateRelease, UpdateState } from '../store/updateStore'

const RELEASE: UpdateRelease = {
  version: '2.0.99',
  tagName: 'v2.0.99',
  url: 'https://example.com',
  publishedAt: null,
  name: null,
  prerelease: false,
}

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    currentVersion: '2.0.60',
    currentChannel: 'stable',
    latestRelease: RELEASE,
    lastCheckedAt: 1_700_000_000_000,
    dismissedVersion: null,
    hiddenToastVersion: null,
    checking: false,
    error: null,
    ...overrides,
  }
}

function settings(overrides: Partial<AutoUpdateSettings> = {}): AutoUpdateSettings {
  return { enabled: true, intervalMinutes: 30, ...overrides }
}

describe('isCheckDue', () => {
  it('checks immediately when never checked', () => {
    expect(isCheckDue({ settings: settings(), lastCheckedAt: null, now: 1 })).toBe(true)
  })

  it('waits for the configured interval', () => {
    const now = 1_700_000_000_000
    // 29 分钟：未到
    expect(isCheckDue({ settings: settings(), lastCheckedAt: now - 29 * 60_000, now })).toBe(false)
    // 30 分钟：刚好到
    expect(isCheckDue({ settings: settings(), lastCheckedAt: now - 30 * 60_000, now })).toBe(true)
  })

  /**
   * 回归：updateStore 内部的 12h 门槛是给「启动时顺手查一次」设计的。
   * 若直接复用它，用户把间隔设成 30 分钟后每一轮都会被静默跳过。
   */
  it('respects an interval shorter than the store-level 12h threshold', () => {
    const now = 1_700_000_000_000
    const lastCheckedAt = now - 60 * 60_000 // 1 小时前
    expect(isCheckDue({ settings: settings({ intervalMinutes: 30 }), lastCheckedAt, now })).toBe(true)
    expect(isCheckDue({ settings: settings({ intervalMinutes: 180 }), lastCheckedAt, now })).toBe(false)
  })

  it('never checks when disabled', () => {
    expect(isCheckDue({ settings: settings({ enabled: false }), lastCheckedAt: null, now: 1 })).toBe(false)
  })
})

describe('shouldAutoInstall', () => {
  const base = {
    settings: settings(),
    state: state(),
    desktopAvailable: true,
    now: 1_700_000_000_000,
    failedVersion: null,
    failedAt: null,
  }

  it('installs when enabled, desktop and an update is available', () => {
    expect(shouldAutoInstall(base)).toBe(true)
  })

  it('skips when disabled or non-desktop', () => {
    expect(shouldAutoInstall({ ...base, settings: settings({ enabled: false }) })).toBe(false)
    expect(shouldAutoInstall({ ...base, desktopAvailable: false })).toBe(false)
  })

  it('skips when there is no newer version', () => {
    expect(shouldAutoInstall({ ...base, state: state({ latestRelease: null }) })).toBe(false)
    expect(
      shouldAutoInstall({
        ...base,
        state: state({ latestRelease: { ...RELEASE, version: '2.0.60' } }),
      }),
    ).toBe(false)
  })

  /**
   * 关键回归：定时器每 30 分钟跑一轮。若安装持续失败（磁盘满/权限不足/下载被墙），
   * 没有退避就会每轮重下几十 MB。
   */
  it('backs off after a failed install of the same version', () => {
    const failedAt = base.now - 1000
    expect(shouldAutoInstall({ ...base, failedVersion: '2.0.99', failedAt })).toBe(false)
    // 退避期过后允许重试
    expect(
      shouldAutoInstall({
        ...base,
        failedVersion: '2.0.99',
        failedAt: base.now - INSTALL_RETRY_BACKOFF_MS,
      }),
    ).toBe(true)
  })

  it('does not let a failure block a different version', () => {
    expect(
      shouldAutoInstall({
        ...base,
        state: state({ latestRelease: { ...RELEASE, version: '2.1.0' } }),
        failedVersion: '2.0.99',
        failedAt: base.now - 1000,
      }),
    ).toBe(true)
  })
})

// ============================================
// 协调器行为
// ============================================

interface Harness {
  coordinator: DesktopAutoUpdateCoordinator
  deps: AutoUpdateDeps
  advance: (ms: number) => void
  setBusy: (busy: boolean) => void
  setDraft: (draft: boolean) => void
}

function makeHarness(
  options: {
    installResults?: boolean[]
    updateState?: UpdateState
    /** check 之后状态变成什么（模拟服务端返回了新版本） */
    updateStateAfterCheck?: UpdateState
    settings?: AutoUpdateSettings
    desktopAvailable?: boolean
  } = {},
): Harness {
  let now = 1_700_000_000_000
  // 默认「上次检查是很久以前」，让第一轮 tick 一定会真正去查
  let currentState = options.updateState ?? state({ lastCheckedAt: null })
  let busy = false
  let draft = false
  let listeners: Array<() => void> = []
  const installResults = [...(options.installResults ?? [true])]

  const deps: AutoUpdateDeps = {
    now: () => now,
    isDesktopAvailable: () => options.desktopAvailable ?? true,
    getSettings: () => options.settings ?? settings(),
    getUpdateState: () => currentState,
    check: vi.fn(async ({ force }) => {
      void force
      currentState =
        options.updateStateAfterCheck !== undefined
          ? { ...options.updateStateAfterCheck, lastCheckedAt: now }
          : { ...currentState, lastCheckedAt: now }
    }),
    install: vi.fn(async () => installResults.shift() ?? false),
    relaunch: vi.fn(async () => {}),
    hasBusySessions: () => busy,
    hasUnsavedDrafts: () => draft,
    subscribeSessions: listener => {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter(entry => entry !== listener)
      }
    },
  }

  const coordinator = new DesktopAutoUpdateCoordinator(deps)

  return {
    coordinator,
    deps,
    advance: ms => {
      now += ms
    },
    setBusy: next => {
      busy = next
      listeners.forEach(listener => listener())
    },
    setDraft: next => {
      draft = next
    },
  }
}

describe('DesktopAutoUpdateCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('checks then installs when an update becomes available', async () => {
    // 起始时还不知道有新版本，check 之后服务端返回 2.0.99
    const h = makeHarness({
      updateState: state({ latestRelease: null, lastCheckedAt: null }),
      updateStateAfterCheck: state(),
    })
    const outcome = await h.coordinator.tick()

    expect(outcome).toBe('installed')
    expect(h.deps.check).toHaveBeenCalledWith({ force: true })
    expect(h.deps.install).toHaveBeenCalledTimes(1)
    expect(h.coordinator.getPendingRelaunchVersion()).toBe('2.0.99')
  })

  /**
   * 启动时 App 已经查过一次并发现了新版本，此时 lastCheckedAt 是「刚刚」。
   * 若只按间隔判定，第一次 tick 会空转，明明能装却要再等一整个间隔。
   */
  it('installs immediately when an update is already known, even if just checked', async () => {
    const h = makeHarness({ updateState: state({ lastCheckedAt: 1_700_000_000_000 }) })
    expect(await h.coordinator.tick()).toBe('installed')
    expect(h.deps.check).not.toHaveBeenCalled()
    expect(h.deps.install).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the interval has not elapsed and no update is known', async () => {
    const h = makeHarness({
      updateState: state({ latestRelease: null, lastCheckedAt: 1_700_000_000_000 }),
    })
    const outcome = await h.coordinator.tick()
    expect(outcome).toBe('idle')
    expect(h.deps.check).not.toHaveBeenCalled()
  })

  it('reports failure and backs off instead of retrying every cycle', async () => {
    const h = makeHarness({ installResults: [false, false] })

    expect(await h.coordinator.tick()).toBe('failed')
    expect(h.deps.install).toHaveBeenCalledTimes(1)

    // 下一轮：同一版本在退避期内，不再尝试安装
    h.advance(31 * 60_000)
    expect(await h.coordinator.tick()).toBe('idle')
    expect(h.deps.install).toHaveBeenCalledTimes(1)

    // 退避期过后允许重试
    h.advance(INSTALL_RETRY_BACKOFF_MS)
    expect(await h.coordinator.tick()).toBe('failed')
    expect(h.deps.install).toHaveBeenCalledTimes(2)
  })

  it('does not relaunch while a session is busy', async () => {
    const h = makeHarness()
    h.setBusy(true)
    await h.coordinator.tick()

    // 空闲期即便过了宽限期，只要还在忙就不重启
    h.advance(RELAUNCH_IDLE_GRACE_MS * 2)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).not.toHaveBeenCalled()
    expect(h.coordinator.getPendingRelaunchVersion()).toBe('2.0.99')
  })

  /**
   * 草稿闸门：用户停在一轮之后正在输入下一条，此时重启会把未发送内容一起丢掉。
   */
  it('does not relaunch while there are unsaved drafts', async () => {
    const h = makeHarness()
    h.setDraft(true)
    await h.coordinator.tick()

    h.advance(RELAUNCH_IDLE_GRACE_MS * 2)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).not.toHaveBeenCalled()
  })

  it('relaunches after the session has been idle past the grace period', async () => {
    const h = makeHarness()
    await h.coordinator.tick()
    expect(h.deps.relaunch).not.toHaveBeenCalled()

    // 第一次检查只记录空闲起点
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).not.toHaveBeenCalled()

    // 超过宽限期后重启
    h.advance(RELAUNCH_IDLE_GRACE_MS)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).toHaveBeenCalledTimes(1)
    expect(h.coordinator.getPendingRelaunchVersion()).toBeNull()
  })

  it('resets the idle clock when a session starts again', async () => {
    const h = makeHarness()
    await h.coordinator.tick()

    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()

    // 空闲计时中途来了一轮对话
    h.setBusy(true)
    h.advance(RELAUNCH_IDLE_GRACE_MS)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).not.toHaveBeenCalled()

    // 结束后必须重新等满一个宽限期
    h.setBusy(false)
    h.advance(RELAUNCH_IDLE_GRACE_MS - 1000)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).not.toHaveBeenCalled()

    h.advance(2000)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    expect(h.deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('restores the pending state when relaunch fails', async () => {
    const h = makeHarness()
    vi.mocked(h.deps.relaunch).mockRejectedValueOnce(new Error('boom'))
    await h.coordinator.tick()

    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()
    h.advance(RELAUNCH_IDLE_GRACE_MS)
    vi.advanceTimersByTime(IDLE_POLL_MS)
    await Promise.resolve()

    // 重启失败后仍应保留「待重启」，而不是当作已完成
    expect(h.coordinator.getPendingRelaunchVersion()).toBe('2.0.99')
  })

  it('skips entirely on non-desktop platforms', async () => {
    const h = makeHarness({ desktopAvailable: false })
    expect(await h.coordinator.tick()).toBe('skipped')
    expect(h.deps.check).not.toHaveBeenCalled()
  })
})
