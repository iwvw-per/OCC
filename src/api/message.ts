// ============================================
// Message API Functions
// 基于 @opencode-ai/sdk: /session/{sessionID}/message 相关接口
// ============================================

import { buildHeaders } from './sdk'
import { logger } from '../utils/logger'
import { nativePrompt, nativeListMessages } from './v2NativeMessage'
import { adaptMessagePage, type CompactionMarker, type IdleMarker, type SessionConfigMarkers } from './v2/message'
import { sanitizeMessageWithParts } from './sanitize'
import { resolveSessionTarget } from '../utils/sessionKey'
import { peekSessionCache } from './session'
import { directoryCacheKey } from '../utils/directoryUtils'
import { sharedInflightRequest } from '../utils/singleFlight'
import { serverStorage } from '../utils/perServerStorage'
import { serverStore } from '../store/serverStore'
import { TURN_FETCH_MAX_PAGES, TURN_FETCH_MESSAGE_LIMIT, FIRST_SCREEN_PAGE_LIMIT, HISTORY_PAGE_LIMIT_MAX } from '../constants/pagination'
import { estimateHistoryPageSize } from '../constants/pagination'
import type {
  ApiMessageWithParts,
  AgentPartInput,
  Attachment,
  FilePartInput,
  RevertedMessage,
  SendMessageParams,
  SendMessageResponse,
  TextPartInput,
} from './types'
import type { ApiSession } from '../types'
import type { Message, TextContent } from '../types/message'

/** 判定是否为「传输层把响应体截断」导致的解析失败：
 * 大响应在 Tauri-plugin-http 上有 340KB 级截断的抖动，会抛未闭合字符串的 JSON 解析错误。
 * 这类错误是瞬态的，重试同一请求即可恢复。 */
function isTruncatedJsonError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('Unterminated string in JSON') || msg.includes('Unexpected end of JSON input')
}

/**
 * 大体积响应可能被传输层截断，做有限次重试。
 * 仅对「截断型」失败生效，其它错误立即抛出。
 */
async function getWithTruncationRetry<T>(fn: () => Promise<T>, retries = 3, delay = 400): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTruncatedJsonError(error)) throw error
      if (import.meta.env.DEV) logger.warn(`[Message] Truncated response, retry ${attempt + 1}/${retries}`)
      if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)))
    }
  }
  throw lastError
}

type PromptParams = {
  sessionID: string
  messageID?: string
  parts: Array<TextPartInput | FilePartInput | AgentPartInput>
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
}

// ============================================
// Message Query
// ============================================

export interface SessionMessagePage {
  /** 本页消息，按时间升序 */
  messages: ApiMessageWithParts[]
  /** 继续向前翻页的游标（服务端 X-Next-Cursor）；缺省表示没有更早的消息 */
  nextCursor?: string
  /** 本页内最近一次已完成压缩的时间戳（用于消息流末尾的压缩分隔条） */
  compactedAt?: number
  /** 压缩标记（摘要/近期消息规模）：用于推算压缩后的上下文用量 */
  compaction?: CompactionMarker
  /** 本页内最近一次轮次结论（`type: "idle"` 消息） */
  idle?: IdleMarker
  /** 本页内的会话配置切换记录（model-switched / agent-switched） */
  config: SessionConfigMarkers
}

/**
 * 把一页消息裁剪成「渲染足够、体积最小」的投影。
 *
 * 只裁掉消息流渲染从不读取、却最占体积的字段：
 * - `info.summary.diffs`：整轮 patch 全文，单条可达 860KB。
 *   只有「本轮变更」视图用（getLastTurnDiff），它单独以 project:false 拉取完整数据。
 * - `tool.state.attachments`：工具结果里的内联附件（多为 data:image base64），
 *   单条可达 1MB，且没有任何渲染路径读取 state.attachments。
 *
 * 消息流真正会渲染的字段（tool.state.output/error、text、reasoning、file.url 等）
 * 一律原样保留，因此裁剪后 UI 无需回源即可完整显示。
 */
function projectMessageForStream(message: ApiMessageWithParts): ApiMessageWithParts {
  return sanitizeMessageWithParts(message)
}

function projectPageMessages(messages: ApiMessageWithParts[]): ApiMessageWithParts[] {
  return messages.map(projectMessageForStream)
}

/**
 * 按游标分页获取 session 消息。
 *
 * 服务端 `limit` 语义是「最新 N 条」，不带 before 时每次只能拿到末尾一段。
 * 传 before（上一页最老一条的游标）时只返回该游标之前的 limit 条，
 * 因此上滑加载的传输量是 O(N) 而不是「limit 累加后重拉」的 O(N²)。
 *
 * `project` 默认开启，裁掉消息流不渲染的重负载字段（见 projectMessageForStream）。
 * 需要完整数据（如变更视图的 turn diff）时传 project:false。
 */
