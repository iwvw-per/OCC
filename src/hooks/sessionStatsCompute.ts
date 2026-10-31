import type { AssistantMessageInfo, Message, TokenUsage } from '../types/message'
import type { SessionStats } from './sessionStatsTypes'
import type { CompactionMarker } from '../api/v2/message'

/**
 * 字符 → token 的粗略换算。
 *
 * 官方口径大致是「英文约 4 字符 1 token」，但**中文/日文/韩文等 CJK 字符
 * 约 1 字 1 token**，直接 /4 会把中文内容低估 3～4 倍。会话里中文占一成时，
 * 估算就已经明显偏小了，所以这里按字符类别分别折算。
 *
 * 这只是兜底路径（正常情况用服务端实测 tokens），精度要求不高，但
 * 「系统性低估」会让用户在压缩前完全看不出快满了，因此必须按类别折算。
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 累计器：分别记 CJK 与非 CJK 字符数，避免把大段文本重复拼成字符串再遍历。 */
interface CharTally {
  cjk: number
  rest: number
}

function emptyTally(): CharTally {
  return { cjk: 0, rest: 0 }
}

function addText(tally: CharTally, text: string | undefined): void {
  if (!text) return
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (CJK_RE.test(text[i])) cjk++
  }
  tally.cjk += cjk
  tally.rest += text.length - cjk
}

function tallyTokens(tally: CharTally): number {
  return Math.ceil(tally.cjk + tally.rest / 4)
}

/**
 * 粗略的 token 估算，**只用于与上下文占用无关的场景**（如消息长度提示）。
 *
 * 上下文占用不再用它 —— 见 computeSessionStats 里关于「只认服务端实测值」的说明。
 */
export function estimateTokensFromText(text: string): number {
  const tally = emptyTally()
  addText(tally, text)
  return tallyTokens(tally)
}



/**
 * 压缩后的权威上下文用量（来自 v2 `session.compaction.ended` 的 tokens）。
 *
 * 为什么需要它：压缩把旧轮次换成摘要后，历史消息已不代表「当前上下文」。
 * 只有服务端在压缩事件里给的 tokens 才是实测值。
 *
 * 只在该用量「不早于」最近一次带 tokens 的 assistant 消息时才采用：之后若又
 * 跑了新的轮次，消息里的真实用量更新，压缩快照就应当让位。
 */
export interface CompactionUsageHint {
  tokens: TokenUsage
  at: number
}

function tokenUsageTotal(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read || 0) +
    (tokens.cache?.write || 0)
  )
}

function contextFromCompaction(
  compaction: CompactionUsageHint | undefined,
  lastAssistantWithTokens: AssistantMessageInfo | null,
): number | null {
  if (!compaction) return null
  const snapshotAt = compaction.at
  if (!Number.isFinite(snapshotAt)) return null
  const lastCreated = lastAssistantWithTokens?.time?.created
  // 压缩之后又产生了带 tokens 的消息：上下文已被新一轮刷新，快照过期。
  if (typeof lastCreated === 'number' && lastCreated > snapshotAt) return null
  const total = tokenUsageTotal(compaction.tokens)
  return total > 0 ? total : null
}


