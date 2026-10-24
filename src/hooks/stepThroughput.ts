// ============================================
// 输出速度（tok/s）口径
//
// 与官方 opencode 保持同一套算法，来源：
//   packages/tui/src/routes/session/rows.ts  →  turnTokensPerSecond()
//
// 官方口径（逐条核对过源码，不是估算）：
//
//   分子 = Σ (tokens.output + tokens.reasoning)
//   分母 = Σ (time.streamed − time.created)
//
// 三点关键差异，也是 OCC 此前数值偏低的根因：
//
// 1. 分母用 `streamed` 而不是 `completed`。
//    `streamed`（session.step.streamed）在模型吐完内容时打点，
//    `completed`（session.step.ended）在其后、工具收尾完成时打点。
//    用 completed 会把工具执行与收尾时间也算成生成时间。
//
// 2. text part 在 v2 里**没有 time 字段**（只有 reasoning / tool 有）。
//    早先按 text part 的时间窗口算速度，永远拿不到样本，实际一直在走
//    「整条消息时长」兜底 —— 那个口径包含 TTFT 与工具等待，系统性偏低。
//
// 3. 分子要把 reasoning 算进去。推理 token 同样是模型吐出来的，
//    只算 output 会低估吞吐（尤其是强推理模型）。
//
// 聚合顺序也照抄官方：先把所有 step 的 token 与时长分别累加，最后做一次除法，
// 这样每个 step 按自己的 provider 活跃时长加权，长 step 不会被短 step 稀释。
// ============================================

import type { Message } from '../types/message'
import { messageCompletedAt } from '../store/messagePartMerge'

/** 单条 assistant 消息的「模型活跃时长」与 token 计数 */
export interface StepThroughput {
  /** 生成窗口（ms）；无法确定时为 0 */
  durationMs: number
  /** 该步可计入速度的 token：output + reasoning */
  tokens: number
  /** 时长是否来自权威的 streamed 打点（否则为兜底估算） */
  authoritative: boolean
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
 * 取单条 assistant 消息的生成窗口。
 *
 * 优先级：
 *   1. `streamed − created`：官方口径，最准
 *   2. text part 合并窗口：v1 / 旧数据可能有 part 时间
 *   3. `completed − created`：最后兜底（含工具等待，数值会偏低）
 */
export function stepGenerationWindow(message: Message): { durationMs: number; authoritative: boolean } {
  const created = message.info.time?.created
  const streamed = message.info.time?.streamed

  // ① 官方 `time.streamed`：容器里 text part 不带时间，但消息级 streamed 有。
  //    逐字核对官方 turnTokensPerSecond：它只用 time.streamed，不用 part 时间，
  //    所以这里的 streamed 是「结束时刻」，与 created 求差即生成窗口。
  if (typeof created === 'number' && typeof streamed === 'number' && streamed > created) {
    return { durationMs: streamed - created, authoritative: true }
  }

  // ② text part 合并窗口（v2 的 text part 实际不带 time，这条路通常不命中）
  const intervals: { start: number; end: number }[] = []
  for (const part of message.content) {
    if (part.type !== 'text') continue
    const time = part.time
    if (!time) continue
    const start = time.start
    const end = time.end
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue
    intervals.push({ start, end })
  }
  if (intervals.length > 0) {
    return { durationMs: mergeIntervalMs(intervals), authoritative: false }
  }

  // ③ 整条消息时长兜底
  const completed = messageCompletedAt(message)
  if (typeof created === 'number' && typeof completed === 'number' && completed > created) {
    return { durationMs: completed - created, authoritative: false }
  }

  return { durationMs: 0, authoritative: false }
}

/** 单步吞吐样本；无有效时长时返回 null（token 允许为 0） */
export function stepThroughput(message: Message): StepThroughput | null {
  if (message.info.role !== 'assistant') return null
  const tokens = (message.info.tokens?.output ?? 0) + (message.info.tokens?.reasoning ?? 0)
  const { durationMs, authoritative } = stepGenerationWindow(message)
  if (durationMs <= 0) return null
  return { durationMs, tokens, authoritative }
}

/**
 * 取一整轮的输出速度。
 *
 * 严格要求「轮内每一步都有生成窗口」：只要有一个 step 还没结算
 * （流式中的最后一步没有 streamed/completed），整轮就返回 null，
 * 调用方据此显示上一轮的稳定值 —— 否则会拿残缺样本算出虚高速度。
 *
 * 与官方一致的地方：token 为 0 的 step 仍参与（它贡献时长、不贡献 token），
 * 不能因为它把整轮丢掉；官方同样只按 `streamed === undefined` 过滤。
 */
export function turnThroughput(messages: Message[]): number | null {
  const steps = messages.filter(message => message.info.role === 'assistant')
  if (steps.length === 0) return null

  const windows = steps.map(stepGenerationWindow)
  if (windows.some(window => window.durationMs <= 0)) return null

  let tokens = 0
  let durationMs = 0
  steps.forEach((step, index) => {
    const info = step.info as { tokens?: { output?: number; reasoning?: number } }
    tokens += (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
    durationMs += windows[index].durationMs
  })

  if (durationMs <= 0) return null
  return tokens / (durationMs / 1000)
}

/**
 * 按官方口径把若干 step 聚合成一个速度值。
 *
 * 先累加再相除（不是各步求平均）：每个 step 按自身活跃时长加权。
 */
export function aggregateThroughput(steps: StepThroughput[]): number | null {
  let tokens = 0
  let durationMs = 0
  for (const step of steps) {
    tokens += step.tokens
    durationMs += step.durationMs
  }
  if (tokens <= 0 || durationMs <= 0) return null
  return tokens / (durationMs / 1000)
}

/**
 * 按轮次边界切分消息，返回每一轮内的 assistant 消息。
 *
 * 边界与官方一致：`user` / `synthetic` 开启新一轮，`idle` 关闭当前轮。
 * v2 的 idle 消息在适配层会被丢弃（不进对话流），所以这里同时容忍
 * 「没有 idle」的 legacy 形态：遇到下一个 user 即为上一轮结束。
 */
export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  let current: Message[] | null = null
  for (const message of messages) {
    if (message.info.role === 'user') {
      current = []
      turns.push(current)
      continue
    }
    if (!current) continue
    current.push(message)
  }
  return turns
}