export async function getSessionMessagePage(
  sessionId: string,
  limit?: number,
  before?: string,
  directory?: string,
  serverId?: string,
  options?: { project?: boolean; signal?: AbortSignal },
): Promise<SessionMessagePage> {
  const target = resolveSessionTarget(sessionId, serverId)
  const project = options?.project ?? true
  // 用与传输格式无关的 canonical key 做在途合并：同一会话同一分页参数（目录
  // 正/反斜杠、pathMode 抖动）只发一次网络。响应可达 MB 级，重复一次代价很高。
  const key = `message-page:${target.serverId}:${target.sessionId}:${directoryCacheKey(directory)}:${limit ?? ''}:${before ?? ''}:${project ? 1 : 0}`
  return sharedInflightRequest(
    key,
    () =>
      getWithTruncationRetry(async () => {
        const page = await nativeListMessages(target.serverId, {
          sessionID: target.sessionId,
          limit: limit ? Math.min(limit, 200) : undefined,
          cursor: before,
        })
        // nativeListMessages 已把 v2 的 desc 结果反转为时间升序。
        const messages = project ? projectPageMessages(page.messages) : page.messages
        return {
          messages,
          nextCursor: page.nextCursor,
          compactedAt: page.compactedAt,
          compaction: page.compaction,
          idle: page.idle,
          config: page.config,
        }
      }),
    options?.signal,
  )
}

/**
 * 轻量消息拉取的一次性上限。
 *
 * ⚠️ 必须是 200，不能更大：v2 服务端对 `message.list` 的 limit 做了硬校验，
 * 超过 200 直接返回 400 `InvalidRequestError: Expected a value less than or equal to 200`。
 * 此前这里写 5000，导致每一次「轻量拉取」都必然失败（400），再退回串行分页；
 * 会话越大越明显 —— 这正是首屏要等几十秒的直接原因。
 *
 * 真正的「一次拿全」由主机 Agent 侧完成（它在自己的投影实现里按 cursor 翻页取全），
 * 前端只需要把上限交给它，不必也不应该自己传一个超限值。
 */
export const LIGHTWEIGHT_MESSAGE_LIMIT = 200

/** 轻量投影响应的标记头：主机 Agent 命中投影时回填，用于判定服务端是否支持。 */
const LIGHTWEIGHT_HEADER = 'X-Lightweight'

/** 每个 serverId 是否支持轻量投影的内存缓存（进程内探测一次即可） */
const lightweightSupportCache = new Map<string, boolean>()

/** 探测请求的在途登记：同 serverId 并发探测只发一次网络 */
const lightweightProbeInflight = new Map<string, Promise<boolean>>()

/** 轻量能力探测结果的持久化 key（per-server storage，按 serverId 隔离） */
const LIGHTWEIGHT_SUPPORT_STORAGE_KEY = 'lightweight-support'
/** 持久化有效期：Agent 版本一致，可长期复用 */
const LIGHTWEIGHT_SUPPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface PersistedLightweightSupport {
  supported: true
  at: number
}

/**
 * 读取持久化的「支持」结果；缺失或过期返回 undefined。
 *
 * 只持久化正结果：负结果不落盘。原因：主机 Agent 升级后能力会从「不支持」变为
 * 「支持」，若把负结果持久化，升级后要等 TTL 过期才重探，用户会持续走旧的分页
 * 路径。正结果则稳定（同一 Agent 版本能力不变），可安全长效缓存。
 */
function readPersistedSupport(serverId: string): boolean | undefined {
  const record = serverStorage.getJSONFor<PersistedLightweightSupport>(LIGHTWEIGHT_SUPPORT_STORAGE_KEY, serverId)
  if (!record || record.supported !== true || typeof record.at !== 'number') return undefined
  if (Date.now() - record.at > LIGHTWEIGHT_SUPPORT_TTL_MS) return undefined
  return true
}

function writePersistedSupport(serverId: string): void {
  const record: PersistedLightweightSupport = { supported: true, at: Date.now() }
  serverStorage.setJSONFor(LIGHTWEIGHT_SUPPORT_STORAGE_KEY, record, serverId)
}

/**
 * 构造 v2 消息端点 URL。
 *
 * v2 的路径前缀是 `/api`（v1 无前缀），主机 Agent 的轻量投影对两者都生效：
 * Agent 会识别 `/session/{id}/message` 与 `/api/session/{id}/message`。
 */