export function computeSessionStats(
  messages: Message[],
  /**
   * 该模型的上下文窗口。传 0（或缺省）表示**未知**，此时百分比为 null。
   *
   * 不设「看起来合理」的默认值：实测某模型真实窗口 1000000，而旧默认 200000
   * 会让百分比虚高 5 倍。未知就该显示未知。
   */
  contextLimit: number = 0,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  _compactionMarker?: CompactionMarker,
  contextUsageSnapshot?: { tokens: TokenUsage; cost: number; at: number },
): SessionStats {
  // v2 的 assistant 消息在流式/出错时 tokens 可能缺省（undefined）；防御性读取，
  // 否则 tokenTotal → tokens.input 抛出 "Cannot read properties of undefined"。
  const tokenTotal = tokenUsageTotal

  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalCost = 0
  let lastAssistantWithTokens: AssistantMessageInfo | null = null

  for (const msg of messages) {
    if (msg.info.role === 'assistant') {
      const info = msg.info as AssistantMessageInfo
      const hasTokens = tokenTotal(info.tokens) > 0

      if (hasTokens) {
        const tokens = info.tokens
        inputTokens += tokens.input ?? 0
        outputTokens += tokens.output ?? 0
        reasoningTokens += tokens.reasoning ?? 0
        cacheRead += tokens.cache?.read || 0
        cacheWrite += tokens.cache?.write || 0
      }
      if (info.cost) {
        totalCost += info.cost
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== 'assistant') continue
    const info = msg.info as AssistantMessageInfo
    if (tokenTotal(info.tokens) <= 0) continue
    lastAssistantWithTokens = info
    break
  }

  // 会话累计值优先用服务端口径：压缩会裁掉旧轮次，按可见消息累加会偏小。
  const usage = sessionUsage
  if (usage) {
    const t = usage.tokens
    inputTokens = t.input ?? 0
    outputTokens = t.output ?? 0
    reasoningTokens = t.reasoning ?? 0
    cacheRead = t.cache?.read || 0
    cacheWrite = t.cache?.write || 0
    totalCost = usage.cost || 0
  }

  const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheRead + cacheWrite
  /**
   * 压缩后的上下文用量，只用服务端实测值。
   *
   * `contextFromCompaction` 来自 `session.compaction.ended` 的 tokens（服务端
   * 实测）；`contextFromCompactionMarker` 是按字符数推算的，现在不再采用 ——
   * 它正是「压缩完圆环数字对不上」的来源之一。
   */
  const measuredCompaction = contextFromCompaction(compactionUsage, lastAssistantWithTokens)
  const compactionContext = measuredCompaction
  /**
   * 上下文快照（`session.context`）的可用性。
   *
   * 只在「消息里完全没有实测值」时启用 —— 这正是走网关骨架投影的典型情况：
   * 首屏每轮只留提问 + 最终回复，不带 tokens，于是 lastAssistantWithTokens 为 null。
   *
   * 一旦消息里出现实测值（用户发过消息 → 拉到完整消息），就让它让位：
   * 消息级值一定比快照新。
   */
  const snapshotContext =
    contextUsageSnapshot && !lastAssistantWithTokens
      ? (() => {
          const total = tokenUsageTotal(contextUsageSnapshot.tokens)
          return total > 0 ? total : null
        })()
      : null
  /**
   * 上下文占用**只认服务端实测值**。
   *
   * 历史上这里有三条估算兜底（整段字符估算、压缩标记按字符换算、末尾用户输入
   * 按字符折算）。它们都有同一个毛病：**系统性偏低且无法自证**。
   *
   *   - 图片/附件不计入（工具结果里的 `file` 块被主动丢弃，只留体积数字），
   *     用户发一张截图，估算值几乎不动；
   *   - 中文按 1 字 1 token、英文按 4 字符 1 token 折算，与实际分词器有偏差；
   *   - 压缩摘要只有字符数、没有原文，只能按纯英文下界折算。
   *
   * 这些偏差直接决定圆环百分比，而用户会用「快满了吗」来决定要不要压缩 ——
   * 一个偏低且无法验证的数字比「未知」更危险。因此现在：
   *
   *   有服务端实测值 → 用它（`contextUsageSnapshot` / 消息 tokens / 压缩 tokens）
   *   没有任何实测值 → `contextUsed = null`，界面显示「—」
   *
   * 代价是走网关骨架投影时、首屏 `session.context` 回填完成前会短暂显示未知。
   * 那段时间本来就不知道真实占用，显示「—」比显示一个错的数字更诚实。
   */
  /**
   * 压缩之后，压缩之前那条 assistant 的 tokens 已不代表当前上下文。
   *
   * 压缩把旧轮次换成了摘要：那条实测值描述的是**压缩前**的 prompt，用它会把
   * 圆环钉在压缩前的高水位。所以只要最近一次压缩晚于这条消息，就作废它。
   *
   * 判据只用 `compactionUsage`（服务端 tokens），**不用 marker 的时间**：
   * marker 的 `at` 与消息 `time.created` 不同源，实测会把它判成「压缩在消息
   * 之后」，从而把一条有效的实测值误清成未知。
   *
   * ⚠️ 时间不可比时**不作废**：缺 `time.created`（骨架投影会剥掉时间）时
   * 无法判断先后，此时保留实测值比清空更合理。
   */
  const lastMeasuredAt = lastAssistantWithTokens?.time?.created
  const compactionAt =
    compactionUsage && Number.isFinite(compactionUsage.at) ? compactionUsage.at : null
  /**
   * 压缩摘要本身**不是**当前上下文。
   *
   * `summary: true` 的 assistant 是压缩产物，它自己的 tokens 恒为 0（因此会被
   * 「最后一条带 tokens」跳过），而它之前那条实测值描述的是压缩前的 prompt。
   * 两者都不能代表压缩后的占用，此时只能显示未知，等服务端下一轮的实测值。
   *
   * 判据必须看**末条 assistant 是否摘要**，而不是「末条带 tokens 的」——
   * 后者天然跳过摘要，永远看不到它。
   */
  const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
  const lastTurnIsCompactionSummary = Boolean(
    lastAssistant && (lastAssistant.info as AssistantMessageInfo).summary,
  )
  const compactionAfterMeasured =
    (compactionAt !== null && typeof lastMeasuredAt === 'number' && lastMeasuredAt < compactionAt) ||
    lastTurnIsCompactionSummary
  const measuredContext =
    lastAssistantWithTokens && !compactionAfterMeasured
      ? tokenTotal(lastAssistantWithTokens.tokens)
      : null
  const contextUsed =
    compactionContext !== null
      ? compactionContext
      : snapshotContext !== null
        ? snapshotContext
        : measuredContext
  /**
   * 百分比：窗口未知或占用未知时必须是 null 而不是 0。
   *
   * 0% 会被读成「上下文几乎空着」，与「不知道」是两回事。
   */
  const contextPercent =
    contextLimit > 0 && contextUsed !== null ? Math.min(100, (contextUsed / contextLimit) * 100) : null

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost,
    contextUsed,
    contextLimit,
    contextPercent,
    // 只可能来自服务端实测（消息 tokens / context 快照 / 压缩 tokens）
    contextEstimated: false,
  }
}

