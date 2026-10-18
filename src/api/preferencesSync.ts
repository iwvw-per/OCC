// ============================================
// Preferences Sync - 客户端设置的多端同步
//
// 登录 API Monitor 账号后，把本地设置（localStorage 中的用户偏好）推送到
// 面板的 /api/aiagent/preferences，并在启动/轮询/手动触发时与服务端做双向
// 合并，让桌面端、移动端与 Web 端共享同一份用户偏好。
//
// ============================================
// 安全边界：白名单制（收缩默认权限）
// ============================================
//
// 只有 SYNCABLE_PATTERNS 命中的键才允许同步，其余一律拒绝：
//
//   1. srv:aiagent:{id}:opencode-saved-directories —— 项目列表（按服务器分桶）
//   2. opencode-pinned-sessions / opencode-pinned-messages —— 置顶
//   3. opencode-read-watermarks / opencode-project-last-used —— 单调计数
//   4. theme-preset / theme-mode —— 主题
//
// **个性化设置不同步**：外观、布局、字号、音效、通知开关等一律不参与。
// 它们对跨端一致性的要求低，却需要额外的时间戳仲裁与冲突处理；去掉之后
// 同步层只剩「并集」与「取最大」两种幂等合并，多端同时操作天然不冲突。
//
// 白名单必须显式登记，不会因为新增一个 localStorage 键就自动同步
// （「意外泄露」被转换成「必须显式登记」）。历史教训：此前采用黑名单制，
// 把面板凭据（webRcloneAuth 含 Basic 认证串）、debug-err（含本地源码路径）、
// opencode-terminal-layout（含全盘目录列表）等全量推上了服务端。
//
// ============================================
// 本机专属键（保持排除，不参与同步）
// ============================================
//
// 不同主机的盘符与用户目录不同（工作机 D:\ + Administrator，笔电 E:\ +
// DSUK），因此记录本机路径的键同步过去就是死路径：
//   - opencode-active-server：当前活动服务器是各端运行时状态
//   - opencode-binary-path / opencode-auto-start-service /
//     opencode-service-env-vars：本机二进制路径与服务设置
//   - opencode-terminal-layout：含全盘目录列表，路径异构且体积大
//   - opencode-servers：含各端地址与凭证，跨端同步会让其中一台不可用
//   - last-directory / opencode-recent-projects：记录本机上次打开的路径
//   - selected-project-id：记录本机当前项目；它不匹配任何准入前缀，
//     因此落在末尾的「其它一律拒绝」分支，而不是列在排除清单里
//
// ============================================
// 界面开合状态（排除，不参与同步）
// ============================================
//
// 侧栏、右侧/底部面板、工作状态板块的「此刻是否展开」属于当前这一屏的浏览
// 状态，与「用户偏好」是两回事：偏好改了应当跨端一致，而浏览状态由用户此刻
// 正在看什么决定，各端本就应当独立。
//
// 把它们纳入同步的代价是持续拉锯：A 端展开侧栏 → 推送 true → B 端被弹开；
// B 端收起 → 推送 false → A 端被折叠。用户在任何一端都难以稳定保持展开。
// 更糟的是 pull 先于 push，本地刚写入的值会被服务端的旧值盖回（表现为
// 「点了没反应」）。排除后各端界面互不干扰，这类竞态从根上消失。
//
// 排除清单：
//   - opencode-sidebar-expanded：侧栏开合
//   - opencode-sidebar-expanded-projects：项目行展开/收起
//   - opencode-panel-layout：右侧/底部面板开合与面板 tab
//   - opencode-work-status-enabled / opencode-work-status-expanded：
//     工作状态面板开关与板块展开
//
// 注意「项目列表本身」（srv:aiagent:inst_X:opencode-saved-directories）不在此
// 列：那是用户显式保存的项目，属于偏好，仍跨端同步。
//
// ============================================
// 合并语义（多条目容器）
// ============================================
//
// 普通标量键按服务端返回的逐键 updatedAt 做新者胜（lastWriteWins）。
// 以下聚合键按后缀识别，做语义合并而不是整键覆盖，避免丢数据：
//   - opencode-pinned-sessions：数组，按 sessionId 去重并集
//   - opencode-saved-directories：数组，按 path 去重并集
//   - opencode-pinned-messages：数组，按 sessionId 去重并集
//
// 合并范围仅限「同一个键」：saved-directories 按实例分桶
// （srv:aiagent:inst_X:opencode-saved-directories），各实例互不干扰。
// 刻意不做跨实例并集 —— 那会把工作机的 D:/Code/* 带进笔电的项目列表（反之
// 亦然），出现本机不存在的幽灵目录。用户要的是「同一主机在各设备上一致」，
// 而这一点由「同一个键在各设备间同步」天然满足。
//
// opencode-hidden-directories 已废弃：项目列表不再做服务器侧自动发现，用户
// 看到的项目完全由 saved-directories 决定，「隐藏发现项」这个概念随之消失。
// 该键仍在准入前缀下（历史数据不主动删除），但不再有代码写入或读取它。
//
// 取消置顶/取消保存的意图用墓碑（tombstone）表达：维护「已删除条目」记录，
// 合并时排除墓碑项，30 天后自动过期清理。
//
// ============================================
// 冲突仲裁
// ============================================
//
// 写入时服务端按「逐键 updatedAt」比较（PUT 带 ?lastWriteWins=1）。本地用
// SYNC_STAMPS_KEY 记录每个键的最后修改时间，只对相对上次快照发生变化的键刷新
// 时间戳，未变化的键沿用旧时间戳，避免用「当前时间」把别的端更新的旧键顶回去。
// 时间戳用 ISO 8601，与服务端字符串比较口径一致。
// ============================================

