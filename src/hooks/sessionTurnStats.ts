// ============================================
// sessionTurnStats - 会话累计统计
//
// 从可见消息里折叠出整段会话的耗时与用量指标，供统计面板显示。
//
// 口径说明（与 DeepSeek harness 的 sessionStats 投影对齐，但受限于
// 我们的数据模型，两处只能近似）：
//
//   模型用时  = Σ (msg.completed - msg.created) - Σ 工具执行时长
//   工具用时  = Σ (tool.state.time.end - tool.state.time.start)
//   TTFT 平均 = Σ 首 part 起始时间 - msg.created，再除以有效条数
//   输出速度  = 输出 token / 文本 part 合并后的生成时间
//
// 为什么是近似：上游 opencode 的 step-start / step-finish part 不带时间戳
// （见 types/message.ts），无法精确切分单条消息内的多次 step。因此
// 「模型用时」用整条消息时长减去工具时长来还原，在多 step 场景下会与
// 真实生成时间有偏差，但工具时长本身是逐次精确的，相减后误差不会累积。
//
// TTFT 用「第一个带时间的 part」近似首 token：opencode 在首个 token 到达
// 时才落 text / reasoning part，因此该时间戳即首次产出时刻。
// ============================================

import type { Message, Part } from '../types/message'
import { messageCompletedAt } from '../store/messagePartMerge'

export interface SessionTurnStats {
  /** 轮数：用户消息数（与 DeepSeek 的 turn 计数口径一致） */
  turns: number
  /** 步数：assistant 消息数 */
  steps: number
  /** 模型生成用时（ms），已扣除工具执行时长 */
  modelMs: number
  /** 工具调用累计用时（ms） */
  toolMs: number
  /** 首 token 平均等待（ms），无有效样本时为 null */
  ttftMs: number | null
  /** 输出速度（tok/s），无有效样本时为 null */
  tokensPerSec: number | null
  /** 本轮统计覆盖的输出 token 总数 */
  outputTokens: number
  /** 缓存读取 token 总数 */
  cacheReadTokens: number
  /** 计费输入 token 总数（未缓存 + 缓存读 + 缓存写） */
  inputTokens: number
  /** 缓存命中率百分比，分母为 0 时为 null */
  cacheHitPercent: number | null
  /** 是否存在任何可用统计（无消息时为 false） */
  hasData: boolean
}

export const EMPTY_SESSION_TURN_STATS: SessionTurnStats = {
  turns: 0,
  steps: 0,
  modelMs: 0,
  toolMs: 0,
  ttftMs: null,
  tokensPerSec: null,
  outputTokens: 0,
  cacheReadTokens: 0,
  inputTokens: 0,
  cacheHitPercent: null,
  hasData: false,
}

/** 取一个 part 的可用时间窗口（text / reasoning 都带 time） */
function partTimeWindow(part: Part): { start: number; end: number } | null {
  if (part.type !== 'text' && part.type !== 'reasoning') return null
  const time = part.time
  if (!time) return null
  const start = time.start
  const end = time.end
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null
  return { start, end }
}

/** 合并重叠区间，返回总时长（ms）。生成被工具调用打断时会产生多段窗口 */
export function mergeIntervalMs(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  let total = 0
  let segStart = sorted[0].start
  let segEnd = sorted[0].end
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    if (current.start <= segEnd) {
      segEnd = Math.max(segEnd, current.end)
    } else {
      total += segEnd - segStart
      segStart = current.start
      segEnd = current.end
    }
  }
  return total + (segEnd - segStart)
}

/**
 * 折叠整段会话的统计。
 *
 * 只统计已完成（有 completed 且晚于 created）的 assistant 消息：正在流式的
 * 那条尚未结算，纳入会得到偏小的速度与偏短的用时。
 */
