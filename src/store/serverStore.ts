// ============================================
// Server Store - 多后端服务器配置管理
// ============================================

import { API_BASE_URL } from '../constants'
import { isTauri } from '../utils/tauri'
import i18n from '../i18n'

// Tauri plugin-http fetch 缓存（避免重复 dynamic import）
let _tauriFetch: typeof globalThis.fetch | null = null
let _tauriFetchLoading: Promise<typeof globalThis.fetch> | null = null

export async function getUnifiedFetch(): Promise<typeof globalThis.fetch> {
  if (!isTauri()) return globalThis.fetch
  if (_tauriFetch) return _tauriFetch
  if (_tauriFetchLoading) return _tauriFetchLoading
  _tauriFetchLoading = import('@tauri-apps/plugin-http').then(mod => {
    _tauriFetch = mod.fetch as unknown as typeof globalThis.fetch
    return _tauriFetch
  })
  return _tauriFetchLoading
}

/**
 * 服务器认证信息
 */
export interface ServerAuth {
  username: string // 用户名 (默认 opencode)
  password: string // 密码
  token?: string // 模块令牌（AI Agent 网关）：存在时优先使用 Bearer
}

/**
 * 服务器配置
 */
export interface ServerConfig {
  id: string // 唯一标识
  name: string // 显示名称
  url: string // 服务器 URL (不含尾部斜杠)
  isDefault?: boolean // 是否为默认服务器
  /**
   * 是否启用。停用后不建立连接、不参与事件订阅，也不出现在侧栏会话分组里，
   * 但保留配置（区别于「删除」）。缺省视为启用，兼容旧数据。
   */
  enabled?: boolean
  auth?: ServerAuth // 认证信息 (可选)
}

/**
 * 服务器健康状态
 */
export interface ServerHealth {
  status: 'checking' | 'online' | 'offline' | 'error' | 'unauthorized'
  latency?: number // 响应延迟 (ms)
  lastCheck?: number // 上次检查时间戳
  error?: string // 错误信息
  details?: string // 原始诊断信息
  version?: string // 服务器版本
}

export interface ServerSettingsBackup {
  servers: ServerConfig[]
  activeServerId: string | null
}

interface ServerClockCalibration {
  serverTimestamp: number
  calibratedAtMonotonic: number
}

type Listener = () => void
export type ServerChangeReason = 'server-switch' | 'local-runtime-url'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeConnectionError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return i18n.t('settings:servers.connectionTimedOut')
  if (!(err instanceof Error)) return i18n.t('settings:servers.connectionFailed')

  const message = err.message || i18n.t('settings:servers.connectionFailed')
  if (/certificate|cert|tls|ssl/i.test(message)) {
    return i18n.t('settings:servers.tlsError', { message })
  }
  return message
}

function redactHeaderValue(key: string, value: string): string {
  return /set-cookie|authorization|proxy-authorization/i.test(key) ? '<redacted>' : value
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = redactHeaderValue(key, value)
  })
  return result
}