import { accountRequest, accountRequestWithMeta, readAccount, type AiAgentAccount } from './aiagent'
import { notifyPerServerStorageChanged } from '../utils/perServerStorage'
import { layoutStore } from '../store/layoutStore'
import { serverStore } from '../store/serverStore'
import { readWatermarkStore } from '../store/readWatermarkStore'
import { sessionActivityStore } from '../store/sessionActivityStore'

/**
 * B 类缺陷 1：同步时间戳的时钟。
 *
 * 偏好同步带 `lastWriteWins=1`，服务端信任客户端传入的 updatedAt。若用本地钟，
 * 设备 A 时钟快 5 分钟，A 写的每个键时间戳都永久大于 B，B 的改动永远被顶掉。
 * 优先用服务端校准钟（server.connected 时间戳推导），不可用时退回本地钟并接受偏差。
 */
function syncNow(): number {
  const calibrated = serverStore.getActiveCalibratedNow()
  return calibrated ?? Date.now()
}

function syncNowIso(): string {
  return new Date(syncNow()).toISOString()
}

const SYNC_ENABLED_KEY = 'opencode-preferences-sync-enabled'
const SYNC_META_KEY = 'opencode-preferences-sync-meta'
const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const TOMBSTONES_KEY = 'opencode-preferences-sync-tombstones'

const SNAPSHOT_KEY = '__snapshot__'

/**
 * 上一次 pull 拿到的 ETag（按账号域 + 用户区分）。
 *
 * 面板对 GET /api/aiagent/preferences 返回全量偏好（数十 KB），而同步引擎每
 * 15 秒就会拉一次。服务端已支持 ETag/If-None-Match → 304（零响应体），这里
 * 带上缓存值即可把「内容没变」的轮询成本降到接近 0。
 */
const PULL_ETAG_KEY = 'opencode-preferences-sync-etag'

function readPullEtag(account: AiAgentAccount): string {
  try {
    const raw = localStorage.getItem(PULL_ETAG_KEY)
    if (!raw) return ''
    const parsed = asRecord(JSON.parse(raw))
    if (!parsed) return ''
    const scope = `${account.domain}|${account.username}`
    const value = parsed[scope]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

function writePullEtag(account: AiAgentAccount, etag: string): void {
  try {
    const raw = localStorage.getItem(PULL_ETAG_KEY)
    const parsed = raw ? asRecord(JSON.parse(raw)) : null
    const next: Record<string, string> = parsed ? { ...(parsed as Record<string, string>) } : {}
    const scope = `${account.domain}|${account.username}`
    if (etag) next[scope] = etag
    else delete next[scope]
    localStorage.setItem(PULL_ETAG_KEY, JSON.stringify(next))
  } catch {
    // 忽略：ETag 只是优化，存不下就退化为普通请求。
  }
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 跨设备同步的白名单。
 *
 * 只有「多端看到不一致会被当成 bug」的数据才能出现在这里：
 *   - 项目列表（按服务器分桶）
 *   - 置顶会话 / 置顶消息
 *   - 已读水位、项目最后活跃时间
 *   - 主题（preset + mode）
 *
 * 外观/布局/音效/通知等个性化设置**不参与同步**：它们对跨端一致性要求低，
 * 却带来大量合并分支与流量，收益远小于成本。要新增同步项，必须在
 * SYNCABLE_PATTERNS 里显式登记，并为其指定合并策略（见 MERGE_RULES）。
 */
const SYNCABLE_PATTERNS: RegExp[] = [
  // 项目列表：按服务器分桶，数组并集 + 墓碑
  /^srv:aiagent:[^:]+:opencode-saved-directories$/,
  // 置顶会话 / 置顶消息
  /^opencode-pinned-sessions$/,
  /^opencode-pinned-messages$/,
  // 已读水位、项目最后活跃时间（均为 map<id, 时间戳>，逐键取 max）
  /^opencode-read-watermarks$/,
  /^opencode-project-last-used$/,
  // 主题：仅这两个键，标量 LWW
  /^theme-(preset|mode)$/,
]

/**
 * 已下线同步的历史键。新版不再读写它们，由 sync/cleanup 在首次同步后
 * 从服务端删除（本地保留，因为本机仍在用这些设置）。
 */
export const DEPRECATED_SYNCABLE_KEYS: string[] = [
  // 外观 / 布局
  'chat-content-width',
  'code-word-wrap',
  'collapse-user-messages',
  'descriptive-tool-steps',
  'desktop-collapsed-input-dock',
  'diff-style',
  'external-file-drop-mode',
  'font-scale',
  'glass-effect',
  'i18nextLng',
  'process-collapse-enabled',
  'queue-followup-messages',
  'reasoning-display-mode',
  'render-user-markdown',
  'sidebar-width',
  'step-finish-display',
  'theme-custom-css',
  // 音效 / 通知 / 设备相关
  'opencode:haptic-settings',
  'opencode:large-text-paste',
  'opencode:notification-event-settings',
  'opencode:sound-settings',
  'opencode:toast-enabled',
  'opencode:update-check',
]

const SYNC_METADATA_KEYS = new Set([SYNC_ENABLED_KEY, SYNC_META_KEY, SYNC_STAMPS_KEY, TOMBSTONES_KEY])

/**
 * 是否参与同步的 localStorage 键。
 *
 * 白名单制：只放行 SYNCABLE_PATTERNS 命中的键，其余一律不同步。
 * 安全优先——「意外泄露」被转换成「必须显式登记」。
 */
export function isSyncableKey(key: string): boolean {
  if (!key) return false
  if (SYNC_METADATA_KEYS.has(key)) return false
  return SYNCABLE_PATTERNS.some(pattern => pattern.test(key))
}


/**
 * 列出 localStorage 中的所有键。
 * 优先用 key(index) 遍历；测试环境的 localStorage 桩可能不实现该方法，
 * 回退到 Object.keys（浏览器下 localStorage 的键会作为自有属性暴露）。
 */
function listStorageKeys(): string[] {
  const keys: string[] = []
  try {
    if (typeof localStorage.length === 'number' && typeof localStorage.key === 'function') {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key) keys.push(key)
      }
    }
  } catch {
    // 落到下面的回退
  }
  if (keys.length > 0) return keys
  try {
    return Object.keys(localStorage)
  } catch {
    return []
  }
}

/** 采集当前设备上所有可同步的键值。 */
export function collectLocalPreferences(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const key of listStorageKeys()) {
    if (!isSyncableKey(key)) continue
    try {
      const value = localStorage.getItem(key)
      if (value !== null && withinValueLimit(value)) entries[key] = value
    } catch {
      // 单项读取失败不影响其余键
    }
  }
  return entries
}

