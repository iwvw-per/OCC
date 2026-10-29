// ============================================
// seq 缺口检测（服务端 durable 事件序号）
// ============================================
//
// 背景：opencode 的 durable 事件带 `durable: { aggregateID, seq, version }`，
// `seq` 在**单个 aggregate（会话）内**单调递增（实测确认：新会话 seq 8–15，
// 老会话 seq 29364–29365 同时出现，说明不是全局序号）。
//
// 这让客户端可以判断「有没有漏事件」：
//   seq === last + 1  → 连续，正常应用
//   seq <= last       → 重复/乱序，丢弃
//   seq >  last + 1   → 有缺口，该会话的数据不可信
//
// ## 实测约束（必须记住）
//
// `GET /api/experimental/session/{id}/log?after=N` **不回放历史事件**：
// 实测 `after=0` / `after=4790` 都只返回一条 `{type:"log.synced", seq:当前水位}`，
// 没有任何历史事件。所以缺口**不能靠游标补发**，只能：
//   1. 用 seq 检测出「缺了」；
//   2. 用 HTTP 快照（重新拉该会话的消息/状态）修复。
//
// 这与设计文档 §1.6 的结论一致。区别在于：文档说「不可重放所以只能全量重拉」，
// 而有了 seq 可以做到**只重拉真正缺口的会话**，而不是一律全量。
//
// ## 为什么要按 aggregate 而不是全局
//
// seq 是 per-aggregate 的。用全局单值会立刻误报：会话 A 在 8，会话 B 在 29364，
// 交替到达时每个事件都会被判成「缺口」。
//
// 纯函数，不依赖 React / store，便于单测。

/** 缺口检测结果 */
export type SeqVerdict =
  /** 首次见到该 aggregate，或正好接上：正常应用 */
  | { kind: 'apply' }
  /** 重复或乱序（seq 不大于已知值）：丢弃，避免重复应用 */
  | { kind: 'duplicate' }
  /** 跳号：中间有事件丢失，该 aggregate 的数据不可信，需要快照重拉 */
  | { kind: 'gap'; expected: number; received: number }

/**
 * 单个 aggregate 的序号跟踪器。
 *
 * 有界：只保留最近使用的 N 个 aggregate，避免长会话列表下无限增长
 * （一个服务器可能有成百上千个会话，每个都记一条 seq 是可控的，但没有上限
 * 就不是）。
 */
export interface SeqTrackerOptions {
  /** 最多跟踪多少个 aggregate（按最近使用淘汰） */
  maxAggregates?: number
}

const DEFAULT_MAX_AGGREGATES = 512

export class SeqGapTracker {
  /** `${serverId}\0${aggregateID}` → 已应用的最高 seq */
  private lastSeq = new Map<string, number>()
  private readonly maxAggregates: number

  constructor(options: SeqTrackerOptions = {}) {
    this.maxAggregates = options.maxAggregates ?? DEFAULT_MAX_AGGREGATES
  }

  private key(serverId: string, aggregateID: string): string {
    return `${serverId}\u0000${aggregateID}`
  }

  /**
   * 判定一条事件该怎么处理，并在「可应用」时推进水位。
   *
   * 注意：**只有 apply 才推进**。duplicate 不推进（否则乱序的旧事件会把水位
   * 拉回去）；gap 也不推进（保持旧水位，这样后续补拉后的第一条新事件仍能被
   * 判为 gap，直到真正重拉完成）。
   */
  accept(serverId: string, aggregateID: string, seq: number): SeqVerdict {
    if (!aggregateID || !Number.isFinite(seq)) return { kind: 'apply' }

    const key = this.key(serverId, aggregateID)
    const last = this.lastSeq.get(key)

    if (last === undefined) {
      this.remember(key, seq)
      return { kind: 'apply' }
    }
    if (seq <= last) {
      // 重复投递 / 乱序旧事件：丢弃
      return { kind: 'duplicate' }
    }
    if (seq === last + 1) {
      this.remember(key, seq)
      return { kind: 'apply' }
    }

    // 跳号：保持旧水位，让调用方去重拉快照。
    // 重拉完成后调用 reset(aggregate) 清掉记录，下一条事件重新从「首次见到」开始。
    return { kind: 'gap', expected: last + 1, received: seq }
  }

  /**
   * 重置某个 aggregate 的跟踪状态。
   *
   * 缺口修复（快照重拉）完成后必须调用：重拉拿到的是权威快照，之后的事件
   * 无论 seq 是多少都应正常应用，否则会一直卡在 gap 判定上反复重拉。
   */
  reset(serverId: string, aggregateID: string): void {
    this.lastSeq.delete(this.key(serverId, aggregateID))
  }

  /** 当前已知水位（测试/调试用） */
  getLastSeq(serverId: string, aggregateID: string): number | undefined {
    return this.lastSeq.get(this.key(serverId, aggregateID))
  }

  /** 跟踪的 aggregate 数量（测试用） */
  size(): number {
    return this.lastSeq.size
  }

  /** 清空（切服务器 / 测试用） */
  clear(): void {
    this.lastSeq.clear()
  }

  /** 写入并按 LRU 淘汰（Map 的插入序即最近使用序） */
  private remember(key: string, seq: number): void {
    this.lastSeq.delete(key)
    this.lastSeq.set(key, seq)
    while (this.lastSeq.size > this.maxAggregates) {
      const oldest = this.lastSeq.keys().next()
      if (oldest.done) break
      this.lastSeq.delete(oldest.value)
    }
  }
}

/**
 * 从 v2 原始事件里取 durable 信封。
 *
 * 只有 durable 事件带 seq；ephemeral 事件（delta / status / usage.updated 等）
 * 没有，返回 null —— 它们不参与缺口检测（也没有可检测的依据）。
 */
export function durableOf(raw: unknown): { aggregateID: string; seq: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const durable = (raw as { durable?: unknown }).durable
  if (!durable || typeof durable !== 'object') return null
  const d = durable as { aggregateID?: unknown; seq?: unknown }
  const aggregateID = typeof d.aggregateID === 'string' ? d.aggregateID : ''
  const seq = typeof d.seq === 'number' && Number.isFinite(d.seq) ? d.seq : NaN
  if (!aggregateID || !Number.isFinite(seq)) return null
  return { aggregateID, seq }
}
