// ============================================
// AI Agent 账号接入 - 连接 API Monitor 的 aiagent 模块
//
// 用户在客户端填写「面板域名 + 用户名 + 密码」，换取长期令牌；随后拉取
// 自己名下的 AI Agent 实例，并把每个实例登记为一个可切换的服务器。
// 转发地址形如 {domain}/api/aiagent/gw/{instanceId}，鉴权走 Bearer 令牌，
// 数据经主机 Agent 的原生流通道到达本机 Agent 服务，不需要开放公网端口。
// ============================================

import { getUnifiedFetch, serverStore, type ServerConfig } from '../store/serverStore'

const STORAGE_KEY = 'opencode-aiagent-account'

export interface AiAgentAccount {
  domain: string
  username: string
  token: string
  expiresAt?: string
  loginAt: number
}

export interface AiAgentInstance {
  id: string
  label: string
  provider: string
  providerLabel?: string
  serverId: string
  hostName?: string
  port: number
  enabled: boolean
  gatewayUrl?: string
  gatewayPath?: string
  status?: {
    online?: boolean
    hostOnline?: boolean
    processRunning?: boolean
    portListening?: boolean
    pid?: number
    error?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 归一化用户输入的域名：补全协议、去掉尾部斜杠 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function readAccount(): AiAgentAccount | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const { domain, username, token, expiresAt, loginAt } = parsed
    if (typeof domain !== 'string' || typeof username !== 'string' || typeof token !== 'string') return null
    return {
      domain,
      username,
      token,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined,
      loginAt: typeof loginAt === 'number' ? loginAt : Date.now(),
    }
  } catch {
    return null
  }
}

function writeAccount(account: AiAgentAccount | null): void {
  try {
    if (account) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(account))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // ignore
  }
}

function serverIdForInstance(instance: AiAgentInstance): string {
  return `aiagent:${instance.id}`
}

export async function accountRequest<T>(account: AiAgentAccount, path: string, init?: RequestInit): Promise<T> {
  const requestFetch = await getUnifiedFetch()
  const response = await requestFetch(`${account.domain}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.token}`,
      ...(init?.headers || {}),
    },
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok || (isRecord(payload) && payload.success === false)) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `请求失败 (${response.status})`
    const error = new Error(message)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return (isRecord(payload) ? payload.data : payload) as T
}

/** accountRequest 的带响应头版本：供需要 ETag 条件请求的调用方使用。 */
export async function accountRequestWithMeta<T>(
  account: AiAgentAccount,
  path: string,
  init?: RequestInit,
): Promise<{ data: T; notModified: boolean; etag: string | null }> {
  const requestFetch = await getUnifiedFetch()
  const response = await requestFetch(`${account.domain}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.token}`,
      ...(init?.headers || {}),
    },
  })
  // 304 没有响应体，且不是错误：调用方据此复用本地缓存。
  if (response.status === 304) {
    return { data: undefined as T, notModified: true, etag: response.headers.get('ETag') }
  }
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok || (isRecord(payload) && payload.success === false)) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `请求失败 (${response.status})`
    const error = new Error(message)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return {
    data: (isRecord(payload) ? payload.data : payload) as T,
    notModified: false,
    etag: response.headers.get('ETag'),
  }
}