export function computeSessionTurnStats(messages: Message[]): SessionTurnStats {
  let turns = 0
  let steps = 0
  let modelMs = 0
  let toolMs = 0
  let ttftSum = 0
  let ttftSamples = 0
  let decodeMs = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let inputTokens = 0

  for (const message of messages) {
    const info = message.info
    if (info.role === 'user') {
      turns += 1
      continue
    }

    const created = info.time?.created
    // v2 轻量消息可能没有 time 字段：安全读取，避免整段统计崩溃
    const completed = messageCompletedAt(message)

    // 工具时长逐次累加：不依赖消息是否结算，流式中的工具调用也能计入
    let messageToolMs = 0
    let firstPartStart: number | null = null
    const textIntervals: { start: number; end: number }[] = []

    for (const part of message.content) {
      if (part.type === 'tool') {
        const start = part.state.time?.start
        const end = part.state.time?.end
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          messageToolMs += end - start
        }
        continue
      }

      const window = partTimeWindow(part)
      if (!window) continue
      if (firstPartStart === null || window.start < firstPartStart) {
        firstPartStart = window.start
      }
      if (part.type === 'text') textIntervals.push(window)
    }

    toolMs += messageToolMs

    /**
     * 步数：轮次骨架路径下，一整轮的 N 次工具调用被聚合成一条助手消息，
     * 消息数不再等于步数。此时用骨架带回的 `compressedStats.stepCount` 还原
     * （它正是该轮的工具调用总数），否则统计面板会显示「182 轮 · 0 步」。
     */
    const skeletonSteps = message.isCompressed ? (message.compressedStats?.stepCount ?? 0) : 0

    if (!created || !completed || completed <= created) {
      // 未结算：骨架轮次的步数仍然可以计入（它已经是历史事实）
      if (skeletonSteps > 0) steps += skeletonSteps
      continue
    }
    steps += 1 + skeletonSteps

    const messageMs = completed - created
    // 扣除工具时长，还原模型自身耗时；工具时长异常大于消息时长时下限为 0
    modelMs += Math.max(0, messageMs - messageToolMs)

    // TTFT：消息起始到首个 part 产出之间的等待
    if (firstPartStart !== null && firstPartStart >= created) {
      ttftSum += firstPartStart - created
      ttftSamples += 1
    }

    // v2 assistant 消息在流式/出错时 tokens 可能缺省；防御性读取避免崩溃。
    const tokens = info.tokens
    const cached = tokens?.cache?.read ?? 0
    const written = tokens?.cache?.write ?? 0
    cacheReadTokens += cached
    inputTokens += (tokens?.input ?? 0) + cached + written
    outputTokens += tokens?.output ?? 0

    // 输出速度分母：文本 part 合并窗口；缺时间窗口时退回整条消息时长
    const textMs = mergeIntervalMs(textIntervals)
    decodeMs += textMs > 0 ? textMs : messageMs
  }

  const cacheDenominator = inputTokens
  return {
    turns,
    steps,
    modelMs,
    toolMs,
    ttftMs: ttftSamples > 0 ? ttftSum / ttftSamples : null,
    tokensPerSec: decodeMs > 0 && outputTokens > 0 ? outputTokens / (decodeMs / 1000) : null,
    outputTokens,
    cacheReadTokens,
    inputTokens,
    cacheHitPercent: cacheDenominator > 0 ? (cacheReadTokens / cacheDenominator) * 100 : null,
    hasData: turns > 0 || steps > 0,
  }
}

export function isSameSessionTurnStats(a: SessionTurnStats, b: SessionTurnStats): boolean {
  return (
    a.turns === b.turns &&
    a.steps === b.steps &&
    a.modelMs === b.modelMs &&
    a.toolMs === b.toolMs &&
    a.ttftMs === b.ttftMs &&
    a.tokensPerSec === b.tokensPerSec &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.inputTokens === b.inputTokens &&
    a.cacheHitPercent === b.cacheHitPercent &&
    a.hasData === b.hasData
  )
}

/**
 * 按 messages 数组引用缓存统计结果。
 *
 * 同一会话可能有多个消费者（InputFooter 的速度/统计、WorkStatus 面板）在同一
 * 帧内各算一遍。messageStore 每帧 flush 才换数组引用，同一个引用上的结果必然
 * 相同，用 WeakMap 按引用复用即可把重复遍历合并为一次；数组被替换后旧条目由
 * GC 回收，不会无界增长。流式期间 text 原地拼接带来的一帧内细微滞后 <16ms，
 * 在 200ms 节流显示下不可见。
 */
const turnStatsMemo = new WeakMap<Message[], SessionTurnStats>()

export function computeSessionTurnStatsCached(messages: Message[]): SessionTurnStats {
  const cached = turnStatsMemo.get(messages)
  if (cached) return cached
  const next = computeSessionTurnStats(messages)
  turnStatsMemo.set(messages, next)
  return next
}