// 服务端两处独立限制（backend-go/internal/aiagent）：
//   - 单值上限 256 KB（store.go maxPreferenceValueBytes）→ 413 preference value too large
//   - 请求体上限 1 MB（service.go decodeJSON 的 io.LimitReader）→ 400 invalid JSON body
// 超限时的截断发生在 JSON 解析之前，报错文案是「invalid JSON body」，与真实原因
// （体积过大）完全不符，极难排查。因此在这里按服务端口径先行拦截：
// 超限的键跳过并保持本地不同步，而不是让整批推送失败、把其它键也一起拖垮。
const MAX_VALUE_BYTES = 256 * 1024
const MAX_BODY_BYTES = 1024 * 1024

export function withinValueLimit(value: string): boolean {
  return byteLength(value) <= MAX_VALUE_BYTES
}

function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length
  } catch {
    return value.length
  }
}

/** 按请求体上限裁剪：超限时按体积从大到小剔除，保证剩余部分仍能成功推送。 */
function trimToBodyLimit(values: Record<string, unknown>): Record<string, unknown> {
  const serialize = (candidate: Record<string, unknown>) =>
    byteLength(JSON.stringify({ values: candidate, updatedAt: new Date().toISOString() }))

  if (serialize(values) <= MAX_BODY_BYTES) return values

  const ordered = Object.entries(values).sort((a, b) => byteLength(JSON.stringify(b[1])) - byteLength(JSON.stringify(a[1])))
  const kept: Record<string, unknown> = { ...values }
  for (const [key] of ordered) {
    delete kept[key]
    if (serialize(kept) <= MAX_BODY_BYTES) break
  }
  return kept
}

interface SyncMeta {
  /** 上次成功同步完成的时间戳（毫秒），用于增量判断。 */
  lastSyncedAt: number
  /** 上次推送的键值指纹，内容未变时跳过上传。 */
  fingerprint: string
  /** 最近一次同步结果，供设置页展示。 */
  lastError?: string
}

function readSyncMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY)
    if (!raw) return { lastSyncedAt: 0, fingerprint: '' }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { lastSyncedAt: 0, fingerprint: '' }
    const record = parsed as Record<string, unknown>
    return {
      lastSyncedAt: typeof record.lastSyncedAt === 'number' ? record.lastSyncedAt : 0,
      fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
      lastError: typeof record.lastError === 'string' ? record.lastError : undefined,
    }
  } catch {
    return { lastSyncedAt: 0, fingerprint: '' }
  }
}

function writeSyncMeta(meta: SyncMeta): void {
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta))
  } catch {
    // ignore
  }
}

export function isSyncEnabled(): boolean {
  try {
    return localStorage.getItem(SYNC_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function setSyncEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(SYNC_ENABLED_KEY, '1')
    } else {
      localStorage.removeItem(SYNC_ENABLED_KEY)
    }
  } catch {
    // ignore
  }
}

export function getSyncMeta(): SyncMeta {
  return readSyncMeta()
}

// ============================================
// Per-key 时间戳（冲突仲裁）
// ============================================

interface StampState {
  /** 每个键本地最后一次内容变化的时间（ISO 字符串）。 */
  stamps: Record<string, string>
  /** 每个键上一次同步时的原始值，用于检测「本次是否被本地修改过」。 */
  known: Record<string, string>
}

function readStampState(): StampState {
  try {
    const raw = localStorage.getItem(SYNC_STAMPS_KEY)
    if (!raw) return { stamps: {}, known: {} }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { stamps: {}, known: {} }
    const record = parsed as Record<string, unknown>
    const stamps: Record<string, string> = {}
    const known: Record<string, string> = {}
    if (record.stamps && typeof record.stamps === 'object') {
      for (const [key, value] of Object.entries(record.stamps as Record<string, unknown>)) {
        if (typeof value === 'string') stamps[key] = value
      }
    }
    if (record.known && typeof record.known === 'object') {
      for (const [key, value] of Object.entries(record.known as Record<string, unknown>)) {
        if (typeof value === 'string') known[key] = value
      }
    }
    return { stamps, known }
  } catch {
    return { stamps: {}, known: {} }
  }
}