function v2MessageUrl(serverId: string, sessionId: string, params: Record<string, string>): string {
  const base = serverStore.getServerBaseUrl(serverId).replace(/\/$/, '')
  const url = new URL(`${base}/api/session/${encodeURIComponent(sessionId)}/message`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * 走裸 fetch 直连 v2 消息端点（v2 SDK 不透出响应头，探测/读头必须自己发）。
 *
 * ⚠️ 必须带超时：这里绕过了 trackedFetch 的 30s 超时与取消代次，裸 fetch 一旦
 * 挂起就会让首屏永久停在加载态（实测能卡到几十秒甚至不返回）。
 * 超时用 AbortController 实现，并保留调用方传入的 signal（切走会话时仍可取消）。
 *
 * 取 12s：消息响应体可能较大（200 条约 500KB），隧道下需要留足传输时间；
 * 但也不能像 30s 那样让用户盯着加载动画半分钟。
 */
const RAW_FETCH_TIMEOUT_MS = 12_000

async function fetchV2MessageRaw(
  serverId: string,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()

  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromExternal()
  else signal?.addEventListener('abort', abortFromExternal, { once: true })
  const timeoutId = setTimeout(() => controller.abort(new Error('v2 message request timed out')), RAW_FETCH_TIMEOUT_MS)

  try {
    return await fetchImpl(url, {
      headers: { ...buildHeaders(serverId), Accept: 'application/json', [LIGHTWEIGHT_HEADER]: '1' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromExternal)
  }
}

/** v2 轻量能力探测：连本机 Agent 是否对 /api/session/{id}/message 做投影。 */
async function probeV2LightweightSupport(serverId: string, sessionId: string): Promise<boolean> {
  const res = await fetchV2MessageRaw(serverId, v2MessageUrl(serverId, sessionId, { limit: '1' }))
  if (!res.ok) return false
  const supported = (res.headers.get(LIGHTWEIGHT_HEADER) ?? '') === '1'
  // ⚠️ 必须掐断响应体。
  //
  // 主机 Agent 实现轻量投影时会**忽略 limit**，任何带 X-Lightweight 的消息
  // 请求都返回**整个会话**（实测 4810 条消息 = 25MB）。我们只要一个响应头，
  // 若把 body 读完/放着不管，等于每次探测都白下载几十 MB。
  // cancel 掉流，传输立刻停止（HTTP/2 下服务端随即收到 RST_STREAM）。
  void res.body?.cancel().catch(() => {})
  return supported
}

/**
 * v2 一次性轻量拉取整个会话（单请求）。
 *
 * v2 服务端把单次 limit 钳到 200，但主机 Agent 会对 `/api/session/{id}/message`
 * 的轻量请求做投影，并在 Agent 侧自行按 cursor 翻页取全（见 aiagent 的 v2 投影），
 * 因此这里只发「一次」大 limit 请求即可拿到整段压缩对话，与 v1 主机的轻量路径
 * 对齐：首屏即完整、无需上滑补历史；展开折叠块时再按轮次回拉完整 parts。
 *
 * 若 Agent 未升级（不识别 v2 轻量请求）则不会回填 X-Lightweight 头，
 * probeLightweightSupport 会判定不支持，调用方不会走到这里。
 */
async function fetchV2LightweightMessages(
  serverId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<LightweightMessages> {
  const res = await fetchV2MessageRaw(
    serverId,
    v2MessageUrl(serverId, sessionId, { limit: String(LIGHTWEIGHT_MESSAGE_LIMIT) }),
    signal,
  )
  if (!res.ok) throw new Error(`v2 lightweight fetch failed: HTTP ${res.status}`)
  const body: unknown = await res.json()
  const page = adaptMessagePage(body)
  // Agent 按 desc（最新在前）累积返回，这里反转为时间升序，与前端渲染顺序一致。
  return {
    messages: [...page.messages].reverse(),
    hasMore: false,
    compactedAt: page.compactedAt,
    compaction: page.compaction,
  }
}

/**
 * 只读取已知的轻量投影支持结果，**绝不发请求**。
 *
 * 给延迟敏感路径用（首屏加载）：未知时调用方应立刻走分页路径，而不是等一次探测
 * 往返；同时可在后台调用 probeLightweightSupport 预热缓存。
 */
export function peekLightweightSupport(serverId?: string): boolean | undefined {
  const cacheKey = serverId ?? serverStore.getActiveServerId()
  const cached = lightweightSupportCache.get(cacheKey)
  if (cached !== undefined) return cached
  const persisted = readPersistedSupport(cacheKey)
  if (persisted !== undefined) lightweightSupportCache.set(cacheKey, persisted)
  return persisted
}

/**
 * 探测某服务器的主机 Agent 是否支持轻量投影。
 *
 * 用 limit=1 + X-Lightweight 头发一个极小请求：新版 Agent 会回填 X-Lightweight
 * 响应头，旧版 Agent 直接透传（不带该头）。据此判定，避免对旧版 Agent 发出
 * 大 limit 请求导致下载整段全量数据。
 *
 * 结果两级缓存：进程内内存 + 按 serverId 持久化（应用重启后首个会话也免探测）。
 * 负结果 TTL 更短，Agent 升级后能较快重新探测。
 */
export async function probeLightweightSupport(
  sessionId: string,
  _directory?: string,
  serverId?: string,
): Promise<boolean> {
  const target = resolveSessionTarget(sessionId, serverId)
  const cacheKey = target.serverId
  const cached = lightweightSupportCache.get(cacheKey)
  if (cached !== undefined) return cached

  const persisted = readPersistedSupport(cacheKey)
  if (persisted !== undefined) {
    lightweightSupportCache.set(cacheKey, persisted)
    return persisted
  }

  // 在途合并：StrictMode 双调用 / 多个组件同时探测时只发一次请求。
  // 探测本身约 1.1s（经隧道），重复一次就是白白多等一个往返。
  const inflight = lightweightProbeInflight.get(cacheKey)
  if (inflight) return inflight

  // ⚠️ 必须在**同步阶段**就把 promise 登记进 inflight，不能等 async 函数体开始执行。
  // 否则同一 tick 内的两个调用都会走到上面那行、都看不到 inflight，各发一次请求 ——
  // 实测首屏会因此多发一个 limit=1 探测（白白多一个往返）。
  const request = probeV2LightweightSupport(target.serverId, target.sessionId)
    .then(supported => {
      lightweightSupportCache.set(cacheKey, supported)
      if (supported) writePersistedSupport(cacheKey)
      return supported
    })
    .catch(() => {
      // 探测失败按不支持处理，走既有分页路径，不阻断加载；不写入任何缓存，下次重试。
      return false
    })
    .finally(() => {
      if (lightweightProbeInflight.get(cacheKey) === request) lightweightProbeInflight.delete(cacheKey)
    })

  lightweightProbeInflight.set(cacheKey, request)
  return request
}

/** 测试用：清空轻量能力探测的内存缓存与持久化 */
export function resetLightweightSupportCache(): void {
  lightweightSupportCache.clear()
  lightweightProbeInflight.clear()
}

export interface LightweightMessages {
  messages: ApiMessageWithParts[]
  /** 是否还有更早的消息（返回条数达到 limit 时保守视为还有） */
  hasMore: boolean
  /** 最近一次已完成压缩的时间戳（用于消息流末尾的压缩分隔条） */
  compactedAt?: number
  /** 压缩标记（摘要/近期消息规模）：用于推算压缩后的上下文用量 */
  compaction?: CompactionMarker
}

/**
 * 轻量拉取的「在途合一」登记。
 *
 * React StrictMode 在开发环境会把 effect 执行两次（mount → 卸载 → 再 mount），
 * 于是同一会话的轻量请求会被并发发出两次 —— 单次响应可达 MB 级，白白翻倍。
 * 这里按会话维度合并同 key 在途请求，只发一次网络。
 *
 * 实现委托给 utils/singleFlight 的 sharedInflightRequest：底层共享请求不接收
 * 任何调用方的 signal，单个调用方 abort 只影响自己，其余在途调用方仍能拿到数据。
 */
const lightweightInflight = new Map<string, Promise<LightweightMessages>>()

/** 测试用：清空轻量请求的在途登记 */
export function resetLightweightInflight(): void {
  lightweightInflight.clear()
}

/**
 * 轻量拉取整个会话的消息（一次性，不分页）。
 *
 * 需先经 probeLightweightSupport 确认服务端支持；主机 Agent 会把每条消息投影成
 * 「user 文本 + 助手最终文本 + 工具元数据壳 + step-finish」，剥掉 reasoning 与
 * 工具大输出，并附上 lightweight 统计。展开折叠块时再按轮次回拉完整 parts。
 *
 * 同会话的并发调用（如 StrictMode 双调用）合并在途请求，只发一次网络。
 */
export async function getSessionLightweightMessages(
  sessionId: string,
  directory?: string,
  serverId?: string,
  options?: { signal?: AbortSignal },
): Promise<LightweightMessages> {
  const target = resolveSessionTarget(sessionId, serverId)
  const key = `lightweight:${target.serverId}:${target.sessionId}:${directoryCacheKey(directory)}`
  return sharedInflightRequest(
    key,
    async () => {
      // 走原生的 /api/session/{id}/message + X-Lightweight，由主机 Agent 内部
      // 分页取全并投影；v2 SDK 不便于读响应头，这里用裸 fetch。
      return fetchV2LightweightMessages(target.serverId, target.sessionId, options?.signal)
    },
    options?.signal,
  )
}

/**
 * 获取 session 的消息列表（只取一页，忽略游标）
 */
export async function getSessionMessages(
  sessionId: string,
  limit?: number,
  directory?: string,
  serverId?: string,
  options?: { project?: boolean },
): Promise<ApiMessageWithParts[]> {
  const page = await getSessionMessagePage(sessionId, limit, undefined, directory, serverId, options)
  return page.messages
}

export interface SessionTurnPage {
  /** 本批消息，按时间升序，起始端对齐到至少 targetTurnCount 个完整轮次 */
  messages: ApiMessageWithParts[]
  /** 继续向前翻页的游标；缺省表示没有更早的消息 */
  nextCursor?: string
  /** 是否还有更早的历史（服务端给了游标即视为还有） */
  hasMore: boolean
  /** 本批内最近一次已完成压缩的时间戳 */
  compactedAt?: number
  /** 压缩标记（摘要/近期消息规模）：用于推算压缩后的上下文用量 */
  compaction?: CompactionMarker
  /** 本批内最近一次轮次结论（`type: "idle"` 消息） */
  idle?: IdleMarker
  /** 本批内的会话配置切换记录（model-switched / agent-switched） */
  config: SessionConfigMarkers
}

/** 一条消息是否为用户消息（轮次分隔点） */
function isUserApiMessage(message: ApiMessageWithParts): boolean {
  return message.info.role === 'user'
}

/**
 * 用消息的 {id, time} 构造服务端可识别的分页游标。
 *
 * ⚠️ 跨版本隐式契约（upstream opencode / 主机 Agent）
 * ---------------------------------------------------------------
 * 服务端游标是**不透明**的 base64url 编码，但本函数必须知道其内部结构才能
 * 在客户端本地构造。当前约定的载荷为：
 *
 *     base64url(JSON.stringify({ id: string, time: number }))
 *
 * 语义：
 * - `time` 取 `created` 时，游标指向该消息**更早**一侧（不含自身）；
 * - `time` 取 `created + 1` 时，游标把该消息**本身**包含进来（inclusive）。
 *
 * 风险：上游若更改游标编码（换字段名、换序列化方式、加签名/加密），这里会
 * 静默构造出服务端无法解析的游标 —— 表现为分页错位或拉到重复内容，而不是
 * 报错。因此**升级上游 serve / 主机 Agent 时必须回归**以下用例：
 * `encodeMessageCursor` 产出的游标应能被服务端接受，且往返（服务端返回的
 * X-Next-Cursor 再传回 before）不产生重叠或缺口。
 * 相关回归测试见 message.test.ts 的 `encodeMessageCursor` 用例。
 *
 * 之所以本地构造而不多调一次接口：hydrateTurn（展开被压缩轮次）等场景需要
 * 「从内存中某条消息向前取一段」，走接口会多一次往返且需要额外的定位参数。
 */
export function encodeMessageCursor(message: ApiMessageWithParts, inclusive = false): string {
  const created = message.info.time?.created ?? 0
  return encodeBase64Url(JSON.stringify({ id: message.info.id, time: inclusive ? created + 1 : created }))
}

/** base64url 编码（无填充），游标载荷统一走这里，保证与各端期待一致。 */
function encodeBase64Url(payload: string): string {
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 构造 v2 服务端可识别的分页游标。
 *
 * ⚠️ v2 `message.list` 的游标与 v1 **不同**（不能复用 encodeMessageCursor）：
 *
 *     base64url(JSON.stringify({ id: string, order: 'asc'|'desc', direction: 'next'|'previous' }))
 *
 * 语义（实测）：
 * - `direction: 'next'` 返回该消息**更早**一侧（不含自身）；
 * - `direction: 'previous'` 返回该消息**更新**一侧（不含自身）；
 * - `order` 决定返回后的排序，服务端不强制须与首页一致。
 *
 * v1 游标（{id,time}）传给 v2 会被拒（InvalidCursorError），因此 hydrateTurn
 * 展开压缩轮次时必须按 apiVersion 选对游标编码，见 encodeBeforeCursor。
 */
export function encodeV2MessageCursor(
  message: ApiMessageWithParts,
  direction: 'next' | 'previous' = 'next',
): string {
  return encodeBase64Url(JSON.stringify({ id: message.info.id, order: 'desc', direction }))
}

/**
 * 按 v2 协议编码「取该消息更早一侧」的游标（{id,order,direction:next}）。
 * 供 hydrateTurn（展开被压缩轮次）等需要本地自造游标的场景调用。
 */
export function encodeBeforeCursor(message: ApiMessageWithParts, _serverId?: string): string {
  return encodeV2MessageCursor(message, 'next')
}

/**
 * 解析服务端游标，取回 { id, time }。
 *
 * 仅用于测试与诊断（验证上文的隐式契约是否仍成立）：解析失败返回 undefined，
 * 绝不抛错 —— 生产路径不应依赖解析结果，也就能容忍上游改动编码后在此处降级。
 */
export function decodeMessageCursor(cursor: string): { id: string; time: number } | undefined {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      typeof (parsed as { time?: unknown }).time === 'number'
    ) {
      return parsed as { id: string; time: number }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 按「对话轮次」分页获取消息。
 *
 * 服务端只有「最新 limit 条 + before 游标」，没有轮次概念；一个轮次常被拆成多条
 * assistant 消息（每步思考 / 每次工具调用各一条），所以固定条数的首屏往往只覆盖
 * 两三轮。这里以 pageLimit 条为一页向前拉，累计到至少 targetTurnCount 个 user
 * 边界后返回，保证调用方拿到的是完整轮次而非半截。
 *
 * 返回的 messages 不做裁剪：分页是连续的（游标指向本页最老一条之前），任何半截
 * 轮次只会出现在「当前已加载区间的最顶端」，上滑继续加载时自然补齐，不会产生缺口。
 *
 * 对「单轮几千条」这类病态会话设了 TURN_FETCH_MAX_PAGES 上限，超长轮次不会
 * 无限拉取，剩余内容由用户上滑按需加载。
 *
 * pageLimit 由调用方决定：首屏用**小页**先出内容（见 getSessionFirstScreen），
 * 只有需要一次补齐更多轮次时才用大页。小页的意义在于响应体大小 —— 实测同一个
 * 会话，200 条响应 536KB、35 条只有 86KB，而首屏通常只需要 3 轮。
 */
export async function getSessionTurnPage(
  sessionId: string,
  targetTurnCount: number,
  before?: string,
  directory?: string,
  serverId?: string,
  options?: { project?: boolean; signal?: AbortSignal; pageLimit?: number; maxPages?: number },
): Promise<SessionTurnPage> {
  const pageLimit = options?.pageLimit ?? TURN_FETCH_MESSAGE_LIMIT
  const maxPages = options?.maxPages ?? TURN_FETCH_MAX_PAGES
  const collected: ApiMessageWithParts[] = []
  let cursor = before
  let pagesFetched = 0
  let reachedEnd = false
  let compactedAt: number | undefined
  let compaction: CompactionMarker | undefined
  let idle: IdleMarker | undefined
  const config: SessionConfigMarkers = { model: undefined, agent: undefined }

  /** 合并一页里带来的 markers（取「时间更晚」的那个） */
  const mergeMarkers = (page: {
    idle?: IdleMarker
    config?: SessionConfigMarkers
  }) => {
    if (page.idle && (!idle || page.idle.at >= idle.at)) idle = page.idle
    const m = page.config?.model
    if (m && (!config.model || m.at >= config.model.at)) {
      config.model = { providerID: m.providerID, modelID: m.modelID, at: m.at }
    }
    const a = page.config?.agent
    if (a && (!config.agent || a.at >= config.agent.at)) {
      config.agent = { agent: a.agent, at: a.at }
    }
  }

  while (true) {
    const page = await getSessionMessagePage(sessionId, pageLimit, cursor, directory, serverId, options)
    collected.unshift(...page.messages)
    pagesFetched += 1
    cursor = page.nextCursor
    if (page.compactedAt != null && (compactedAt == null || page.compactedAt > compactedAt)) {
      compactedAt = page.compactedAt
    }
    if (page.compaction && (!compaction || page.compaction.at >= compaction.at)) {
      compaction = page.compaction
    }
    mergeMarkers(page)

    // 无游标或空页（残留游标）都算到最早。
    if (!cursor || page.messages.length === 0) {
      reachedEnd = true
      break
    }

    const turnCount = collected.reduce((count, message) => count + (isUserApiMessage(message) ? 1 : 0), 0)
    if (turnCount >= targetTurnCount) break
    if (pagesFetched >= maxPages) break
  }

  // cursor 权威——已到最早（无游标 / 空页）即没有更早，不再被「末页恰好满 30 条」
  // 误判成还有历史（否则点开别端已建的会话，拉完仍会无限自动上滑加载更多）。
  const hasMore = !reachedEnd && cursor != null

  // 已到最早时清掉游标，避免 loadMoreHistory 因残留游标继续触发空拉。
  return {
    messages: collected,
    nextCursor: reachedEnd ? undefined : cursor,
    hasMore,
    compactedAt,
    compaction,
    ...(idle ? { idle } : {}),
    config,
  }
}

/**
 * 首屏「先出内容、再补齐」的两段式加载。
 *
 * 背景（实测，本机 4288 条消息的会话）：
 *   - 取 200 条 = 536KB；取 35 条（最近 3 轮）= 86KB。
 *   - 经隧道单次往返约 1s，大响应还要额外传输与解析时间。
 * 而首屏真正需要的只是「最近几轮能看见」，用户不必等整段历史。
 *
 * 因此拆成两段：
 *   1. `first`：小页（默认 40 条）一次往返，通常已覆盖 2–3 轮，**立刻**可以渲染；
 *   2. `rest`：若首段不足目标轮数，继续向前补足（同一游标链，不会重复也不会缺口）。
 *
 * 调用方拿到 first 就先上屏，rest 到达后原地替换（不闪 loading、不跳滚动位置）。
 */
export interface FirstScreenPage extends SessionTurnPage {
  /** 首段是否已满足目标轮数；false 时调用方应等待 rest */
  complete: boolean
  /** 继续补足剩余轮次（complete=true 时为 undefined） */
  rest?: () => Promise<SessionTurnPage>
}

export async function getSessionFirstScreen(
  sessionId: string,
  targetTurnCount: number,
  directory?: string,
  serverId?: string,
  options?: { project?: boolean; signal?: AbortSignal },
): Promise<FirstScreenPage> {
  // 第一段：极小页。只要「能立刻看到最近内容」，不强求凑满轮数。
  const first = await getSessionTurnPage(sessionId, targetTurnCount, undefined, directory, serverId, {
    ...options,
    pageLimit: FIRST_SCREEN_PAGE_LIMIT,
    maxPages: 1,
  })

  const firstTurnCount = first.messages.reduce((count, m) => count + (isUserApiMessage(m) ? 1 : 0), 0)
  if (firstTurnCount >= targetTurnCount || !first.nextCursor) {
    return { ...first, complete: true }
  }

  return {
    ...first,
    complete: false,
    rest: async () => {
      // 补齐是**后台行为**：逐小块向前补，凑满目标轮数即停。
      //
      // 除了不占满连接，更重要的是：大附件（实测有 1.3MB 的 inline 图片）只在
      // 真正翻到它所在的那一块时才付出代价。分块后即使某块很慢，用户也已经
      // 看到首段内容，其余块不受影响。
      //
      // 上限 RES5T_MAX_PAGES 防止「单轮几千条」时无限补：那种情况下多发几块
      // 也凑不满一轮，只会持续占用带宽，剩余内容应由用户上滑按需加载。
      const collected: ApiMessageWithParts[] = [...first.messages]
      let cursor = first.nextCursor
      let turns = first.messages.reduce((count, m) => count + (isUserApiMessage(m) ? 1 : 0), 0)
      let compactedAt = first.compactedAt
      let compaction = first.compaction
      let idle = first.idle
      const config: SessionConfigMarkers = { ...(first.config ?? {}) }
      let pages = 0

      /**
       * 补齐页的大小按密度自适应，并受**总条数预算**约束。
       *
       * 首屏那 12 条能看出「这个会话一轮有多少条消息」：普通聊天 2~4 条，
       * 工具密集的 30+ 条。
       *
       * 但有一种情况密度**根本测不出来**：首屏那 12 条全是助手消息/工具调用，
       * 一条用户消息都没有 —— 说明当前正处在一个超长轮次里。此时与其用默认
       * 密度一次取 22 条、连翻 4 页（4 次串行往返），不如按上限一次多取，
       * 把「补齐 3 轮」一次做完。
       *
       * 预算是总条数（不是页数）：不管密度怎么估，补齐最多再拉这么多条，
       * 避免在病态会话里持续占带宽。
       */
      const REST_BUDGET_MESSAGES = 240
      let restBudget = REST_BUDGET_MESSAGES

      const pickRestPageLimit = (): number => {
        const collectedUserCount = collected.reduce((count, m) => count + (isUserApiMessage(m) ? 1 : 0), 0)
        if (collectedUserCount < 2) {
          // 还看不到用户轮次 → 大概率在超长轮次里，按上限取
          return Math.min(HISTORY_PAGE_LIMIT_MAX, restBudget)
        }
        const density = collected.length / collectedUserCount
        return Math.min(estimateHistoryPageSize(density, Math.max(1, targetTurnCount - turns)), restBudget)
      }

      let restPageLimit = pickRestPageLimit()

      while (turns < targetTurnCount && cursor && pages < 4 && restBudget > 0) {
        const more = await getSessionTurnPage(sessionId, targetTurnCount - turns, cursor, directory, serverId, {
          ...options,
          pageLimit: restPageLimit,
          maxPages: 1,
        })
        pages += 1
        collected.unshift(...more.messages)
        turns += more.messages.reduce((count, m) => count + (isUserApiMessage(m) ? 1 : 0), 0)
        cursor = more.nextCursor
        restBudget -= more.messages.length
        // 样本变多了，重新估一次密度与页大小。
        restPageLimit = pickRestPageLimit()
        if (more.compactedAt != null && (compactedAt == null || more.compactedAt > compactedAt)) {
          compactedAt = more.compactedAt
        }
        if (more.compaction && (!compaction || more.compaction.at >= compaction.at)) {
          compaction = more.compaction
        }
        if (more.idle && (!idle || more.idle.at >= idle.at)) idle = more.idle
        const mModel = more.config?.model
        if (mModel && (!config.model || mModel.at >= config.model.at)) {
          config.model = { providerID: mModel.providerID, modelID: mModel.modelID, at: mModel.at }
        }
        const mAgent = more.config?.agent
        if (mAgent && (!config.agent || mAgent.at >= config.agent.at)) {
          config.agent = { agent: mAgent.agent, at: mAgent.at }
        }
        if (more.messages.length === 0) break
      }

      return {
        messages: collected,
        nextCursor: cursor,
        hasMore: cursor != null,
        compactedAt,
        compaction,
        ...(idle ? { idle } : {}),
        config,
      }
    },
  }
}

// ============================================
// Message Content Extraction
// ============================================

/**
 * 从消息中提取用户消息内容（文本+附件）。
 * 前端领域模型为 v2 content[]：文本在 content[]，附件在 info.attachments。
 */
export function extractUserMessageContent(message: Pick<Message, 'info' | 'content'>): RevertedMessage {
  const text = message.content
    .filter((c): c is TextContent => c.type === 'text' && !c.synthetic)
    .map(c => c.text)
    .join('\n')

  const attachments: Attachment[] =
    message.info.role === 'user' ? (message.info.attachments ?? []) : []

  return { text, attachments }
}

// ============================================
// Send Message
// ============================================

/**
 * 构建 file:// URL
 */
function toFileUrl(path: string): string {
  if (!path) return ''

  if (path.startsWith('file://')) {
    return path
  }

  if (path.startsWith('data:')) {
    return path
  }

  const normalized = path.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`
  }
  return `file:///${normalized}`
}

/**
 * 构建发送消息所需的参数
 */
function buildPromptParams(params: SendMessageParams, _serverId?: string): PromptParams {
  const { sessionId, text, attachments, model, agent, variant, messageID } = params

  const parts: NonNullable<PromptParams['parts']> = []

  // 文本 part
  const textPart: TextPartInput = {
    type: 'text',
    text,
  }
  parts.push(textPart)

  // 附件 parts
  for (const attachment of attachments) {
    if (attachment.type === 'agent') {
      const agentPart: AgentPartInput = {
        type: 'agent',
        name: attachment.agentName || attachment.displayName,
        source: attachment.textRange
          ? {
              value: attachment.textRange.value,
              start: attachment.textRange.start,
              end: attachment.textRange.end,
            }
          : undefined,
      }
      parts.push(agentPart)
    } else {
      const fileUrl = toFileUrl(attachment.url || '')
      if (!fileUrl) {
        logger.warn('Skipping attachment with empty URL:', attachment)
        continue
      }

      const filePart: FilePartInput = {
        type: 'file',
        mime: attachment.mime || (attachment.type === 'folder' ? 'application/x-directory' : 'text/plain'),
        url: fileUrl,
        filename: attachment.displayName,
        source: attachment.textRange
          ? {
              text: {
                value: attachment.textRange.value,
                start: attachment.textRange.start,
                end: attachment.textRange.end,
              },
              type: 'file',
              path: attachment.relativePath || attachment.displayName,
            }
          : undefined,
      }
      parts.push(filePart)
    }
  }

  return {
    sessionID: sessionId,
    messageID,
    parts,
    model,
    agent,
    variant,
  }
}

/**
 * 判断这次发送是否真的需要 switchAgent / switchModel（同步、绝不发请求）。
 *
 * v2 的 agent 与 model 是会话级状态，只要上次发送已经设过、且期间没有别处改动，
 * 就不必每轮都重新 switch。省掉这两次往返对本地几乎无感，但经隧道连远程主机时
 * 每次约 1.1s —— 这是「点发送后要停两三秒才出字」的主要来源之一。
 *
 * 关键：这里**只能读缓存，不能 await 拉取**。发送路径上多一次串行往返，就等于
 * 把延迟又加回去；宁可缓存未命中时照常 switch（多一次并行请求），也不阻塞。
 */
function resolveSwitchSkips(
  serverId: string,
  sessionId: string,
  directory: string | undefined,
  agent: string | undefined,
  model: { providerID: string; modelID: string } | undefined,
): { skipAgentSwitch: boolean; skipModelSwitch: boolean } {
  const cached = peekSessionCache(sessionId, directory, serverId)
  if (!cached) {
    // 未命中：保守地照常切换，正确性优先
    return { skipAgentSwitch: false, skipModelSwitch: false }
  }
  const currentModel = cached.model as { providerID?: string; id?: string; modelID?: string } | undefined
  const sameAgent = !agent || !cached.agent || cached.agent === agent
  const sameModel =
    !model ||
    !currentModel?.providerID ||
    (currentModel.providerID === model.providerID &&
      (currentModel.id ?? currentModel.modelID) === model.modelID)
  return { skipAgentSwitch: sameAgent, skipModelSwitch: sameModel }
}

/**
 * 发送成功后回填「这轮用的 agent/model」到会话元数据缓存。
 *
 * 只是缓存写，不发请求；缓存里没有该会话时跳过（不凭空造一条假元数据）。
 */
function rememberSessionAgentModel(
  serverId: string,
  sessionId: string,
  directory: string | undefined,
  agent: string | undefined,
  model: { providerID: string; modelID: string } | undefined,
): void {
  const cached = peekSessionCache(sessionId, directory, serverId)
  if (!cached) return
  // ttlCacheGet 返回的是缓存里的同一对象引用；直接改它等价于原地更新缓存。
  // 这里只动 agent/model 两个字段，其它字段（title/directory/time）保持原样。
  cached.agent = agent ?? cached.agent
  if (model) {
    cached.model = { providerID: model.providerID, id: model.modelID } as ApiSession['model']
  }
}

/**
 * 同步发送消息（等待完成）
 */
export async function sendMessage(params: SendMessageParams, serverId?: string): Promise<SendMessageResponse> {
  const target = resolveSessionTarget(params.sessionId, serverId)
  const built = buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)
  const skips = resolveSwitchSkips(target.serverId, target.sessionId, params.directory, built.agent, built.model)
  await nativePrompt(target.serverId, {
    sessionID: target.sessionId,
    parts: built.parts as never,
    model: built.model,
    agent: built.agent,
    messageID: built.messageID,
    delivery: params.delivery,
    ...skips,
  })
  return { info: {} as SendMessageResponse['info'], parts: [] }
}

/**
 * 异步发送消息 — 立即返回，AI 响应通过 SSE 推送
 */
export async function sendMessageAsync(params: SendMessageParams, serverId?: string): Promise<void> {
  const target = resolveSessionTarget(params.sessionId, serverId)
  const built = buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)
  const skips = resolveSwitchSkips(target.serverId, target.sessionId, params.directory, built.agent, built.model)
  await nativePrompt(target.serverId, {
    sessionID: target.sessionId,
    parts: built.parts as never,
    model: built.model,
    agent: built.agent,
    messageID: built.messageID,
    delivery: params.delivery,
    ...skips,
  })
  // 发送成功后把「这轮用的 agent/model」写回元数据缓存。
  //
  // 这样下一轮发送能直接命中缓存、跳过 switch（省 1–2 次往返）；否则缓存过期后
  // 每轮都要重新 switch，远程主机下每次白付一个往返。
  rememberSessionAgentModel(target.serverId, target.sessionId, params.directory, built.agent, built.model)
}
