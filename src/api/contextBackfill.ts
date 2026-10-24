// ============================================
// 上下文 / 用量兜底（session.context）
// ============================================
//
// 会话累计 token / 花费的唯一实时来源是 `session.usage.updated` 事件，而它是
// **ephemeral**（不落盘、重连不补发）。于是：
//
//   - 刷新页面 / 断线重连 / 换设备打开同一会话 → 该事件永远收不到
//   - 侧栏统计退化为「按已加载消息累加」
//   - 首屏只加载 50 条，真实上下文有 300+ 条 → 数字小一个数量级
//
// `session.context` 返回「最后一次压缩之后」的完整消息，正好能把这个洞补上。
//
// ============================================
// 走 aiagent 网关时还有第二个洞：骨架投影不带 tokens
// ============================================
//
// 首屏用「轮次骨架」投影时，每轮只留「提问 + 最终回复 + 过程计数」，
// assistant 消息上的 `tokens` / `time.streamed` / `model` **全部被剥掉**。
// 后果是三处同时失效：
//
//   - 上下文圆环：没有实测值 → 按字符估算（实测偏小 3 倍）
//   - 轮次统计：输出 token / 缓存命中率 / TPS 全是「—」或 0
//   - 底部 TPS：算不出生成窗口
//
// 发一条消息后这些值会「突然正常」——因为那条消息走完整拉取，带 tokens。
//
// 骨架里回复用的是**真实消息 id**，所以可以拿 `session.context` 按 id 回填：
// 它不经过骨架投影（网关只拦 `/api/session/{id}/message`），字段完整。
//
// 设计约束：
// 1. **不阻塞首屏**：这是补数据，失败或慢都不该影响消息显示。
// 2. 每个会话每次加载只拉一次（内存去重），避免翻页/重渲染反复请求。
// 3. 只在缺失时写入（见 messageStore 的各个 record* 方法）。

import { nativeGetSessionContext } from '../api/v2NativeSession'
import { messageStore } from '../store/messageStore'
import { rawSessionIdOfKey } from '../store/messagePartMerge'
import { sessionKeyToServerId } from '../utils/sessionKey'
import { logger } from '../utils'
import type { TokenUsage } from '../types/message'

/** 已经补过用量的会话（含失败），避免重复请求 */
const backfilled = new Set<string>()

/** 测试用 */
export function resetContextBackfill(): void {
  backfilled.clear()
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 单条 assistant 的权威用量快照 */
export interface AssistantUsageSnapshot {
  tokens: TokenUsage
  cost: number
  created?: number
  streamed?: number
  completed?: number
}

function tokenUsageOf(raw: unknown): TokenUsage {
  const t = rec(raw)
  const cache = rec(t.cache)
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cache: { read: num(cache.read), write: num(cache.write) },
  }
}

function usageTotal(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
}

/**
 * 从 `session.context` 汇总会话累计用量、上下文快照，并按 id 回填骨架消息。
 *
 * 口径说明（与官方一致）：
 *   - 累计消耗 = Σ 每条 assistant 的 tokens（每条是该次请求的用量）
 *   - 上下文占用 = **最后一条**带 tokens 的 assistant（不是累加）
 *     见 opencode `client/src/solid/usage.ts` 的 lastAssistantWithUsage
 */
export async function backfillSessionUsage(sessionKey: string): Promise<void> {
  if (backfilled.has(sessionKey)) return
  backfilled.add(sessionKey)

  const serverId = sessionKeyToServerId(sessionKey)
  const bareId = rawSessionIdOfKey(sessionKey)
  if (!bareId) return

  try {
    const messages = await nativeGetSessionContext(serverId, bareId)
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    let cost = 0
    let sawAssistant = false
    /** 最后一条带 tokens 的 assistant（上下文占用的权威来源） */
    let contextSnapshot: { tokens: TokenUsage; cost: number } | null = null
    /** id → 该条 assistant 的权威用量（用于回填骨架消息） */
    const perMessage = new Map<string, AssistantUsageSnapshot>()

    for (const item of messages) {
      const m = rec(item)
      if (m.type !== 'assistant') continue
      sawAssistant = true

      const tokens = tokenUsageOf(m.tokens)
      input += tokens.input
      output += tokens.output
      reasoning += tokens.reasoning
      cacheRead += tokens.cache.read
      cacheWrite += tokens.cache.write
      const messageCost = num(m.cost)
      cost += messageCost

      // 时间字段：骨架里 created/completed 都被替换成了轮次时间，
      // streamed 则完全缺失。有就带上，供速度统计还原生成窗口。
      const time = rec(m.time)
      const id = typeof m.id === 'string' ? m.id : ''
      if (id) {
        perMessage.set(id, {
          tokens,
          cost: messageCost,
          created: optNum(time.created),
          streamed: optNum(time.streamed),
          completed: optNum(time.completed),
        })
      }

      // 只认真正有 token 的记录：全 0 说明这条消息还没结算
      if (usageTotal(tokens) > 0) {
        contextSnapshot = { tokens, cost: messageCost }
      }
    }

    // 没有任何 assistant：说明会话还没跑过，交给上层按消息估算即可
    if (!sawAssistant) return

    messageStore.recordSessionUsageFallback(
      sessionKey,
      { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
      cost,
    )

    // 上下文占用快照：让「刚进入会话」就能显示真实用量，而不是等发消息。
    if (contextSnapshot) {
      messageStore.recordContextUsageSnapshot(sessionKey, contextSnapshot.tokens, contextSnapshot.cost)
    }

    /**
     * 按 id 回填骨架消息的 tokens / 时间 / 模型。
     *
     * 这是「轮次统计全是 —、TPS 为 0」的唯一修法：骨架投影把这些字段剥掉了，
     * 而它们无法从任何前端可见数据反推（字符数估不出 token，part 也没有时间）。
     * 只回填 id 能对上的消息，对不上（未定稿轮次 / 已压缩）的保持原样。
     */
    messageStore.applyUsageBackfill(sessionKey, perMessage)
  } catch (error) {
    // 补数据失败不影响任何主流程；下次重新打开会话会再试（backfilled 已置位，
    // 因此同一会话本次不再重试，避免失败抖动放大请求）。
    //
    // 这里再包一层 try：本函数是从 loadSession 的 .then 里 `void` 调用的，
    // 一旦 catch 内部抛错（例如日志实现异常、mock 缺失导出），就会变成
    // unhandled rejection —— 测试里表现为「0 个断言失败但退出码非 0」，
    // 线上则可能污染错误上报。兜底逻辑自身绝不能成为新的故障源。
    try {
      logger.warn('[contextBackfill] failed to backfill session usage', { sessionKey, error })
    } catch {
      // 日志本身失败：静默
    }
  }
}
