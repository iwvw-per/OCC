import { useSyncExternalStore } from 'react'
import i18n from '../i18n'

export interface UpdateRelease {
  version: string
  tagName: string
  url: string
  publishedAt: string | null
  name: string | null
  /** 该 release 是否为预发布（canary/alpha/beta）；旧备份数据可能缺失该字段 */
  prerelease?: boolean
}

/** 更新通道：由当前安装的版本自动判定，不提供用户开关 */
export type UpdateChannel = 'stable' | 'canary'

export interface UpdateState {
  currentVersion: string
  currentChannel: UpdateChannel
  latestRelease: UpdateRelease | null
  lastCheckedAt: number | null
  dismissedVersion: string | null
  hiddenToastVersion: string | null
  checking: boolean
  error: string | null
}

interface PersistedUpdateState {
  latestRelease: UpdateRelease | null
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export interface UpdateSettingsBackup {
  latestRelease: UpdateRelease | null
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

type Subscriber = () => void

const STORAGE_KEY = 'opencode:update-check'
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const RELEASES_ROOT_URL = 'https://api.github.com/repos/iwvw-per/OpenCodeUI/releases'
// canary 通道用列表接口拉取最近若干个 release，取语义最大的 prerelease。
// 单次响应约 27KB/release，per_page 取最小可用值控制流量。
const CANARY_RELEASE_SCAN_LIMIT = 5
// 产品线隔离后，稳定通道也必须走列表接口（/latest 只返回最新一个、无法按主版本
// 过滤）。per_page 需要能覆盖该主版本的全部 release，取 20 以兼顾 v1/v2 各迭代。
const STABLE_RELEASE_SCAN_LIMIT = 20
export const RELEASES_API_URL = `${RELEASES_ROOT_URL}/latest`
export const RELEASES_PAGE_URL = 'https://github.com/iwvw-per/OpenCodeUI/releases/latest'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const PRERELEASE_RE = /-(?:canary|alpha|beta)(?:\.|$)/i

/** 去掉开头的 v，保留 prerelease 后缀（semver 比较需要它） */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/**
 * 取版本号的主版本号（"2.0.0-canary.1" → "2"）。
 * 用于 updater 产品线隔离：v1(1.x) 与 v2(2.x) 各自只在自己主版本内更新。
 */
export function majorVersion(version: string): string {
  return normalizeVersion(version).split('.')[0] || '0'
}

/** 版本号是否为预发布（canary/alpha/beta）——决定更新通道 */
export function isPrereleaseVersion(version: string): boolean {
  return PRERELEASE_RE.test(normalizeVersion(version))
}

/**
 * semver 风格比较：main 三段数字逐段比，相同则比 prerelease。
 * semver 语义下 prerelease 小于同号正式版：
 *   0.6.125 > 0.6.125-canary.1 > 0.6.125-canary.0 > 0.6.124
 * 因此 canary 用户既能收到更新的 canary，也能收到更高号的 stable。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string) => {
    const normalized = normalizeVersion(raw)
    const dashIndex = normalized.indexOf('-')
    const core = dashIndex === -1 ? normalized : normalized.slice(0, dashIndex)
    const prerelease = dashIndex === -1 ? null : normalized.slice(dashIndex + 1)
    const numbers = core.split('.').map(part => Number.parseInt(part, 10) || 0)
    const preParts = prerelease
      ? prerelease
          .split('.')
          .map(part => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part.toLowerCase()))
      : null
    return { numbers, preParts }
  }

  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.numbers.length, right.numbers.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0)
    if (diff !== 0) return diff
  }

  // 正式版 > 预发布
  if (!left.preParts && !right.preParts) return 0
  if (!left.preParts) return 1
  if (!right.preParts) return -1

  const preLength = Math.max(left.preParts.length, right.preParts.length)
  for (let i = 0; i < preLength; i += 1) {
    const l = left.preParts[i]
    const r = right.preParts[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l - r
    } else if (typeof l === 'number') {
      return -1
    } else if (typeof r === 'number') {
      return 1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }

  return 0
}

export function hasUpdateAvailable(state: UpdateState): boolean {
  return !!state.latestRelease && compareVersions(state.latestRelease.version, state.currentVersion) > 0
}

export function shouldShowUpdateToast(state: UpdateState): boolean {
  if (!state.latestRelease || !hasUpdateAvailable(state)) return false
  if (state.dismissedVersion === state.latestRelease.version) return false
  if (state.hiddenToastVersion === state.latestRelease.version) return false
  return true
}

/**
 * 某个 release 的更新清单（latest.json）下载地址。
 * canary release 的清单在其 tag 下（其 version 即为 canary 版本号），
 * 桌面端一键更新用它作为动态 updater endpoint——稳定通道的
 * releases/latest/download 永远解析不到 prerelease。
 */
export function getReleaseManifestUrl(release: UpdateRelease): string {
  return `https://github.com/iwvw-per/OpenCodeUI/releases/download/${release.tagName}/latest.json`
}

function loadPersistedState(): PersistedUpdateState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { latestRelease: null, lastCheckedAt: null, dismissedVersion: null }
    }

