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

import { nativeGetSession, nativeGetSessionContext } from '../api/v2NativeSession'
import { messageStore } from '../store/messageStore'
import { rawSessionIdOfKey } from '../store/messagePartMerge'
import { sessionKeyToServerId } from '../utils/sessionKey'
import { logger } from '../utils'
import type { TokenUsage } from '../types/message'

/** 已经补过用量的会话（含失败），避免重复请求 */
const backfilled = new Set<string>()

/**
 * 会话累计用量快照：已经通过轻量接口拿到、但还没用上的数据。
 *
 * 见 `backfillSessionUsage` 的注释 —— `/context` 在大会话上会返回十几 MB，
 * 而它绝大部分体积来自工具大输出，只为算几个数字实在不值。
 */
interface SessionTotals {
  tokens: TokenUsage
  cost: number
}

/** 从 `session` 接口的 tokens 字段读出累计用量 */
function totalsOfSession(info: Record<string, unknown>): SessionTotals | null {
  const tokens = rec(info.tokens)
  const cache = rec(tokens.cache)
  const usage: TokenUsage = {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cache: { read: num(cache.read), write: num(cache.write) },
  }
  if (usageTotal(usage) <= 0) return null
  return { tokens: usage, cost: num(info.cost) }
}

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
 * 首屏之后再做「侧边轴大纲补全」。
 *
 * ## 为什么需要调度
 *
 * 骨架首屏只取最近几页，剩余部分由 `pages=60` 的请求一次翻到底，仅用于给
 * 侧边轴补出全部轮次。这个请求不 await，但**会占满隧道带宽**：
 *
 *   实测（1089 条消息的会话，走网关）：
 *     首屏骨架 limit=200        +0.9s 发出
 *     骨架第 2 页（cursor）      +2.5s 才发出   ← 被大纲请求挤住
 *     /context                  +4.0s 才轮到
 *
 * 侧边轴大纲属于「导航辅助」，但它本身很轻（实测通常 186ms 就返回，
 * `cursor` 往往已指向最早一页）。**真正的代价不是它自己慢，而是它会挤占
 * 并发额度**：首屏阶段浏览器对同域只有 6 个连接，实测同时在途请求峰值达到
 * **29 个**，骨架、session info、/context 全在排队。
 *
 * 所以它不该和首屏内容抢名额，延后 800ms 再发（等首屏那批请求退潮）。
 */
export function scheduleOutlineBackfill(run: () => void): void {
  scheduleAfterFirstPaint(run, OUTLINE_BACKFILL_DELAY_MS)
}

/** 大纲补全的延后：等首屏那批并发请求退潮 */
const OUTLINE_BACKFILL_DELAY_MS = 800

/**
 * 用量回填：首屏骨架上屏后**立即**发起。
 *
 * ## 为什么不再延后
 *
 * 早期确实必须延后：那时 `/context` 会返回 11MB（工具大输出 + base64 图片全带着），
 * 实测把骨架从 748ms 拖到 1885ms。
 *
 * 但主机 Agent 侧加上 `/context` 投影后（只留 id/type/tokens/cost/time/model，
 * 剥掉全部 content），实测同一会话：
 *
 *   优化前  11,021 KB / 3058 ms
 *   优化后      33 KB /  428 ms
 *
 * 三十几 KB 的请求已经不值得为它牺牲体验。继续延后（原先 1.2s 静默 + 3s 兜底
 * 超时，最坏 4.2s）只会让「上下文百分比、Token 总量、提供方、模型」在刷新后
 * 空着好几秒 —— 实测用户反馈「刷新后要超过 5 秒才出来」。
 *
 * ## 保留调度器的原因
 *
 * 旧版 Agent 不认识 `X-Lightweight`，会原样透传 10MB 响应。那种情况下抢带宽
 * 依然有害，但前端无法预知。用 `requestIdleCallback`（不叠加额外延时）既能让
 * 首屏先画出来，又不会拖到秒级。
 */
export function scheduleBackfillSessionUsage(sessionKey: string): void {
  scheduleAfterFirstPaint(() => {
    void backfillSessionUsage(sessionKey)
  }, 0)
}

/**
 * 首屏画完后执行（不叠加额外延时）。
 *
 * 用 `requestIdleCallback` 让浏览器先把首屏渲染完；空闲回调迟迟不来时用
 * timeout 兜底，避免数字一直空着。
 */
function scheduleAfterFirstPaint(run: () => void, delayMs: number): void {
  const start = () => {
    if (delayMs > 0) window.setTimeout(run, delayMs)
    else run()
  }
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof ric === 'function') {
    ric(start, { timeout: BACKFILL_IDLE_TIMEOUT_MS })
    return
  }
  window.setTimeout(start, delayMs)
}

/** idle 回调的最长等待：再忙也要在此时限内排上队 */
const BACKFILL_IDLE_TIMEOUT_MS = 600

/**
 * 从轻量接口汇总会话累计用量，并按 id 回填骨架消息。
 *
 * ## 为什么优先用 `session` 而不是 `session.context`
 *
 * `session.context` 返回「最后一次压缩之后的完整消息」。在读过大量文件的会话里
 * 这个响应会非常巨大 —— 实测某 V1 升级上来的会话（50 次 `read`，每次 350~666KB）
 * 返回 **10.76 MB / 93 条消息 / 约 2.3~3.9 秒**，而 OCC 只用它算几个 token 数字。
 * 更糟的是它和骨架、session info 抢同一条隧道，把首屏拖慢到好几秒。
 *
 * `session` 接口自带**会话累计用量**，504 字节 / 约 600ms，数值口径一致
 * （服务端累计的 input/output/reasoning/cache 总和）。因此：
 *
 *   1. 先用 `session` 拿累计用量 → 覆盖「累计消耗」（最常见、最必需的部分）
 *   2. 需要「上下文占用快照」和「按 id 回填骨架消息」时，才走 `session.context`
 *
 * 第 2 步的代价在大会话上确实高，但它是**按需**的：只有骨架路径（消息不带
 * tokens）才需要逐条回填；按量分页路径的消息本身带 tokens，无需这一步。
 *
 * ## 口径说明（与官方一致）
 *
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
    /**
     * 第一步：轻量拿累计用量。
     *
     * 大部分会话靠这一步就够了 —— 圆环百分比和累计消耗都能立刻正确显示，
     * 不必等十几 MB 的 context 响应。
     */
    const sessionInfo = await nativeGetSession(serverId, bareId).catch(() => null)
    const totals = sessionInfo ? totalsOfSession(sessionInfo as unknown as Record<string, unknown>) : null
    if (totals) {
      messageStore.recordSessionUsageFallback(sessionKey, totals.tokens, totals.cost)
    }

    /**
     * 第二步：`session.context` 只用于「上下文占用快照」与「骨架逐条回填」。
     *
     * 两者都依赖逐条 assistant 的 tokens，无法从累计值反推。这里保留原逻辑，
     * 但把它放在累计用量之后 —— 即使它很慢或失败，圆环与累计消耗已经正确了。
     *
     * ⚠️ 大会话上这个响应可达十几 MB（工具大输出全在里面），因此对失败或
     * 超时一律静默：累计用量已经写入，缺的只是逐条明细，属于可选增强。
     */
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

    /**
     * 累计用量已经由上面的 `session` 接口写入。只有它没拿到（接口失败或
     * tokens 全 0）时才用这里的求和结果兜底 —— 两者口径一致，互为备份。
     */
    if (!totals) {
      messageStore.recordSessionUsageFallback(
        sessionKey,
        { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
        cost,
      )
    }

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