function truncateForDiagnostics(value: string, maxLength = 5000): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`
}

function formatResponseDiagnostics(options: {
  url: string
  response: Response
  latency: number
  body: string
}): string {
  const contentType = options.response.headers.get('content-type') ?? ''
  return [
    `Request: GET ${options.url}`,
    `Status: ${options.response.status}${options.response.statusText ? ` ${options.response.statusText}` : ''}`,
    `Latency: ${options.latency}ms`,
    `Content-Type: ${contentType || '(none)'}`,
    `Headers:\n${JSON.stringify(headersToRecord(options.response.headers), null, 2)}`,
    `Body (${options.body.length} chars):\n${truncateForDiagnostics(options.body)}`,
  ].join('\n\n')
}

function formatExceptionDiagnostics(url: string, err: unknown): string {
  if (!(err instanceof Error)) return `Request: GET ${url}\n\nError: ${String(err)}`

  const cause = 'cause' in err && err.cause !== undefined ? `\n\nCause:\n${String(err.cause)}` : ''
  return [
    `Request: GET ${url}`,
    `Error name: ${err.name}`,
    `Message: ${err.message}`,
    err.stack ? `Stack:\n${err.stack}` : '',
  ]
    .filter(Boolean)
    .join('\n\n') + cause
}

const STORAGE_KEY = 'opencode-servers'
const ACTIVE_SERVER_KEY = 'opencode-active-server'
export const LOCAL_SERVER_ID = 'local'

/**
 * Server Store
 * 管理多个 OpenCode 后端服务器配置
 */
class ServerStore {
  private servers: ServerConfig[] = []
  private activeServerId: string | null = null
  private healthMap = new Map<string, ServerHealth>()
  private healthCheckSeqMap = new Map<string, number>()
  /** 每台服务器的在途健康检查：并发触发只发一次网络 */
  private healthInflight = new Map<string, Promise<ServerHealth>>()
  private clockCalibrationMap = new Map<string, ServerClockCalibration>()
  private listeners: Set<Listener> = new Set()
  private localServerUrlOverride: string | null = null

  // server 切换监听器（用于触发 SSE 重连等副作用，避免循环依赖）
  private serverChangeListeners: Set<(newServerId: string, reason: ServerChangeReason) => void> = new Set()

  // 快照缓存 (用于 useSyncExternalStore)
  private _serversSnapshot: ServerConfig[] = []
  private _activeServerSnapshot: ServerConfig | null = null
  private _healthMapSnapshot: Map<string, ServerHealth> = new Map()

  // 默认本地服务器 ID
  private readonly DEFAULT_SERVER_ID = LOCAL_SERVER_ID

  constructor() {
    this.loadFromStorage()
    this.updateSnapshots()
  }

  // ============================================
  // Storage
  // ============================================

  private loadFromStorage(): void {
    try {
      // 加载服务器列表
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed: unknown = JSON.parse(stored)
        // 存储可能被写坏（对象、null、字符串等），非数组一律回退到默认服务器。
        // 逐项过滤缺少必要字段的条目，避免 .find()/.map() 在损坏数据上抛错后无法自愈。
        // 与 normalizeServerBackup 共用 isValidServerConfig，保证两条路径校验一致。
        this.servers = Array.isArray(parsed) ? parsed.filter(isValidServerConfig) : []
      }

      // 如果没有服务器，添加默认的本地服务器
      if (this.servers.length === 0) {
        this.servers = [
          {
            id: this.DEFAULT_SERVER_ID,
            name: 'Local',
            url: API_BASE_URL,
            isDefault: true,
          },
        ]
      }

      // 加载当前选中的服务器
      // 优先从 sessionStorage 读取（per-window 隔离，刷新保持）
      // 回退到 localStorage（新窗口首次打开时继承上次默认）
      const activeId = sessionStorage.getItem(ACTIVE_SERVER_KEY) ?? localStorage.getItem(ACTIVE_SERVER_KEY)
      if (activeId && this.servers.some(s => s.id === activeId)) {
        this.activeServerId = activeId
      } else {
        // 默认选中第一个
        this.activeServerId = this.servers[0]?.id ?? null
      }
    } catch {
      // 初始化默认值
      this.servers = [
        {
          id: this.DEFAULT_SERVER_ID,
          name: 'Local',
          url: API_BASE_URL,
          isDefault: true,
        },
      ]
      this.activeServerId = this.DEFAULT_SERVER_ID
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.servers))
      if (this.activeServerId) {
        // 写入 sessionStorage（当前窗口刷新保持）+ localStorage（新窗口默认值）
        sessionStorage.setItem(ACTIVE_SERVER_KEY, this.activeServerId)
        localStorage.setItem(ACTIVE_SERVER_KEY, this.activeServerId)
      }
    } catch {
      // ignore
    }
  }

  // ============================================
  // Subscription
  // ============================================

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 注册 active server 入口变化监听器（server id 切换或 active local runtime URL 变化）。
   * 返回取消注册函数。
   */
  onServerChange(fn: (newServerId: string, reason: ServerChangeReason) => void): () => void {
    this.serverChangeListeners.add(fn)
    return () => this.serverChangeListeners.delete(fn)
  }

  private notifyServerChange(serverId: string, reason: ServerChangeReason): void {
    this.serverChangeListeners.forEach(fn => {
      fn(serverId, reason)
    })
  }

  private notify(): void {
    this.updateSnapshots()
    this.listeners.forEach(l => {
      l()
    })
  }

  /**
   * 更新快照缓存
   */
  private updateSnapshots(): void {
    this._serversSnapshot = this.servers.map(server => this.withRuntimeServerUrl(server))
    this._activeServerSnapshot = this._serversSnapshot.find(s => s.id === this.activeServerId) ?? null
    this._healthMapSnapshot = new Map(this.healthMap)
  }

  private withRuntimeServerUrl(server: ServerConfig): ServerConfig {
    if (server.id === this.DEFAULT_SERVER_ID && this.localServerUrlOverride) {
      return { ...server, url: this.localServerUrlOverride }
    }
    return server
  }

  // ============================================
  // Getters
  // ============================================

  /**
   * 获取所有服务器配置 (返回缓存快照)
   */
  getServers(): ServerConfig[] {
    return this._serversSnapshot
  }

  getStoredServers(): ServerConfig[] {
    return [...this.servers]
  }

  /**
   * 服务器是否启用。
   * 缺省（undefined）视为启用，兼容未写入该字段的旧数据。
   */
  isServerEnabled(serverId: string): boolean {
    const server = this.servers.find(s => s.id === serverId)
    return server ? server.enabled !== false : false
  }

  /** 获取所有启用的服务器（建立连接、事件订阅、侧栏分组的依据） */
  getEnabledServers(): ServerConfig[] {
    return this.servers.filter(s => s.enabled !== false)
  }

  /**
   * 启用/停用一台服务器。
   *
   * 停用的若是当前活动服务器，必须同时切到另一台已启用的：
   * getActiveServerId() 有 `?? DEFAULT_SERVER_ID` 的兜底，会一直返回被停用的 id，
   * 而连接集合已把它排除 —— 不切走就会出现「活动服务器没连接」的空转状态。
   *
   * @returns 成功返回 true；无其它已启用服务器可切换时返回 false（不改动）
   */
  setServerEnabled(id: string, enabled: boolean): boolean {
    const index = this.servers.findIndex(s => s.id === id)
    if (index === -1) return false
    const server = this.servers[index]
    if ((server.enabled !== false) === enabled) return true

    let nextActiveId: string | null = null
    if (!enabled && this.getActiveServerId() === id) {
      const fallback = this.servers.find(s => s.id !== id && s.enabled !== false)
      // 没有可切换的目标时拒绝停用，避免把面板置于无后端可用
      if (!fallback) return false
      nextActiveId = fallback.id
    }

    this.servers[index] = { ...server, enabled }
    if (nextActiveId) {
      this.activeServerId = nextActiveId
      this.saveToStorage()
      this.notify()
      this.notifyServerChange(nextActiveId, 'server-switch')
      return true
    }
    this.saveToStorage()
    this.notify()
    return true
  }

  /**
   * 整体替换服务器列表并同步内存状态。
   *
   * 与 layoutStore.replaceState / updateStore.applyImportedSettings 等保持一致：
   * 只写 localStorage 会让 UI 与再次导出继续读到旧值。
   */
  replaceServers(servers: ServerConfig[], activeServerId: string | null): void {
    this.servers = servers
    this.activeServerId = activeServerId
    this.notify()
  }

  /**
   * 获取当前活动服务器 (返回缓存快照)
   */
  getActiveServer(): ServerConfig | null {
    return this._activeServerSnapshot
  }

  getLocalServer(): ServerConfig | null {
    return this._serversSnapshot.find(s => s.id === this.DEFAULT_SERVER_ID) ?? null
  }

  getLocalServerUrl(): string {
    return this.getLocalServer()?.url ?? API_BASE_URL
  }

  /**
   * 获取指定服务器（含 runtime URL override）的 base URL
   */
  getServerBaseUrl(serverId: string): string {
    const server = this.servers.find(s => s.id === serverId)
    return server ? this.withRuntimeServerUrl(server).url : API_BASE_URL
  }

  /**
   * 获取指定服务器（含 runtime URL override）
   */
  getServer(serverId: string): ServerConfig | null {
    const server = this.servers.find(s => s.id === serverId)
    return server ? this.withRuntimeServerUrl(server) : null
  }

  isActiveLocalServer(): boolean {
    return this.getActiveServerId() === this.DEFAULT_SERVER_ID
  }

  /**
   * 获取当前活动服务器 ID（用于 per-server storage 等场景）
   * 返回 'local' 作为默认值，保证永远有值
   */
  getActiveServerId(): string {
    return this.activeServerId ?? this.DEFAULT_SERVER_ID
  }

  /**
   * 获取当前 API Base URL
   */
  getActiveBaseUrl(): string {
    const server = this.getActiveServer()
    return server?.url ?? API_BASE_URL
  }

  /**
   * 获取当前活动服务器的认证信息
   */
  getActiveAuth(): ServerAuth | null {
    const server = this.getActiveServer()
    return server?.auth ?? null
  }

  /**
   * 获取指定服务器的认证信息
   */
  getServerAuth(serverId: string): ServerAuth | null {
    const server = this.servers.find(s => s.id === serverId)
    return server?.auth ?? null
  }

  /**
   * 获取服务器健康状态
   */
  getHealth(serverId: string): ServerHealth | null {
    return this.healthMap.get(serverId) ?? null
  }

  /**
   * 获取所有服务器的健康状态 (返回缓存快照)
   */
  getAllHealth(): Map<string, ServerHealth> {
    return this._healthMapSnapshot
  }

  getActiveCalibratedNow(): number | undefined {
    return this.getCalibratedNow(this.getActiveServerId())
  }

  /**
   * 指定服务器的校准时钟。
   *
   * 只提供「活动服务器」的版本会让跨主机的比较错位：同一会话的通知在 A 端用
   * A 的时钟打戳、B 端用 B 的时钟打戳，而两台机器的时钟并不相同。已读水位要
   * 跨端比较，就必须统一到「会话所属主机」的时钟上。
   */
  getCalibratedNow(serverId: string): number | undefined {
    const calibration = this.clockCalibrationMap.get(serverId)
    if (!calibration) return undefined
    return calibration.serverTimestamp + (performance.now() - calibration.calibratedAtMonotonic)
  }

  // ============================================
  // Mutations
  // ============================================

  /**
   * 添加服务器
   */
  addServer(config: Omit<ServerConfig, 'id'>): ServerConfig {
    const id = `server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return this.addServerWithId(id, config)
  }

  /**
   * 以指定 ID 添加（或覆盖）服务器。
   * 供外部集成（如 AI Agent 账号）使用稳定的服务器 ID，便于跨会话同步与移除。
   */
  addServerWithId(id: string, config: Omit<ServerConfig, 'id'>): ServerConfig {
    const normalizedUrl = config.url.replace(/\/+$/, '')
    const existingIndex = this.servers.findIndex(server => server.id === id)
    if (existingIndex !== -1) {
      this.servers[existingIndex] = { ...this.servers[existingIndex], ...config, id, url: normalizedUrl }
      this.saveToStorage()
      this.notify()
      return this.servers[existingIndex]
    }
    const server: ServerConfig = {
      ...config,
      id,
      url: normalizedUrl, // 移除尾部斜杠
    }
    this.servers.push(server)
    this.saveToStorage()
    this.notify()
    return server
  }

  /**
   * 更新服务器配置
   */
  updateServer(id: string, updates: Partial<Omit<ServerConfig, 'id'>>): boolean {
    const index = this.servers.findIndex(s => s.id === id)
    if (index === -1) return false

    const server = this.servers[index]
    this.servers[index] = {
      ...server,
      ...updates,
      id: server.id, // 确保 id 不被覆盖
      url: updates.url ? updates.url.replace(/\/+$/, '') : server.url,
    }
    if (id === this.DEFAULT_SERVER_ID && updates.url) {
      this.localServerUrlOverride = null
    }
    this.saveToStorage()
    this.notify()
    return true
  }

  setLocalServerRuntimeUrl(url: string): boolean {
    if (!this.servers.some(s => s.id === this.DEFAULT_SERVER_ID)) return false

    const normalizedUrl = url.replace(/\/+$/, '')
    if (this.localServerUrlOverride === normalizedUrl) return false

    this.localServerUrlOverride = normalizedUrl
    this.notify()
    if (this.isActiveLocalServer()) {
      this.notifyServerChange(this.DEFAULT_SERVER_ID, 'local-runtime-url')
    }
    return true
  }

  /**
   * 删除服务器
   */
  removeServer(id: string): boolean {
    // 不能删除默认服务器
    const server = this.servers.find(s => s.id === id)
    if (!server || server.isDefault) return false

    this.servers = this.servers.filter(s => s.id !== id)
    this.healthMap.delete(id)
    this.healthCheckSeqMap.delete(id)
    this.healthInflight.delete(id)
    this.clockCalibrationMap.delete(id)

    // 如果删除的是当前选中的，切换到默认
    const wasActive = this.activeServerId === id
    if (wasActive) {
      this.activeServerId = this.servers[0]?.id ?? null
    }

    this.saveToStorage()
    this.notify()
    // 活动服务器被删属于一次服务器切换：必须通知监听者，否则目录上下文
    // （savedDirectories / recentProjects）不会重载，界面仍显示已删实例的数据。
    if (wasActive) {
      this.notifyServerChange(this.getActiveServerId(), 'server-switch')
    }
    return true
  }

  /**
   * 设置活动服务器
   * 如果实际切换了服务器，会通知 serverChangeListeners（用于 SSE 重连等）
   */
  setActiveServer(id: string): boolean {
    if (!this.servers.some(s => s.id === id)) return false

    const changed = this.activeServerId !== id
    this.activeServerId = id
    this.saveToStorage()
    this.notify()

    if (changed) {
      this.notifyServerChange(id, 'server-switch')
    }

    return true
  }

  applyServerConnectedTimestamp(serverId: string, timestamp: unknown): boolean {
    const normalizedTimestamp = normalizeServerTimestamp(timestamp)
    if (normalizedTimestamp == null) return false

    this.clockCalibrationMap.set(serverId, {
      serverTimestamp: normalizedTimestamp,
      calibratedAtMonotonic: performance.now(),
    })
    this.notify()
    return true
  }

  // ============================================
  // Health Check
  // ============================================

  /**
   * 检查服务器健康状态
   */
  async checkHealth(serverId: string, options?: { silent?: boolean }): Promise<ServerHealth> {
    const storedServer = this.servers.find(s => s.id === serverId)
    if (!storedServer) {
      return { status: 'error', error: i18n.t('settings:servers.serverNotFound') }
    }

    // 在途合并：同一服务器的并发健康检查共享一次网络。
    //
    // 触发点很多（应用启动、切换服务器、SSE 重连、设置面板多个入口），实测
    // 打开会话时同一 URL 被打了 5 次。经隧道时每次约 1.1s 固定往返，重复探测
    // 既慢又无意义 —— 健康状态本身就是「最近一次的结论」，并发场景下取任一
    // 结果都是等价的。
    const pendingHealth = this.healthInflight.get(serverId)
    if (pendingHealth) return pendingHealth

    const request = this.performHealthCheck(serverId, storedServer, options).finally(() => {
      if (this.healthInflight.get(serverId) === request) this.healthInflight.delete(serverId)
    })
    this.healthInflight.set(serverId, request)
    return request
  }

  /** 健康检查的实际网络逻辑（由 checkHealth 做在途合并后调用） */
  private async performHealthCheck(
    serverId: string,
    storedServer: ServerConfig,
    options?: { silent?: boolean },
  ): Promise<ServerHealth> {
    const server = this.withRuntimeServerUrl(storedServer)
    const checkSeq = (this.healthCheckSeqMap.get(serverId) ?? 0) + 1
    this.healthCheckSeqMap.set(serverId, checkSeq)
    const infoUrl = `${server.url}/api/info`

    const commitHealth = (health: ServerHealth) => {
      if (this.healthCheckSeqMap.get(serverId) === checkSeq) {
        this.healthMap.set(serverId, health)
        this.notify()
      }
      return health
    }

    // 标记为检查中：仅在没有已知状态时写入。
    // 周期性/自动探测若把已确认的 online 短暂改成 checking，界面会先掉成
    // 「离线」再跳回，看起来像连接在反复刷新。保留上一次结果直到拿到新值，
    // 只有首次探测（无任何记录）才显示加载态。silent 进一步跳过这一步。
    if (!options?.silent && !this.healthMap.has(serverId)) {
      this.healthMap.set(serverId, { status: 'checking' })
      this.notify()
    }

    const startTime = Date.now()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    try {
      const headers: Record<string, string> = {}
      // 与请求路径保持一致：配置了令牌走 Bearer，否则回退 Basic。
      // 此前只看 password 会导致仅带令牌的服务器（如 AI Agent 实例）健康检查不发鉴权头。
      if (server.auth?.token || server.auth?.password) {
        headers['Authorization'] = makeAuthHeader(server.auth)
      }

      const f = await getUnifiedFetch()
      const response = await f(infoUrl, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })

      const latency = Date.now() - startTime
      const responseBody = await response.text().catch(err => `[Failed to read response body: ${normalizeConnectionError(err)}]`)
      const details = formatResponseDiagnostics({ url: infoUrl, response, latency, body: responseBody })

      if (response.ok) {
        // OCC 只支持 opencode 2.x：GET /api/info 返回 { version } 即在线。
        let data: unknown
        try {
          data = JSON.parse(responseBody)
        } catch {
          const health: ServerHealth = {
            status: 'error',
            latency,
            lastCheck: Date.now(),
            error: i18n.t('settings:servers.healthInvalidJson'),
            details,
          }
          return commitHealth(health)
        }

        if (!isRecord(data) || typeof data.version !== 'string' || !data.version.trim()) {
          const health: ServerHealth = {
            status: 'error',
            latency,
            lastCheck: Date.now(),
            error: i18n.t('settings:servers.notAnOpenCodeServer'),
            details,
          }
          return commitHealth(health)
        }

        const health: ServerHealth = {
          status: 'online',
          latency,
          lastCheck: Date.now(),
          version: data.version,
          details,
        }
        return commitHealth(health)
      } else if (response.status === 401) {
        // 认证失败
        const health: ServerHealth = {
          status: 'unauthorized',
          latency,
          lastCheck: Date.now(),
          error: i18n.t('settings:servers.invalidCredentials'),
          details,
        }
        return commitHealth(health)
      } else {
        const health: ServerHealth = {
          status: 'error',
          latency,
          lastCheck: Date.now(),
          error: `HTTP ${response.status}`,
          details,
        }
        return commitHealth(health)
      }
    } catch (err) {
      const health: ServerHealth = {
        status: 'offline',
        lastCheck: Date.now(),
        error: normalizeConnectionError(err),
        details: formatExceptionDiagnostics(infoUrl, err),
      }
      return commitHealth(health)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 检查所有服务器健康状态
   */
  async checkAllHealth(options?: { silent?: boolean }): Promise<void> {
    await Promise.all(this.servers.map(s => this.checkHealth(s.id, options)))
  }
}