    const parsed = JSON.parse(raw) as PersistedUpdateState
    return {
      latestRelease: parsed?.latestRelease ?? null,
      lastCheckedAt: typeof parsed?.lastCheckedAt === 'number' ? parsed.lastCheckedAt : null,
      dismissedVersion: typeof parsed?.dismissedVersion === 'string' ? parsed.dismissedVersion : null,
    }
  } catch {
    return { latestRelease: null, lastCheckedAt: null, dismissedVersion: null }
  }
}

function persistState(state: UpdateState): void {
  try {
    const payload: PersistedUpdateState = {
      latestRelease: state.latestRelease,
      lastCheckedAt: state.lastCheckedAt,
      dismissedVersion: state.dismissedVersion,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage write failures.
  }
}

function parseRelease(payload: unknown): UpdateRelease {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid release payload')
  }

  const tagName = typeof payload.tag_name === 'string' ? payload.tag_name : ''
  const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : RELEASES_PAGE_URL

  if (!tagName) {
    throw new Error('Missing release tag')
  }

  return {
    version: normalizeVersion(tagName),
    tagName,
    url: htmlUrl,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    prerelease: payload.prerelease === true,
  }
}

/**
 * 从 release 列表里挑出本通道语义最大的候选：跳过 draft。
 * - stable 通道：只接受正式版（prerelease=true 的跳过）
 * - canary 通道：预发布与正式版都接受，取语义最大者——canary 用户既该收到
 *   更新的 canary（0.6.125-canary.2 > canary.1），也该在该号 stable 发布后
 *   升级到正式版（0.6.125 > 0.6.125-canary.2）。
 *
 * 产品线隔离：只在与 currentVersion 主版本相同的 release 内选择，使 v1(1.x)
 * 与 v2(2.x) 各自独立更新、不互相跨大版本提示升级。
 */
function pickRelease(payload: unknown, channel: UpdateChannel, currentVersion: string): UpdateRelease | null {
  if (!Array.isArray(payload)) throw new Error('Invalid release list payload')

  const currentMajor = majorVersion(currentVersion)
  let best: UpdateRelease | null = null
  for (const entry of payload) {
    if (!isPlainObject(entry) || entry.draft === true) continue
    if (channel === 'stable' && entry.prerelease === true) continue
    let release: UpdateRelease
    try {
      release = parseRelease(entry)
    } catch {
      continue
    }
    // 产品线隔离：主版本不一致的 release 不属于本更新线，直接跳过。
    if (majorVersion(release.version) !== currentMajor) continue
    if (!best || compareVersions(release.version, best.version) > 0) best = release
  }
  return best
}

function getDefaultCurrentVersion(): string {
  try {
    return __APP_VERSION__
  } catch {
    return '0.0.0'
  }
}

export class UpdateStore {
  private state: UpdateState
  private subscribers = new Set<Subscriber>()
  private inflightCheck: Promise<void> | null = null

  constructor(currentVersion?: string) {
    const persisted = loadPersistedState()
    const resolvedVersion = normalizeVersion(currentVersion ?? getDefaultCurrentVersion())
    this.state = {
      currentVersion: resolvedVersion,
      currentChannel: isPrereleaseVersion(resolvedVersion) ? 'canary' : 'stable',
      latestRelease: persisted.latestRelease,
      lastCheckedAt: persisted.lastCheckedAt,
      dismissedVersion: persisted.dismissedVersion,
      hiddenToastVersion: null,
      checking: false,
      error: null,
    }
  }

  subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  getSnapshot = (): UpdateState => this.state

  private notify(): void {
    this.subscribers.forEach(callback => callback())
  }

  private setState(nextState: UpdateState): void {
    this.state = nextState
    persistState(this.state)
    this.notify()
  }

