// ============================================
// Preferences Events - 偏好变更的服务端推送订阅
//
// 多端同步原本只能轮询：一端改动最多要等一个轮询周期才会出现在其它设备上。
// 面板提供了一条 SSE 通道（GET /api/aiagent/preferences/events），写成功后
// 推送变更键名，客户端收到即触发一次同步，把延迟从「一个轮询周期」压到「接近
// 实时」。
//
// 为什么不用原生 EventSource：它无法自定义请求头，而模块鉴权走
// `Authorization: Bearer <token>`，令牌放 URL 会进访问日志。这里用 fetch +
// ReadableStream 手工解析 SSE；Tauri 的 plugin-http 同样支持流式响应体，
// 因此桌面端与浏览器走同一份实现。
//
// 事件只带键名与时间戳，不带值：值可能接近单值上限（256 KB），塞进通知会把
// 一条轻量事件变成大流量；客户端本来就要走一次 GET 才能拿到合并后的结果。
// ============================================

import { readAccount, type AiAgentAccount } from './aiagent'
import { getUnifiedFetch } from '../store/serverStore'

export interface PreferenceChangeEvent {
  type: string
  keys: string[]
  updatedAt: string
}

interface SubscribeOptions {
  /** 收到变更事件时回调；keys 已过滤为空的事件不会触发。 */
  onEvent: (event: PreferenceChangeEvent) => void
  /** 连接状态变化（用于观测与降级判断），可选。 */
  onStateChange?: (connected: boolean) => void
}

export interface PreferenceEventsSubscription {
  close: () => void
  /** 当前是否连着（供轮询节奏参考：断线时用更短的兜底间隔） */
  isConnected: () => boolean
}

// 重连退避：SSE 断开后逐步拉长重试间隔，避免服务端故障时高频重连。
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
// 连接存活超过该时长才视为「稳定」，才把重连退避归零（见 connect 的收尾逻辑）。
const STABLE_CONNECTION_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 解析单条 SSE 事件块（已按空行切分）。返回 null 表示不是可识别的事件。 */
function parseEventBlock(block: string): { event: string; data: string } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

/** 把服务端事件载荷规整成客户端契约；字段不合法时返回 null。 */
export function normalizePreferenceChange(payload: unknown): PreferenceChangeEvent | null {
  if (!isRecord(payload)) return null
  const rawKeys = payload.keys
  const keys = Array.isArray(rawKeys) ? rawKeys.filter((key): key is string => typeof key === 'string' && !!key) : []
  if (keys.length === 0) return null
  return {
    type: typeof payload.type === 'string' ? payload.type : 'preferences.changed',
    keys,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : '',
  }
}

/**
 * 订阅偏好变更事件。返回句柄；调用 close() 会中止连接并停止重连。
 *
 * 连接失败或中途断开时会按退避自动重连——SSE 只是加速通道，断开不应影响
 * 正确性：调用方保留轮询兜底，最坏情况退化为原来的延迟。
 */
export function subscribePreferenceEvents(
  options: SubscribeOptions,
  account?: AiAgentAccount | null,
): PreferenceEventsSubscription {
  const current = account ?? readAccount()
  if (!current) {
    return { close: () => {}, isConnected: () => false }
  }

  const controller = new AbortController()
  let closed = false
  let connected = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0

  const scheduleReconnect = () => {
    if (closed) return
    attempt += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    const startedAt = Date.now()
    try {
      const requestFetch = await getUnifiedFetch()
      const response = await requestFetch(`${current.domain}/api/aiagent/preferences/events`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${current.token}`,
        },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        // 4xx 多为令牌失效或路由不存在，重连不会自愈：直接放弃，交由轮询兜底，
        // 避免以固定间隔无限重试。
        if (response.status >= 400 && response.status < 500) {
          closed = true
          return
        }
        throw new Error(`preferences events failed (${response.status})`)
      }
      connected = true
      options.onStateChange?.(true)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 以空行分隔事件块。用正则匹配实际长度推进，而不是按首字符硬编码
        // 2/4：混合换行（\r\n\n、\n\r\n）各为 3 字符，硬编码会错切并丢字符。
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer)
          if (!match) break
          const block = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          const parsed = parseEventBlock(block)
          if (parsed && parsed.event === 'preferences') {
            try {
              const event = normalizePreferenceChange(JSON.parse(parsed.data))
              if (event) options.onEvent(event)
            } catch {
              // 单条事件解析失败不影响后续事件
            }
          }
        }
      }
    } catch {
      // 主动关闭或网络异常都会走到这里，统一交由重连逻辑判定。
    }
    if (closed) return
    connected = false
    options.onStateChange?.(false)
    // 只有连接真正存活过一段时间才算「成功」，才把退避归零。若服务端或代理
    // 接受连接后立刻关闭（鉴权通过但无事件），立即归零会退化成固定 1 秒无限
    // 重连，注释承诺的「逐步拉长」失效。
    if (Date.now() - startedAt >= STABLE_CONNECTION_MS) {
      attempt = 0
    }
    scheduleReconnect()
  }

  void connect()

  return {
    isConnected: () => connected,
    close: () => {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      controller.abort()
      connected = false
    options.onStateChange?.(false)
    },
  }
}

export const PreferencesEventsApi = {
  subscribePreferenceEvents,
  normalizePreferenceChange,
}

export default PreferencesEventsApi
