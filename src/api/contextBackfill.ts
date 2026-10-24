// ============================================
// 上下文用量兜底（session.context）
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
// 此外它还补**上下文占用快照**（contextUsage）：
//
//   走 aiagent 网关时首屏用的是「轮次骨架」投影（每轮只留提问 + 最终回复
//   + 过程计数），骨架里的 assistant 消息**不带 tokens**。于是进入会话后
//   `lastAssistantWithTokens` 为 null，圆环只能按字符估算 —— 表现为「刚进去
//   用量不对，发一条消息后才对」。发消息会拉完整消息，tokens 才有值。
//
//   这里把 `session.context` 里最后一条带 tokens 的 assistant 存成快照，
//   让圆环在「没有任何一条消息带 tokens」时也能显示真实用量。
//
// 设计约束：
// 1. **不阻塞首屏**：这是补数据，失败或慢都不该影响消息显示。
// 2. 每个会话每次加载只拉一次（内存去重），避免翻页/重渲染反复请求。
// 3. 只在事件值缺失时写入（见 messageStore.recordSessionUsageFallback）。

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

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * 从 `session.context` 汇总会话累计用量并写入 store。
 *
 * 口径说明：这里把每条 assistant 的 `tokens` 相加，与官方「累计消耗」一致
 * （每条 assistant 的 tokens 是**该次请求**的用量，累加即整个上下文的消耗）。
 * 注意 `cache.read` 也计入 totalTokens（见 computeSessionStats），但这里只提供
 * input/output/reasoning/cache 四组原始值，由上层统一口径。
 *
 * 同时回填**上下文占用快照**：取最后一条带 tokens 的 assistant（官方口径，
 * 见 `lastAssistantWithUsage`）。走网关骨架投影时消息本身不带 tokens，
 * 没有这份快照圆环就只能按字符估算 —— 这正是「刚进会话用量不对、
 * 发一条消息后才正常」的原因。
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

    for (const item of messages) {
      const m = rec(item)
      if (m.type !== 'assistant') continue
      sawAssistant = true
      const tokens = rec(m.tokens)
      const cache = rec(tokens.cache)
      input += num(tokens.input)
      output += num(tokens.output)
      reasoning += num(tokens.reasoning)
      cacheRead += num(cache.read)
      cacheWrite += num(cache.write)
      cost += num(m.cost)

      const usage: TokenUsage = {
        input: num(tokens.input),
        output: num(tokens.output),
        reasoning: num(tokens.reasoning),
        cache: { read: num(cache.read), write: num(cache.write) },
      }
      // 只认真正有 token 的记录：全 0 说明这条消息还没结算
      if (usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write > 0) {
        contextSnapshot = { tokens: usage, cost: num(m.cost) }
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