function writeStampState(state: StampState): void {
  try {
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

/** 为每个键计算 updatedAt：内容变了的用 now，没变的沿用旧戳（无旧戳才用 now）。 */
function resolveStamps(
  values: Record<string, unknown>,
  known: Record<string, string>,
  stamps: Record<string, string>,
  nowIso: string,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const serialized = JSON.stringify(value)
    const previous = known[key]
    if (previous !== undefined && previous === serialized && stamps[key]) {
      next[key] = stamps[key]
    } else {
      next[key] = nowIso
    }
  }
  return next
}

// ============================================
// 聚合键的合并语义与墓碑
// ============================================

type MergeRule =
  | { kind: 'array'; id: (entry: Record<string, unknown>) => string | null; order?: 'newest' }
  | { kind: 'map-number' }
  /**
   * B 类缺陷 3：对象型键的字段级三方合并。此前这类键走整键 last-write-wins，
   * 设备 A 改字段 x、设备 B 改字段 y 时，后写者会把前者一起覆盖。字段级合并让
   * 两侧不同字段的改动都能保留。fields 为 null 表示合并所有字段。
   */
  | { kind: 'object'; fields?: string[] }

/**
 * 按「键名后缀」识别聚合键，这样裸键（opencode-pinned-sessions）与
 * per-server 分桶键（srv:aiagent:inst_X:opencode-pinned-sessions）走同一套
 * 合并规则。
 *
 * order: 'newest' 表示「顺序」也要跨端同步：成员仍取并集，但排列顺序跟随
 * 较新的一侧（拖拽重排能同步到别的设备）。目前只有项目目录列表需要。
 */
const MERGE_RULES: Record<string, MergeRule> = {
  'opencode-pinned-sessions': {
    kind: 'array',
    id: entry => (typeof entry.sessionId === 'string' ? entry.sessionId : null),
    order: 'newest',
  },
  'opencode-saved-directories': {
    kind: 'array',
    id: entry => (typeof entry.path === 'string' ? entry.path : null),
    order: 'newest',
  },
  'opencode-pinned-messages': {
    kind: 'array',
    id: entry => (typeof entry.sessionId === 'string' ? entry.sessionId : null),
    order: 'newest',
  },
  // 未读「已读水位」：{ [sessionId]: 校准时间戳 }，逐键取最大值（单调、收敛）。
  // 使一端已读后，另一端不会回退成未读。详见数据同步层设计 §10.3 C3。
  'opencode-read-watermarks': {
    kind: 'map-number',
  },
  // 项目「最后用户活动时间」：{ [归一化目录]: 用户消息 time.created }，逐键取最大。
  // 供项目排序与项目行时间使用：新设备登录 pull 一次即可恢复顺序，不必点进会话，
  // 也不依赖 assistant 流式抬高的 time.updated（后者是多项目并行时排序抖动的来源）。
  // 时间戳来自服务端消息创建时间，各端读同一后端即同一值，无需设备身份、不依赖本地钟。
  'opencode-project-last-used': {
    kind: 'map-number',
  },
  // B 类缺陷 3：对象型键字段级合并，避免整键 LWW 互相覆盖。
  'opencode-keybindings': {
    kind: 'object',
  },
}

function keySuffix(key: string): string {
  const separator = key.lastIndexOf(':')
  return separator === -1 ? key : key.slice(separator + 1)
}

function mergeRuleFor(key: string): MergeRule | undefined {
  return MERGE_RULES[keySuffix(key)]
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

type TombstoneState = Record<string, Record<string, number>>

function readTombstones(now = Date.now()): TombstoneState {
  let state: TombstoneState = {}
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const record = asRecord(parsed)
      if (record) {
        for (const [key, entries] of Object.entries(record)) {
          const list = asRecord(entries)
          if (!list) continue
          const kept: Record<string, number> = {}
          for (const [id, at] of Object.entries(list)) {
            if (typeof at === 'number' && Number.isFinite(at) && now - at < TOMBSTONE_TTL_MS) kept[id] = at
          }
          if (Object.keys(kept).length > 0) state[key] = kept
        }
      }
    }
  } catch {
    state = {}
  }
  return state
}

