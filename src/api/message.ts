// ============================================
// Message API Functions
// 基于 @opencode-ai/sdk: /session/{sessionID}/message 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativePrompt, nativeListMessages } from './v2NativeMessage'
import { sanitizeMessageWithParts } from './sanitize'
import { resolveSessionTarget } from '../utils/sessionKey'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { sharedInflightRequest } from '../utils/singleFlight'
import { serverStorage } from '../utils/perServerStorage'
import { serverStore } from '../store/serverStore'
import { TURN_FETCH_MAX_PAGES, TURN_FETCH_MESSAGE_LIMIT } from '../constants/pagination'
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
      if (import.meta.env.DEV) console.warn(`[Message] Truncated response, retry ${attempt + 1}/${retries}`)
      if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)))
    }
  }
  throw lastError
}

type PromptParams = Parameters<ReturnType<typeof getSDKClient>['session']['prompt']>[0]

// ============================================
// Message Query
// ============================================

export interface SessionMessagePage {
  /** 本页消息，按时间升序 */
  messages: ApiMessageWithParts[]
  /** 继续向前翻页的游标（服务端 X-Next-Cursor）；缺省表示没有更早的消息 */
  nextCursor?: string
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
        const isV2 = serverStore.getApiVersion(target.serverId) === 'v2'
        if (isV2) {
          const page = await nativeListMessages(target.serverId, {
            sessionID: target.sessionId,
            limit: limit ? Math.min(limit, 200) : undefined,
            cursor: before,
          })
          // nativeListMessages 已把 v2 的 desc 结果反转为时间升序；v1 分支同样重排为升序。
          const messages = project ? projectPageMessages(page.messages) : page.messages
          return { messages, nextCursor: page.nextCursor }
        }
        const sdk = getSDKClient(target.serverId)
        const result = await sdk.session.messages({
          sessionID: target.sessionId,
          directory: formatPathForApi(directory, target.serverId),
          limit,
          before,
        })
        const messages = unwrap<ApiMessageWithParts[]>(result)
        const nextCursor = result.response?.headers?.get('X-Next-Cursor') ?? undefined
        return {
          messages: project ? projectPageMessages(messages) : messages,
          nextCursor: nextCursor || undefined,
        }
      }),
    options?.signal,
  )
}

/**
 * 轻量消息拉取的一次性上限。轻量响应已被主机 Agent 投影（只含对话 + 元数据），
 * 体积小，用一个大 limit 即可一次拿全整个会话的所有轮次。
 */