  private applyRelease(release: UpdateRelease | null, checkedAt: number): void {
    // 列表接口按通道筛选后可能为空（如尚未发布过任何 canary）：保留旧值仅更新时间戳。
    if (!release) {
      this.setState({ ...this.state, lastCheckedAt: checkedAt, checking: false, error: null })
      return
    }
    const previousVersion = this.state.latestRelease?.version ?? null
    this.setState({
      ...this.state,
      latestRelease: release,
      lastCheckedAt: checkedAt,
      hiddenToastVersion: previousVersion && previousVersion !== release.version ? null : this.state.hiddenToastVersion,
      checking: false,
      error: null,
    })
  }

  async checkForUpdates(options?: { force?: boolean }): Promise<void> {
    if (this.inflightCheck) return this.inflightCheck

    const force = options?.force === true
    const now = Date.now()
    const isFresh =
      !force && typeof this.state.lastCheckedAt === 'number' && now - this.state.lastCheckedAt < CHECK_INTERVAL_MS

    if (isFresh) return

    this.state = {
      ...this.state,
      checking: true,
      error: null,
    }
    this.notify()

    this.inflightCheck = (async () => {
      try {
        // 稳定通道也必须走列表接口：产品线隔离需要按主版本过滤，
        // /releases/latest 只返回最新一个、无法区分 v1(1.x)/v2(2.x)。
        // canary 通道取预发布与正式版的最大者（/latest 解析不到 prerelease）。
        const scanLimit =
          this.state.currentChannel === 'canary' ? CANARY_RELEASE_SCAN_LIMIT : STABLE_RELEASE_SCAN_LIMIT
        const requestUrl = `${RELEASES_ROOT_URL}?per_page=${scanLimit}`

        const response = await fetch(requestUrl, {
          headers: { Accept: 'application/vnd.github+json' },
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const payload = await response.json()
        const release = Array.isArray(payload)
          ? pickRelease(payload, this.state.currentChannel, this.state.currentVersion)
          : // 兜底：单个 release 对象时视为与当前主版本一致（仅当主版本匹配才接受）
            majorVersion((payload as { tag_name?: string })?.tag_name ?? '') ===
              majorVersion(this.state.currentVersion)
            ? parseRelease(payload)
            : null
        this.applyRelease(release, now)
      } catch (error) {
        this.state = {
          ...this.state,
          checking: false,
          error: error instanceof Error ? error.message : i18n.t('settings:about.checkFailed'),
        }
        this.notify()
      } finally {
        this.inflightCheck = null
      }
    })()

    return this.inflightCheck
  }

  hideToastForCurrentVersion(): void {
    if (!this.state.latestRelease) return
    this.state = {
      ...this.state,
      hiddenToastVersion: this.state.latestRelease.version,
    }
    this.notify()
  }

  dismissCurrentVersion(): void {
    if (!this.state.latestRelease) return
    this.setState({
      ...this.state,
      dismissedVersion: this.state.latestRelease.version,
      hiddenToastVersion: this.state.latestRelease.version,
    })
  }

  /** 导入备份：更新内存状态并通知订阅者（只写 localStorage 会让 UI 与再次导出继续用旧值） */
  applyImportedSettings(payload: PersistedUpdateState): void {
    this.setState({
      ...this.state,
      latestRelease: payload.latestRelease,
      lastCheckedAt: payload.lastCheckedAt,
      dismissedVersion: payload.dismissedVersion,
      checking: false,
      error: null,
    })
  }
}

export const updateStore = new UpdateStore()

export function exportUpdateSettingsBackup(): UpdateSettingsBackup {
  const state = updateStore.getSnapshot()
  return {
    latestRelease: state.latestRelease,
    lastCheckedAt: state.lastCheckedAt,
    dismissedVersion: state.dismissedVersion,
  }
}

export function importUpdateSettingsBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const payload: PersistedUpdateState = {
    latestRelease:
      parsed?.latestRelease && typeof parsed.latestRelease === 'object'
        ? (parsed.latestRelease as UpdateRelease)
        : null,
    lastCheckedAt: typeof parsed?.lastCheckedAt === 'number' ? parsed.lastCheckedAt : null,
    dismissedVersion: typeof parsed?.dismissedVersion === 'string' ? parsed.dismissedVersion : null,
  }
  updateStore.applyImportedSettings(payload)
}

export function useUpdateStore(): UpdateState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot, updateStore.getSnapshot)
}