/** 登录换取长期令牌（不落盘，由调用方决定是否保存） */
export async function login(domainInput: string, username: string, password: string, deviceLabel?: string) {
  const domain = normalizeDomain(domainInput)
  if (!domain) throw new Error('请填写面板域名')
  if (!username.trim()) throw new Error('请填写用户名')
  if (!password) throw new Error('请填写密码')

  const requestFetch = await getUnifiedFetch()
  const response = await requestFetch(`${domain}/api/aiagent/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password, deviceLabel: deviceLabel || undefined }),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok || (isRecord(payload) && payload.success === false)) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `登录失败 (${response.status})`
    throw new Error(message)
  }
  const data = isRecord(payload) ? payload.data : undefined
  if (!isRecord(data) || typeof data.token !== 'string' || !data.token) {
    throw new Error('登录响应缺少令牌')
  }
  const account: AiAgentAccount = {
    domain,
    username: username.trim(),
    token: data.token,
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
    loginAt: Date.now(),
  }
  writeAccount(account)
  return account
}

export async function logout(): Promise<void> {
  const account = readAccount()
  if (account) {
    try {
      await accountRequest(account, '/api/aiagent/auth/logout', { method: 'POST' })
    } catch {
      // 登出失败也要清本地状态
    }
  }
  clearAccountServers()
  writeAccount(null)
}

export async function listInstances(account?: AiAgentAccount | null): Promise<AiAgentInstance[]> {
  const current = account ?? readAccount()
  if (!current) throw new Error('尚未登录')
  const instances = await accountRequest<AiAgentInstance[]>(current, '/api/aiagent/instances')
  return Array.isArray(instances) ? instances : []
}

/** 把实例登记为一个服务器配置（Bearer 令牌 + 网关地址） */
export function ensureServerForInstance(account: AiAgentAccount, instance: AiAgentInstance): ServerConfig {
  const id = serverIdForInstance(instance)
  const url = `${account.domain}${instance.gatewayPath || `/api/aiagent/gw/${instance.id}`}`
  // label 与 hostName 常相同（面板里两者都填机器名），此时拼成「工作（工作）」是纯噪音，
  // 只在确实不同时才补括号说明。
  const hostName = instance.hostName?.trim()
  const label = instance.label?.trim()
  const name = hostName && hostName !== label ? `${label}（${hostName}）` : label || hostName || instance.id
  return serverStore.addServerWithId(id, {
    name,
    url,
    auth: { username: account.username, password: '', token: account.token },
  })
}

/** 拉取实例并同步为服务器列表；返回同步后的实例与服务器 id 映射 */
export async function syncInstances(account?: AiAgentAccount | null): Promise<AiAgentInstance[]> {
  const current = account ?? readAccount()
  if (!current) throw new Error('尚未登录')
  const instances = await listInstances(current)
  for (const instance of instances) {
    ensureServerForInstance(current, instance)
  }
  pruneStaleAccountServers(instances)
  return instances
}

/**
 * 清理本地已不存在于账号下的 AI Agent 服务器。
 *
 * 实例被删除或重新创建后，旧的 `aiagent:inst_xxx` 服务器条目会一直留在本地，
 * 并且可能仍是活动服务器 —— 此时用户新加的项目会写进这个孤儿实例的存储桶
 * （srv:aiagent:inst_xxx:...），既同步不到、切回来也看不到。
 *
 * 活动服务器被清理时回退到本地服务器，避免指向不存在的条目。
 */
export function pruneStaleAccountServers(instances: AiAgentInstance[]): string[] {
  const valid = new Set(instances.map(instance => serverIdForInstance(instance)))
  const stale = serverStore
    .getStoredServers()
    .filter(server => server.id.startsWith('aiagent:') && !valid.has(server.id))
    .map(server => server.id)
  for (const id of stale) {
    serverStore.removeServer(id)
  }
  return stale
}

/** 切换到某个实例作为当前活动服务器 */
export function selectInstance(instance: AiAgentInstance): boolean {
  const id = serverIdForInstance(instance)
  if (!serverStore.getStoredServers().some(server => server.id === id)) return false
  return serverStore.setActiveServer(id)
}

/** 清除由账号同步出来的全部服务器（登出时调用） */
export function clearAccountServers(): void {
  for (const server of serverStore.getStoredServers()) {
    if (server.id.startsWith('aiagent:')) {
      serverStore.removeServer(server.id)
    }
  }
}

export const AiAgentAccountApi = {
  normalizeDomain,
  readAccount,
  login,
  logout,
  listInstances,
  syncInstances,
  pruneStaleAccountServers,
  selectInstance,
  clearAccountServers,
}

export default AiAgentAccountApi