function writeTombstones(state: TombstoneState): void {
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

function readSnapshot(): Record<string, unknown> | null {
  try {
    const snapshot = readStampState().known[SNAPSHOT_KEY]
    if (!snapshot) return null
    return asRecord(JSON.parse(snapshot))
  } catch {
    return null
  }
}

/**
 * 找出本地发生了删除的条目并写入墓碑。
 *
 * 判定依据是「上一次同步时的条目集合」减去「当前条目集合」：并在该差集上，
 * 因此 A 端新增一条、B 端删除另一条时只记录删除项，不会误伤新增项。
 */
function mergeRuleKeysFromSnapshot(): string[] {
  const snapshot = readSnapshot()
  const keys = new Set<string>()
  for (const key of listStorageKeys()) {
    if (mergeRuleFor(key)) keys.add(key)
  }
  if (snapshot) {
    for (const key of Object.keys(snapshot)) {
      if (mergeRuleFor(key)) keys.add(key)
    }
  }
  return [...keys]
}

function recordTombstones(entries: Record<string, string>, state: TombstoneState): TombstoneState {
  const now = Date.now()
  const snapshot = readSnapshot()
  for (const key of mergeRuleKeysFromSnapshot()) {
    const rule = mergeRuleFor(key)
    if (!rule) continue
    const previousIds = entryIds(parseJson(typeof snapshot?.[key] === 'string' ? (snapshot[key] as string) : ''), rule)
    if (previousIds.size === 0) continue
    const currentIds = entryIds(parseJson(entries[key] ?? ''), rule)
    const bucket = state[key] ?? {}
    for (const id of previousIds) {
      if (!currentIds.has(id) && id) bucket[id] = now
    }
    if (Object.keys(bucket).length > 0) state[key] = bucket
  }
  return state
}

function entryIds(value: unknown, rule: MergeRule): Set<string> {
  const ids = new Set<string>()
  if (value === undefined || value === null) return ids
  if (rule.kind === 'array') {
    if (!Array.isArray(value)) return ids
    for (const item of value) {
      const record = asRecord(item)
      if (!record) continue
      const id = rule.id(record)
      if (id) ids.add(id)
    }
    return ids
  }
  const record = asRecord(value)
  if (!record) return ids
  for (const key of Object.keys(record)) ids.add(key)
  return ids
}

// ============================================
// 采集 / 拉取 / 推送
// ============================================

/** 稳定的内容指纹：键排序后拼接，用于判断是否需要上传。 */
function fingerprint(entries: Record<string, string>): string {
  const keys = Object.keys(entries).sort()
  let hash = 2166136261
  for (const key of keys) {
    const line = `${key}=${entries[key]}`
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  }
  return `${keys.length}:${(hash >>> 0).toString(16)}`
}

interface ServerPreferenceItem {
  key: string
  value: unknown
  updatedAt: string
}

interface MergeResult {
  value: unknown
  changed: boolean
}

/**
 * 三方合并：base（上次同步基线）、local（当前本地）、server（当前服务端）。
 *
 * 为什么必须带 base：只比较 local 与 server 无法区分两种完全相反的情况 ——
 *   - 「本地有、服务端没有」既可能是本地新增（要保留），也可能是远端刚删除（要跟随删除）
 *   - 「服务端有、本地没有」既可能是远端新增（要采纳），也可能是本地刚删除（不能复活）
 * 没有 base 时只能猜，猜错就会出现「删除被复活」或「新增被丢弃」。
 *
 * base 就是 known[__snapshot__]（上次同步完成时的状态），所以不需要额外存储。
 *
 * 每条目按 id 归类（与 Git 三方合并同构，把「删除」也当成一种改动）：
 *   - base 有、local 无           → 本地删除，不复活（写墓碑）
 *   - base 有、local 有、server 无 → 远端删除，本地跟随删除
 *   - base 无、local 有           → 本地新增，保留
 *   - base 无、server 有          → 远端新增，采纳
 *   - base 有、两侧都还在         → 两侧都没删，保留（内容取较新的一侧）
 *   - base 无、两侧都无           → 不存在，忽略
 */
function threeWayMergeIds(
  baseIds: Set<string>,
  localIds: Set<string>,
  serverIds: Set<string>,
  dead: Set<string>,
): Set<string> {
  const keep = new Set<string>()
  const all = new Set<string>([...baseIds, ...localIds, ...serverIds])

  for (const id of all) {
    if (!id) continue
    // 墓碑是显式的删除意图：基线可能已过期或缺失（例如新设备首次同步、
    // 快照被清），此时只有墓碑能证明「这条被用户删过」。本地重新添加会清除
    // 墓碑（见 clearResurrectedTombstones），因此这里排除不会挡住重新添加。
    if (dead.has(id)) continue
    const inBase = baseIds.has(id)
    const inLocal = localIds.has(id)
    const inServer = serverIds.has(id)

    // 本地删除了（基线有、本地没有）：本地意图优先，不复活。
    if (inBase && !inLocal) continue
    // 远端删除了（基线有、服务端没有、本地还在）：跟随远端删除。
    if (inBase && !inServer) continue
    // 本地新增，或两侧都还在：保留。
    if (inLocal) {
      keep.add(id)
      continue
    }
    // 纯远端新增（基线没有、本地没有、服务端有）：采纳。
    if (inServer && !inBase) keep.add(id)
  }
  return keep
}

/**
 * 按聚合规则做三方合并。任一侧解析失败时返回 changed=false，
 * 交由调用方按「新者胜」的普通键逻辑处理。
 */
function mergeSyncValue(
  rule: MergeRule,
  baseRaw: string | null,
  localRaw: string | null,
  serverValue: unknown,
  dead: Set<string>,
  serverNewer = false,
): MergeResult {
  if (rule.kind === 'array') {
    const baseList = Array.isArray(parseJson(baseRaw ?? '')) ? (parseJson(baseRaw ?? '') as unknown[]) : []
    const localValue = localRaw === null ? undefined : parseJson(localRaw)
    const localList = Array.isArray(localValue) ? localValue : null
    const serverList = Array.isArray(serverValue) ? serverValue : null
    if (localList === null || serverList === null) return { value: undefined, changed: false }

    const keep = threeWayMergeIds(entryIds(baseList, rule), entryIds(localList, rule), entryIds(serverList, rule), dead)

    const localById = new Map<string, Record<string, unknown>>()
    for (const item of localList) {
      const record = asRecord(item)
      if (!record) continue
      const id = rule.id(record)
      if (id) localById.set(id, record)
    }
    const serverById = new Map<string, Record<string, unknown>>()
    for (const item of serverList) {
      const record = asRecord(item)
      if (!record) continue
      const id = rule.id(record)
      if (id) serverById.set(id, record)
    }

    // order: 'newest' 时，排列顺序跟随较新的一侧；否则沿用「本地顺序 + 服务端新增」。
    // 重复 id 的内容仍优先取本地那条（不让服务端的旧副本覆盖本地名称等字段）。
    const orderSource = rule.order === 'newest' && serverNewer ? serverList : localList
    const merged: Record<string, unknown>[] = []
    const seen = new Set<string>()
    const push = (record: Record<string, unknown>) => {
      const id = rule.id(record)
      if (!id || seen.has(id) || !keep.has(id)) return
      seen.add(id)
      merged.push(localById.get(id) ?? record)
    }
    for (const item of orderSource) {
      const record = asRecord(item)
      if (record) push(record)
    }
    for (const item of [...localList, ...serverList]) {
      const record = asRecord(item)
      if (record) push(record)
    }
    return { value: merged, changed: true }
  }

  const baseMap = asRecord(parseJson(baseRaw ?? ''))
  const localMap = localRaw === null ? null : asRecord(parseJson(localRaw))
  const serverMap = asRecord(serverValue)
  if (localMap === null || serverMap === null) return { value: undefined, changed: false }

  // B 类缺陷 3：对象键字段级三方合并。逐字段按三方合并决定取舍，两侧改不同字段
  // 时都能保留；同字段冲突才按「新者胜」。
  if (rule.kind === 'object') {
    const fieldNames = rule.fields ?? [
      ...new Set([...Object.keys(baseMap ?? {}), ...Object.keys(localMap), ...Object.keys(serverMap)]),
    ]
    const merged: Record<string, unknown> = {}
    for (const field of fieldNames) {
      const inBase = baseMap ? field in baseMap : false
      const inLocal = field in localMap
      const inServer = field in serverMap
      const baseVal = baseMap?.[field]
      const localVal = localMap[field]
      const serverVal = serverMap[field]
      const localChanged = !inBase || JSON.stringify(localVal) !== JSON.stringify(baseVal)
      const serverChanged = !inBase || JSON.stringify(serverVal) !== JSON.stringify(baseVal)

      // 本地删除了该字段（基线有、本地无）
      if (inBase && !inLocal) continue
      // 远端删除了该字段（基线有、服务端无、本地未改）
      if (inBase && !inServer && !localChanged) continue
      // 本地改过：本地优先
      if (inLocal && localChanged) {
        merged[field] = localVal
        continue
      }
      // 服务端改过：采用服务端
      if (inServer && serverChanged) {
        merged[field] = serverVal
        continue
      }
      // 都没改：保留存在的一侧
      if (inLocal) merged[field] = localVal
      else if (inServer) merged[field] = serverVal
    }
    return { value: merged, changed: true }
  }

  const keep = threeWayMergeIds(entryIds(baseMap, rule), entryIds(localMap, rule), entryIds(serverMap, rule), dead)

  const merged: Record<string, number> = {}
  for (const [path, at] of Object.entries(serverMap)) {
    if (!keep.has(path)) continue
    if (typeof at === 'number' && Number.isFinite(at)) merged[path] = at
  }
  for (const [path, at] of Object.entries(localMap)) {
    if (!keep.has(path)) continue
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    const existing = merged[path]
    if (existing === undefined || at > existing) merged[path] = at
  }
  return { value: merged, changed: true }
}

/**
 * 拉取服务端偏好并写入本地。返回写入的键数量。
 *
 * 普通键：服务端逐键 updatedAt 不早于本地戳才覆盖本地；本地没有戳视为
 * 首次同步，直接用服务端值。
 * 聚合键：以「本地当前值」而非「上次同步快照」参与合并，本地已删除的条目
 * 才会被识别为删除（若拿快照合并，本地删掉的条目会随快照再次进入并集）。
 * 墓碑：本地已删除与「服务端本次仍未包含」的条目都会记成墓碑，防止复活。
 */
export async function pullPreferences(account?: AiAgentAccount | null): Promise<number> {
  const current = account ?? readAccount()
  if (!current) throw new Error('尚未登录')

  // 带 ETag 的条件请求：服务端内容未变时回 304（零响应体），直接跳过合并。
  const cachedEtag = readPullEtag(current)
  const meta = await accountRequestWithMeta<ServerPreferenceItem[]>(
    current,
    '/api/aiagent/preferences',
    cachedEtag ? { headers: { 'If-None-Match': cachedEtag } } : undefined,
  )
  if (meta.etag) writePullEtag(current, meta.etag)
  if (meta.notModified) {
    // 304：服务端内容与上次拉取完全一致，无需合并，但快照仍要跟上本地当前值。
    // 否则快照会停留在更早的基线，下一轮把「本地已删除、服务端仍在」的条目
    // 误判成新增，墓碑判定也会滞后一轮。
    writeStampState({
      stamps: readStampState().stamps,
      known: { ...readStampState().known, [SNAPSHOT_KEY]: JSON.stringify(collectLocalPreferences()) },
    })
    return 0
  }
  const items = meta.data
  if (!Array.isArray(items)) return 0

  const stampState = readStampState()
  const now = Date.now()
  const tombstones = readTombstones(now)
  const stamps = { ...stampState.stamps }
  const known = { ...stampState.known }

  let written = 0
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !isSyncableKey(item.key)) continue
    const key = item.key
    const serverIso = typeof item.updatedAt === 'string' ? item.updatedAt : ''
    const serverAt = Date.parse(serverIso)
    const localStamp = Date.parse(stamps[key] ?? '')

    const rule = mergeRuleFor(key)
    if (rule) {
      const localRaw = localStorage.getItem(key)
      const snapshot = asRecord(parseJson(known[SNAPSHOT_KEY] ?? ''))
      const snapshotRaw = snapshot?.[key]
      const baseRaw = typeof snapshotRaw === 'string' ? snapshotRaw : null

      // 本地相对基线消失的条目 → 记墓碑，防止它从服务端被再次带回来。
      const bucket = tombstones[key] ?? {}
      const baseIds = entryIds(parseJson(baseRaw ?? ''), rule)
      const localIds = entryIds(parseJson(localRaw ?? ''), rule)
      for (const id of baseIds) {
        if (!localIds.has(id) && id) bucket[id] = now
      }
      // 只有「本地条目比墓碑更新」才说明用户是删除后又重新添加，此时清除墓碑。
      //
      // 不能见到本地存在就清墓碑：正常拉取时该条目本来就还在本地（删除意图尚未
      // 传出去），无条件清除会让墓碑在起作用之前就被销毁，已删条目随即被服务端
      // 的旧值复活 —— 表现为「删除看起来同步了，其实又回来了」。
      if (rule.kind === 'array') {
        const localList = Array.isArray(parseJson(localRaw ?? '')) ? (parseJson(localRaw ?? '') as unknown[]) : []
        for (const entry of localList) {
          const record = asRecord(entry)
          if (!record) continue
          const id = rule.id(record)
          if (!id || !(id in bucket)) continue
          const addedAt = typeof record.addedAt === 'number' ? record.addedAt : 0
          if (addedAt > bucket[id]) delete bucket[id]
        }
      }
      if (Object.keys(bucket).length > 0) tombstones[key] = bucket

      // 三方合并：base 是上次同步基线，用来区分「本地新增」与「远端删除」、
      // 「远端新增」与「本地删除」。没有 base 时这两对无法区分，删除会被复活。
      //
      // serverNewer：用于 order: 'newest' 的聚合键（项目目录、置顶会话/消息）决定
      // 排列顺序跟随哪一侧。要求「本地相对基线没变」（没有尚未上传的本地改动）
      // 且服务端时间戳严格更新；否则本地顺序优先，避免把本地刚拖拽的结果冲掉。
      const localChanged = baseRaw !== null && localRaw !== baseRaw
      const serverNewer =
        !localChanged && Number.isFinite(serverAt) && Number.isFinite(localStamp) && serverAt > localStamp
      const dead = new Set(Object.keys(bucket))
      const merged = mergeSyncValue(rule, baseRaw, localRaw, item.value, dead, serverNewer)
      if (merged.changed) {
        const raw = JSON.stringify(merged.value)
        try {
          if (localStorage.getItem(key) !== raw) {
            localStorage.setItem(key, raw)
            written += 1
          }
          known[key] = raw
          stamps[key] = new Date(Math.max(Number.isFinite(serverAt) ? serverAt : 0, Date.now())).toISOString()
        } catch {
          // 单项写入失败不影响其余键
        }
        continue
      }
    }

    const value = typeof item.value === 'string' ? item.value : JSON.stringify(item.value)
    if (typeof value !== 'string') continue

    // 本地相对上次同步基线发生了变化，说明这是一次尚未上传的本地改动。
    //
    // 必须让本地胜出，不能拿服务端值覆盖：syncPreferences 是先 pull 后 push，
    // 本地戳要等 push 才刷新，此刻仍停在上一轮同步时间，服务端的 updatedAt 与它
    // 相等或更晚，时间戳比较挡不住。典型表现是「打开侧栏后被同步折叠回去」——
    // 用户刚写下的 true 被服务端上一轮的 false 盖掉。
    //
    // 仅在基线存在且与本地不一致时判定（首次同步 known 为空，此时无从区分
    // 「本地默认值」与「用户改动」，沿用服务端胜出的既有语义）。
    const localRaw = localStorage.getItem(key)
    if (known[key] !== undefined && localRaw !== null && localRaw !== known[key]) continue

    if (localStamp && Number.isFinite(serverAt) && serverAt < localStamp) continue
    try {
      if (localRaw === value) continue
      localStorage.setItem(key, value)
      written += 1
    } catch {
      // 单项写入失败不影响其余键
    }
    known[key] = value
    if (serverIso) stamps[key] = serverIso
  }

  writeTombstones(tombstones)
  writeStampState({ stamps, known: { ...known, [SNAPSHOT_KEY]: JSON.stringify(collectLocalPreferences()) } })
  // 拉取是「从外部写入 localStorage」：React 状态不会自动感知，必须显式通知
  // 订阅者重新读取，否则 UI 停在初始化快照上。
  if (written > 0) {
    notifyPerServerStorageChanged()
    // layoutStore 管着一批只读一次的偏好（侧栏排序、开关等），它们不走
    // per-server 存储，需要单独触发重读，否则表现为「另一台改了排序，这边要
    // 切换主机才生效」。
    layoutStore.reloadFromStorage()
    // 已读水位是裸键（opencode-read-watermarks），同样不经 per-server 存储；
    // 拉取到另一端的已读后必须让水位 store 重读，否则本端未读点不会消失。
    readWatermarkStore.reload()
    // 项目「最后活动时间」水位同理：拉取到另一端的活动时间后重读，未点开的项目
    // 顺序/时间才立即对齐（否则要等点进会话或流式抬高 time.updated）。
    sessionActivityStore.reload()
  }
  return written
}

