// ============================================
// 使用统计（v2 session.stats）
// ============================================
//
// 官方把「跨会话的聚合用量」算在服务端：活动日历、连续天数、模型分布、
// 工具成功率与 P50 耗时。这些数据本地算不出来 —— 前端只加载了当前会话的
// 一部分消息，而这里要覆盖整台服务器上的所有会话。
//
// 端点：`GET /api/experimental/session/stats`
//   query: from / to / project / timezone / tools=none|summary|detail
// 实测（一台跑了 8 天的机器）响应仅 5.4KB，开销很小。

import { getV2Client } from './sdkV2'
import { serverStore } from '../store/serverStore'

export interface StatsTokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface StatsToolUsage {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  /** 耗时中位数（毫秒）；服务端可能不提供 */
  durationP50?: number
}

export interface StatsToolTotals {
  calls: number
  succeeded: number
  failed: number
  unfinished: number
}

export interface StatsModelUsage {
  model: { id: string; providerID: string; variant?: string }
  steps: number
  tokens: StatsTokenUsage
  cost: number
}

export interface SessionStatsSummary {
  range: { from: number; to: number }
  sessions: number
  subagents: number
  prompts: number
  steps: number
  tokens: StatsTokenUsage
  cost: number
  /** 有活动的天数 */
  activeDays: number
  /** 当前连续活跃天数 */
  streak: number
  activity: Array<{ date: string; steps: number }>
  models: StatsModelUsage[]
  tools: {
    mode: 'none' | 'summary' | 'detail'
    totals?: StatsToolTotals
    usage?: StatsToolUsage[]
  }
}

export interface SessionStatsQuery {
  from?: number
  to?: number
  project?: string
  timezone?: string
  tools?: 'none' | 'summary' | 'detail'
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function adaptTokens(raw: unknown): StatsTokenUsage {
  const t = rec(raw)
  const cache = rec(t.cache)
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cache: { read: num(cache.read), write: num(cache.write) },
  }
}

function adaptToolUsage(raw: unknown): StatsToolUsage {
  const t = rec(raw)
  const p50 = t.durationP50
  return {
    name: String(t.name ?? ''),
    calls: num(t.calls),
    succeeded: num(t.succeeded),
    failed: num(t.failed),
    unfinished: num(t.unfinished),
    ...(typeof p50 === 'number' ? { durationP50: p50 } : {}),
  }
}

/** 把 v2 的 stats 响应适配成前端形状（字段缺失一律补 0，避免 UI 到处判空）。 */
export function adaptSessionStats(raw: unknown): SessionStatsSummary {
  const d = rec(raw)
  const range = rec(d.range)
  const tools = rec(d.tools)
  const mode = tools.mode
  return {
    range: { from: num(range.from), to: num(range.to) },
    sessions: num(d.sessions),
    subagents: num(d.subagents),
    prompts: num(d.prompts),
    steps: num(d.steps),
    tokens: adaptTokens(d.tokens),
    cost: num(d.cost),
    activeDays: num(d.activeDays),
    streak: num(d.streak),
    activity: list(d.activity).map(item => {
      const a = rec(item)
      return { date: String(a.date ?? ''), steps: num(a.steps) }
    }),
    models: list(d.models).map(item => {
      const m = rec(item)
      const model = rec(m.model)
      return {
        model: {
          id: String(model.id ?? ''),
          providerID: String(model.providerID ?? ''),
          ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
        },
        steps: num(m.steps),
        tokens: adaptTokens(m.tokens),
        cost: num(m.cost),
      }
    }),
    tools: {
      mode: mode === 'summary' || mode === 'detail' ? mode : 'none',
      ...(tools.totals
        ? {
            totals: {
              calls: num(rec(tools.totals).calls),
              succeeded: num(rec(tools.totals).succeeded),
              failed: num(rec(tools.totals).failed),
              unfinished: num(rec(tools.totals).unfinished),
            },
          }
        : {}),
      ...(Array.isArray(tools.usage) ? { usage: tools.usage.map(adaptToolUsage) } : {}),
    },
  }
}

/**
 * 拉取使用统计。
 *
 * `tools` 默认 `detail`（含每个工具的调用次数与 P50 耗时），实测响应仍只有
 * 几 KB；不需要工具明细时传 `none` 更省。
 */
export async function getSessionStats(
  query: SessionStatsQuery = {},
  serverId?: string,
): Promise<SessionStatsSummary> {
  const sid = serverId ?? serverStore.getActiveServerId()
  const client = getV2Client(sid)
  const res = await client.session.stats({
    from: query.from,
    to: query.to,
    project: query.project,
    timezone: query.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    tools: query.tools ?? 'detail',
  })
  return adaptSessionStats(res)
}