// 单例导出
export const serverStore = new ServerStore()

/**
 * 服务器条目的有效性判定：id/name/url 必须是非空字符串。
 *
 * 读取存储与导入备份两条路径共用同一谓词，避免校验强度不一致——
 * 否则导入时放行的空字段条目会在下次启动加载时被丢弃，服务器凭空消失。
 */
function isValidServerConfig(item: unknown): item is ServerConfig {
  if (!item || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    typeof record.name === 'string' &&
    record.name !== '' &&
    typeof record.url === 'string' &&
    record.url !== ''
  )
}

function normalizeServerBackup(raw: unknown): ServerSettingsBackup {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const servers = Array.isArray(parsed?.servers)
    ? parsed.servers
        .filter(isValidServerConfig)
        .map(item => ({
          id: item.id,
          name: item.name,
          url: item.url.replace(/\/+$/, ''),
          isDefault: item.isDefault === true,
          // 缺省启用：旧备份没有该字段时不应被当成停用
          enabled: item.enabled !== false,
          auth:
            item.auth &&
            typeof item.auth === 'object' &&
            typeof item.auth.username === 'string' &&
            typeof item.auth.password === 'string'
              ? {
                  username: item.auth.username,
                  password: item.auth.password,
                  token: typeof item.auth.token === 'string' && item.auth.token ? item.auth.token : undefined,
                }
              : undefined,
        }))
    : []

  const normalizedServers = servers.length
    ? servers
    : [
        {
          id: 'local',
          name: 'Local',
          url: API_BASE_URL,
          isDefault: true,
        },
      ]

  const activeServerId =
    typeof parsed?.activeServerId === 'string' && normalizedServers.some(server => server.id === parsed.activeServerId)
      ? parsed.activeServerId
      : (normalizedServers[0]?.id ?? null)

  return {
    servers: normalizedServers,
    activeServerId,
  }
}

