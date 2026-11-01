// ============================================
// hostMetricsSocket - 订阅面板的实时主机指标（Socket.IO /metrics 命名空间）
//
// 为什么不用轮询：
//   主机数据本来就是主机 Agent 通过心跳上报的，面板收到后立刻经 MetricsHub
//   广播 metrics:update。再让前端定时查库纯属多绕一道 —— 数据 10~30 秒才更新
//   一条，5 秒轮询有 6~8 次拿回同一个值。
//
// 通道说明（实测 2026-11-01）：
//   wss://<domain>/socket.io/?EIO=4&transport=websocket
//   → 发 "40/metrics,"            注册命名空间
//   ← 收 "40/metrics,{sid}"        连接确认
//   ← 收 42/metrics,["metrics:update",{serverId, metrics, timestamp}]
//
//   推送体里的 metrics 已是面板拍平后的字段（cpu / mem_percent / load1 ...），
//   与 REST 兜底接口的字段不同，需要各自解析。
//
// 鉴权：/metrics 命名空间**匿名可读**（面板公开状态页也用它），OCC 不需要带
// 模块 token。这里只按 serverId 过滤出自己要看的机器。
// ============================================

/** Engine.IO / Socket.IO 报文前缀 */
const EIO_OPEN = '0'
const EIO_PING = '2'
const EIO_PONG = '3'
const SIO_CONNECT = '40'
const SIO_EVENT = '42'
const METRICS_NAMESPACE = '/metrics'

/** 重连退避：与侧栏健康探测的节奏对齐，避免面板抖动时刷屏 */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

/** 面板实时推送的原始负载（只取用得到的字段） */
export interface RealtimeHostMetrics {
  serverId: string
  cpu?: number
  load1?: number
  load5?: number
  load15?: number
  cores?: number
  logicalCores?: number
  memPercent?: number
  memUsedMB?: number
  memTotalMB?: number
  diskPercent?: number
  platform?: string
  timestamp?: number
}

interface MetricsUpdatePayload {
  serverId?: unknown
  metrics?: Record<string, unknown>
  timestamp?: unknown
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 解析 "4106/23972MB" 这种面板格式的字符串 */
function parseMemPair(value: unknown): { used?: number; total?: number } {
  if (typeof value !== 'string') return {}
  const match = value.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*MB/i)
  if (!match) return {}
  return { used: Number.parseFloat(match[1]), total: Number.parseFloat(match[2]) }
}

/**
 * 把面板推送的 metrics 对象规整成本模块的类型。
 *
 * 面板同时给了数值型和字符串型两种字段（`cpu` 与 `cpu_usage`、`mem_percent`
 * 与 `mem`），优先取数值型；字符串型只在数值缺失时兜底。
 */
export function normalizeRealtimeMetrics(payload: MetricsUpdatePayload): RealtimeHostMetrics | null {
  const serverId = typeof payload.serverId === 'string' ? payload.serverId : ''
  if (!serverId) return null
  const raw = payload.metrics ?? {}

  const memPair = parseMemPair(raw.mem)
  const memUsedMB = num(raw.mem_used_mb) ?? memPair.used
  const memTotalMB = num(raw.mem_total_mb) ?? memPair.total

  return {
    serverId,
    cpu: num(raw.cpu),
    load1: num(raw.load1),
    load5: num(raw.load5),
    load15: num(raw.load15),
    cores: num(raw.cores),
    logicalCores: num(raw.logical_cores),
    memPercent: num(raw.mem_percent) ?? num(raw.memory),
    memUsedMB,
    memTotalMB,
    diskPercent: num(raw.disk_percent) ?? num(raw.disk_usage),
    platform: typeof raw.platform === 'string' ? raw.platform : undefined,
    timestamp: num(payload.timestamp),
  }
}

export interface HostMetricsSocketOptions {
  /** 面板域名，如 https://dsukhub.com */
  domain: string
  /** 收到推送时回调（已规整） */
  onMetrics: (metrics: RealtimeHostMetrics) => void
  /** 连接状态变化，供 UI 显示「实时/已断开」 */
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void
}

/** 订阅实时主机指标；返回取消函数 */
export function subscribeHostMetrics({ domain, onMetrics, onStateChange }: HostMetricsSocketOptions): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    onStateChange?.('connecting')

    let url: URL
    try {
      url = new URL('/socket.io/?EIO=4&transport=websocket', domain)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    } catch {
      onStateChange?.('closed')
      return
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(url.toString())
    } catch {
      scheduleReconnect()
      return
    }
    ws = socket

    socket.onmessage = event => {
      const frame = typeof event.data === 'string' ? event.data : ''
      if (!frame) return

      // Engine.IO 握手：服务器先发 open 包，此时才能连 Socket.IO 命名空间
      if (frame.startsWith(EIO_OPEN) && !frame.startsWith(SIO_CONNECT)) {
        socket.send(`${SIO_CONNECT}${METRICS_NAMESPACE},`)
        return
      }
      // 心跳：必须回 pong，否则服务端会按 pingTimeout 断开
      if (frame === EIO_PING) {
        socket.send(EIO_PONG)
        return
      }
      if (frame.startsWith(`${SIO_CONNECT}${METRICS_NAMESPACE}`)) {
        attempt = 0
        onStateChange?.('open')
        return
      }
      if (frame.startsWith(`${SIO_EVENT}${METRICS_NAMESPACE},`)) {
        const payload = frame.slice(`${SIO_EVENT}${METRICS_NAMESPACE},`.length)
        try {
          const parsed: unknown = JSON.parse(payload)
          if (!Array.isArray(parsed) || parsed[0] !== 'metrics:update') return
          const normalized = normalizeRealtimeMetrics(parsed[1] as MetricsUpdatePayload)
          if (normalized) onMetrics(normalized)
        } catch {
          // 单帧解析失败不影响后续推送
        }
      }
    }

    socket.onclose = () => {
      if (closed) return
      onStateChange?.('closed')
      scheduleReconnect()
    }
    socket.onerror = () => {
      // onclose 紧随其后，重连统一在那里处理
    }
  }

  const scheduleReconnect = () => {
    if (closed) return
    attempt += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
    retryTimer = setTimeout(connect, delay)
  }

  connect()

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    try {
      ws?.close()
    } catch {
      // 忽略关闭异常
    }
  }
}