export function isSameSessionStats(a: SessionStats, b: SessionStats): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.totalTokens === b.totalTokens &&
    a.totalCost === b.totalCost &&
    a.contextUsed === b.contextUsed &&
    a.contextLimit === b.contextLimit &&
    a.contextPercent === b.contextPercent &&
    a.contextEstimated === b.contextEstimated
  )
}

/**
 * 按 messages 数组引用缓存统计结果，合并同一帧内多个消费者的重复遍历
 * （SidebarFooter / ContextDetailsDialog / WorkStatus 各自都算一遍）。
 * WeakMap 按引用持有，数组被替换后旧条目由 GC 回收；contextLimit 不同则重算。
 *
 * 压缩快照与会话累计值同样参与缓存键：压缩刚结束时 messages 引用可能没变
 * （还没重拉），只有快照变了 —— 若只比较数组引用，圆环会停在旧值上，
 * 正是「压缩完上下文占用不更新」的第二个原因。
 */
const sessionStatsMemo = new WeakMap<
  Message[],
  {
    contextLimit: number
    compactionAt?: number
    markerAt?: number
    snapshotKey?: string
    usageKey?: string
    stats: SessionStats
  }
>()

export function computeSessionStatsCached(
  messages: Message[],
  contextLimit: number = 0,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  compactionMarker?: CompactionMarker,
  contextUsageSnapshot?: { tokens: TokenUsage; cost: number; at: number },
): SessionStats {
  const usageKey = sessionUsage
    ? `${sessionUsage.tokens.input}:${sessionUsage.tokens.output}:${sessionUsage.tokens.reasoning}:${sessionUsage.tokens.cache?.read ?? 0}:${sessionUsage.tokens.cache?.write ?? 0}:${sessionUsage.cost}`
    : undefined
  const snapshotKey = contextUsageSnapshot
    ? `${contextUsageSnapshot.at}:${contextUsageSnapshot.tokens.input}:${contextUsageSnapshot.tokens.output}:${contextUsageSnapshot.tokens.reasoning}:${contextUsageSnapshot.tokens.cache?.read ?? 0}:${contextUsageSnapshot.tokens.cache?.write ?? 0}`
    : undefined
  const cached = sessionStatsMemo.get(messages)
  if (
    cached &&
    cached.contextLimit === contextLimit &&
    cached.compactionAt === compactionUsage?.at &&
    // 压缩标记的 `at` 单独参与缓存键：v2 的压缩只更新标记（不发事件），
    // 若只比 compactionUsage.at，marker 变化永远不会让缓存失效。
    cached.markerAt === compactionMarker?.at &&
    // 上下文快照在后到达（backfill 是异步的）：不参与缓存键的话，
    // 快照落地后圆环会一直停在字符估算值上。
    cached.snapshotKey === snapshotKey &&
    cached.usageKey === usageKey
  ) {
    return cached.stats
  }
  const stats = computeSessionStats(
    messages,
    contextLimit,
    compactionUsage,
    sessionUsage,
    compactionMarker,
    contextUsageSnapshot,
  )
  sessionStatsMemo.set(messages, {
    contextLimit,
    compactionAt: compactionUsage?.at,
    markerAt: compactionMarker?.at,
    snapshotKey,
    usageKey,
    stats,
  })
  return stats
}