/**
 * 导出服务器设置备份。
 *
 * 刻意剥离 auth（密码 / 令牌）：备份文件是明文 JSON，用户可能把它存到网盘
 * 或发给别人用于同步配置，带上凭证等于泄露。导入时见 importServerSettingsBackup
 * ——它会把本机已有的凭证按 id 合并回去，因此同机恢复不受影响。
 */
export function exportServerSettingsBackup(): ServerSettingsBackup {
  return {
    servers: serverStore.getStoredServers().map(server => ({
      ...server,
      auth: undefined,
    })),
    activeServerId: serverStore.getActiveServerId(),
  }
}

/**
 * 从存储中按 id 取出已有的认证信息。
 *
 * 刻意读 localStorage 而非内存：导入备份是直接写存储的底层操作，读取来源
 * 应与写入目标一致，避免依赖「store 已加载」的隐式前提。
 */
function readStoredAuthById(): Map<string, ServerAuth> {
  const result = new Map<string, ServerAuth>()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return result
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return result
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as { id?: unknown; auth?: unknown }
      if (typeof record.id !== 'string' || !record.auth || typeof record.auth !== 'object') continue
      result.set(record.id, record.auth as ServerAuth)
    }
  } catch {
    // 存储损坏时按「无历史凭证」处理，由调用方走正常回退
  }
  return result
}