export const LIGHTWEIGHT_MESSAGE_LIMIT = 100000

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
  directory?: string,
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

  const request = (async () => {
    try {
      // v2 标准服务器无主机 Agent 的轻量投影（X-Lightweight 头），直接判定不支持。
      if (serverStore.getApiVersion(target.serverId) === 'v2') {
        lightweightSupportCache.set(cacheKey, false)
        return false
      }
      const sdk = getSDKClient(target.serverId)
      const result = await sdk.session.messages(
        {
          sessionID: target.sessionId,
          directory: formatPathForApi(directory, target.serverId),
          limit: 1,
        },
        { headers: { [LIGHTWEIGHT_HEADER]: '1' } },
      )
      const supported = (result.response?.headers?.get(LIGHTWEIGHT_HEADER) ?? '') === '1'
      lightweightSupportCache.set(cacheKey, supported)
      // 只持久化正结果，负结果留待下次冷启动重探（Agent 可能已升级）。
      if (supported) writePersistedSupport(cacheKey)
      return supported
    } catch {
      // 探测失败按不支持处理，走既有分页路径，不阻断加载；不写入任何缓存，下次重试。
      return false
    }
  })().finally(() => {
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
      const sdk = getSDKClient(target.serverId)
      const result = await sdk.session.messages({
        sessionID: target.sessionId,
        directory: formatPathForApi(directory, target.serverId),
        limit: LIGHTWEIGHT_MESSAGE_LIMIT,
      }, { headers: { [LIGHTWEIGHT_HEADER]: '1' } })
      const messages = unwrap<ApiMessageWithParts[]>(result)
      return {
        messages,
        hasMore: messages.length >= LIGHTWEIGHT_MESSAGE_LIMIT,
      }
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
  const payload = JSON.stringify({ id: message.info.id, time: inclusive ? created + 1 : created })
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
 * 两三轮。这里以 TURN_FETCH_MESSAGE_LIMIT 条为一页向前拉，累计到至少
 * targetTurnCount 个 user 边界后返回，保证调用方拿到的是完整轮次而非半截。
 *
 * 返回的 messages 不做裁剪：分页是连续的（游标指向本页最老一条之前），任何半截
 * 轮次只会出现在「当前已加载区间的最顶端」，上滑继续加载时自然补齐，不会产生缺口。
 *
 * 对「单轮几千条」这类病态会话设了 TURN_FETCH_MAX_PAGES 上限，超长轮次不会
 * 无限拉取，剩余内容由用户上滑按需加载。
 */
export async function getSessionTurnPage(
  sessionId: string,
  targetTurnCount: number,
  before?: string,
  directory?: string,
  serverId?: string,
  options?: { project?: boolean; signal?: AbortSignal },
): Promise<SessionTurnPage> {
  const collected: ApiMessageWithParts[] = []
  let cursor = before
  let hasMore = true
  let pagesFetched = 0
  let lastPageFull = true

  while (true) {
    const page = await getSessionMessagePage(sessionId, TURN_FETCH_MESSAGE_LIMIT, cursor, directory, serverId, options)
    collected.unshift(...page.messages)
    pagesFetched += 1
    lastPageFull = page.messages.length >= TURN_FETCH_MESSAGE_LIMIT
    cursor = page.nextCursor

    if (!cursor) {
      hasMore = false
      break
    }
    if (page.messages.length === 0) {
      hasMore = false
      break
    }

    const turnCount = collected.reduce((count, message) => count + (isUserApiMessage(message) ? 1 : 0), 0)
    if (turnCount >= targetTurnCount) break
    if (pagesFetched >= TURN_FETCH_MAX_PAGES) break
  }

  // 旧版 serve 不给游标但返回满页：无法区分「已到最早」与「还有更多」，
  // 按「可能还有」处理，与旧分页的兜底判定一致，避免漏掉更早历史。
  hasMore = cursor != null || lastPageFull

  return { messages: collected, nextCursor: cursor, hasMore }
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
 * 构建 SDK 发送消息所需的参数
 */
function buildPromptParams(params: SendMessageParams, serverId?: string): PromptParams {
  const { sessionId, text, attachments, model, agent, variant, directory, messageID } = params

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
        console.warn('Skipping attachment with empty URL:', attachment)
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
    directory: formatPathForApi(directory, serverId),
    messageID,
    parts,
    model,
    agent,
    variant,
  }
}

/**
 * 同步发送消息（等待完成）
 */
export async function sendMessage(params: SendMessageParams, serverId?: string): Promise<SendMessageResponse> {
  const target = resolveSessionTarget(params.sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const built = buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)
    await nativePrompt(target.serverId, {
      sessionID: target.sessionId,
      parts: built.parts as never,
      model: built.model,
      agent: built.agent,
      messageID: built.messageID,
    })
    return { info: {} as SendMessageResponse['info'], parts: [] }
  }
  const sdk = getSDKClient(target.serverId)
  return unwrap<SendMessageResponse>(await sdk.session.prompt(buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)))
}

/**
 * 异步发送消息 — 立即返回，AI 响应通过 SSE 推送
 */
export async function sendMessageAsync(params: SendMessageParams, serverId?: string): Promise<void> {
  const target = resolveSessionTarget(params.sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const built = buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)
    await nativePrompt(target.serverId, {
      sessionID: target.sessionId,
      parts: built.parts as never,
      model: built.model,
      agent: built.agent,
      messageID: built.messageID,
    })
    return
  }
  const sdk = getSDKClient(target.serverId)
  unwrap(await sdk.session.promptAsync(buildPromptParams({ ...params, sessionId: target.sessionId }, target.serverId)))
}