/**
 * 推送本地偏好到服务端。返回实际写入的键数量。
 *
 * 值统一按「原始字符串」推送：能解析成 JSON 的就推解析后的结构，不能解析的
 * 推原始字符串。时间戳按 per-key 计算（只有本地改过的键才刷新），并带
 * lastWriteWins=1 让服务端逐键比较，避免旧数据顶掉新数据。
 */
export async function pushPreferences(account?: AiAgentAccount | null, force = false): Promise<number> {
  const current = account ?? readAccount()
  if (!current) throw new Error('尚未登录')

  const entries = collectLocalPreferences()
  const currentFingerprint = fingerprint(entries)
  const meta = readSyncMeta()
  if (!force && currentFingerprint === meta.fingerprint) {
    return 0
  }

  const stampState = readStampState()
  const tombstones = recordTombstones(entries, readTombstones())
  const mergedEntries = { ...entries }
  for (const key of mergeRuleKeysFromSnapshot()) {
    const raw = entries[key]
    if (raw === undefined) continue
    const rule = mergeRuleFor(key)
    if (!rule) continue
    const value = parseJson(raw)
    if (value === undefined || value === null) continue
    const dead = new Set(Object.keys(tombstones[key] ?? {}))
    if (rule.kind === 'array') {
      if (!Array.isArray(value)) continue
      mergedEntries[key] = JSON.stringify(
        value.filter(entry => {
          const record = asRecord(entry)
          if (!record) return false
          const id = rule.id(record)
          return !id || !dead.has(id)
        }),
      )
    } else {
      const record = asRecord(value)
      if (!record) continue
      const cleaned: Record<string, unknown> = {}
      for (const [path, at] of Object.entries(record)) {
        if (!dead.has(path)) cleaned[path] = at
      }
      mergedEntries[key] = JSON.stringify(cleaned)
    }
  }

  const values: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(mergedEntries)) {
    try {
      values[key] = JSON.parse(raw)
    } catch {
      values[key] = raw
    }
  }

  const nowIso = syncNowIso()
  const updatedAt = resolveStamps(values, stampState.known, stampState.stamps, nowIso)

  // 服务端拒绝空 values（返回 400 "values required"）。本地没有任何可同步键时
  // 直接跳过推送，但仍要落本地状态，否则每轮轮询都会重新尝试并报错。
  // 注意 stamps 要沿用原有记录而非写入空对象 —— 否则下次有键变更时会被误判为
  // 「首次同步」，全体键的时间戳都被刷新，破坏 lastWriteWins 的增量语义。
  if (Object.keys(values).length === 0) {
    const known = { ...stampState.known }
    known[SNAPSHOT_KEY] = JSON.stringify(collectLocalPreferences())
    writeStampState({ stamps: stampState.stamps, known })
    writeTombstones(tombstones)
    writeSyncMeta({
      lastSyncedAt: Date.now(),
      fingerprint: fingerprint(collectLocalPreferences()),
    })
    return 0
  }

  const result = await accountRequest<{ written?: string[] }>(
    current,
    '/api/aiagent/preferences?lastWriteWins=1',
    {
      method: 'PUT',
      body: JSON.stringify({ values: trimToBodyLimit(values), updatedAt }),
    },
  )

  const known = { ...stampState.known }
  for (const [key, value] of Object.entries(values)) {
    known[key] = JSON.stringify(value)
    if (mergedEntries[key] !== entries[key]) {
      try {
        localStorage.setItem(key, mergedEntries[key])
      } catch {
        // ignore
      }
    }
  }
  known[SNAPSHOT_KEY] = JSON.stringify(collectLocalPreferences())
  writeStampState({ stamps: updatedAt, known })
  writeTombstones(tombstones)

  writeSyncMeta({
    lastSyncedAt: Date.now(),
    fingerprint: fingerprint(collectLocalPreferences()),
  })
  return Array.isArray(result?.written) ? result.written.length : Object.keys(values).length
}

/**
 * 双向同步：先拉取服务端偏好到本地并合并，再推送本地偏好。
 * 拉取会写入逐键时间戳，因此推送时未被本地改动的键沿用服务端时间戳。
 */
export async function syncPreferences(account?: AiAgentAccount | null, force = false): Promise<{ pulled: number; pushed: number }> {
  const current = account ?? readAccount()
  if (!current) throw new Error('尚未登录')
  try {
    const pulled = await pullPreferences(current)
    const pushed = await pushPreferences(current, force)
    return { pulled, pushed }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const meta = readSyncMeta()
    writeSyncMeta({ ...meta, lastError: message })
    throw error
  }
}

export const PreferencesSyncApi = {
  isSyncEnabled,
  setSyncEnabled,
  getSyncMeta,
  collectLocalPreferences,
  isSyncableKey,
  pullPreferences,
  pushPreferences,
  syncPreferences,
}

export default PreferencesSyncApi