export function importServerSettingsBackup(raw: unknown): void {
  const normalized = normalizeServerBackup(raw)
  // 备份不含凭证（见 exportServerSettingsBackup），导入时按 id 合并本机已有凭证：
  // 既避免丢失当前配置，也避免把他人备份里的凭证写到本机。
  const existingAuthById = readStoredAuthById()
  const mergedServers = normalized.servers.map(server => {
    const localAuth = existingAuthById.get(server.id)
    return localAuth ? { ...server, auth: localAuth } : server
  })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedServers))
  if (normalized.activeServerId) {
    localStorage.setItem(ACTIVE_SERVER_KEY, normalized.activeServerId)
    sessionStorage.setItem(ACTIVE_SERVER_KEY, normalized.activeServerId)
  } else {
    localStorage.removeItem(ACTIVE_SERVER_KEY)
    sessionStorage.removeItem(ACTIVE_SERVER_KEY)
  }
  // 同步内存状态：只写存储会让 UI 与再次导出继续读到旧值
  serverStore.replaceServers(mergedServers, normalized.activeServerId)
}

/**
 * 生成 Basic Auth header 值
 */
export function makeBasicAuthHeader(auth: ServerAuth): string {
  return 'Basic ' + btoa(`${auth.username}:${auth.password}`)
}

/**
 * 生成 Authorization header 值：配置了模块令牌时走 Bearer，否则回退 Basic
 */
export function makeAuthHeader(auth: ServerAuth): string {
  if (auth.token) {
    return `Bearer ${auth.token}`
  }
  return makeBasicAuthHeader(auth)
}

function normalizeServerTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null
  }

  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

