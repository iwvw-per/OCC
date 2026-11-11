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
//   seq >  last + 1   → 中间有 seq 未被广播
//
// ## ⚠️ 跳号是**正常**的，不能据此丢弃事件（2026-11-11 实测修正）
//
// 原实现把跳号当成「事件丢失」，于是**丢弃当前事件且不推进水位**，导致后续
// 每一条事件都继续被判为跳号、继续被丢弃 —— 一次跳号会让该会话此后的实时
// 更新全部失效，直到整页刷新。
//
// 实测（本机 127.0.0.1:4096，opencode 2.2.0，连抓三份真实事件流）：
//
//   新会话 seq：1,2,3,4,[5 缺失],6,7,…,14   ← 缺 5，`session.renamed` 在 6
//   新会话 seq：0,…,12,[13 缺失],14          ← 缺 13，`session.renamed` 在 14
//
// 缺的那些 seq 是「分配了序号但**不向 SSE 客户端广播**」的 durable 事件
// （典型是 `session.usage.recorded`，即生成标题那一次的内部用量）。因此
// 跳号**不代表客户端漏了什么**，只代表服务端存在不可见的内部事件。
//
// 后果（用户实际报障）：`session.renamed` 被丢 → 标题不更新；
// `session.execution.succeeded` 被丢 → 永不转 idle → 一直显示「进行中」；
// 两者都只有刷新后（走 HTTP 快照）才恢复。
//
// 所以现在的策略是：
//   - 跳号事件**照常应用**，并把水位推进到收到的 seq（避免永久卡死）；
//   - 同时仍然上报缺口，让上层做一次 HTTP 快照对账兜底（真正的漏事件，
//     如断连/背压，仍能被这条路径修复）。
//
// `GET /api/experimental/session/{id}/log?after=N` 验证过**不回放历史事件**：
// 实测 `after=0` / `after=11` / `after=12` 都只返回一条
// `{type:"log.synced", seq:当前水位}`，没有任何历史事件。所以缺口确实无法
// 游标补发，只能靠快照对账。
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
  /**
   * 中间有 seq 未被广播。
   *
   * ⚠️ 与旧语义不同：这**不再意味着「事件丢失、当前事件不可信」**。缺的 seq
   * 通常是服务端内部不广播的事件，当前事件本身是完整可用的（见文件头实测）。
   * 调用方应当**照常应用当前事件**，同时可选地做一次快照对账兜底。
   */
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
   * 预设（播种）某个 aggregate 的初始 seq 水位。
   *
   * 场景：当从快照或本地持久化已知某会话的最大 seq 时，在接收事件前预设基线，
   * 避免「首次见到」盲目信任可能已经发生跳号的事件。
   */
  seed(serverId: string, aggregateID: string, seq: number): void {
    if (!aggregateID || !Number.isFinite(seq)) return
    const key = this.key(serverId, aggregateID)
    const existing = this.lastSeq.get(key)
    if (existing === undefined || seq > existing) {
      this.remember(key, seq)
    }
  }

  /**
   * 判定一条事件该怎么处理，并在「可应用」时推进水位。
   *
   * 注意：**apply 与 gap 都推进水位**。gap 不推进会让该会话的所有后续事件
   * 永久被判为缺口并丢弃（一次跳号 = 此后实时更新全废），实测跳号是服务端
   * 正常行为，因此必须推进。duplicate 不推进（否则乱序的旧事件会把水位拉回去）。
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

    // 跳号：缺的 seq 是服务端内部不广播的事件，当前事件仍然可信。
    // 推进水位，避免后续事件被连环误判；同时上报缺口让上层做快照对账。
    const expected = last + 1
    this.remember(key, seq)
    return { kind: 'gap', expected, received: seq }
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
