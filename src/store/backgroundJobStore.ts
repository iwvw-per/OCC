// ============================================
// backgroundJobStore — 后台任务的实时状态
//
// 状态有三个来源，优先级从高到低：
//
//   1. **实时事件**（最权威）：v2 的 `shell.created` / `shell.exited` 与
//      `session.synthetic` 完成通知。SSE 会给到 shell 的真实终态与 exit code。
//   2. **现场校正**：打开面板时用 `shell.list` 校正一次。它只返回仍在运行的
//      shell，因此能补上错过的 `shell.exited`（断线、切页、后台标签页）。
//   3. **历史推导**（最弱）：消息流里的「已转入后台」回执。只能证明「曾经启动
//      过」，**证明不了它已经结束**。
//
// ⚠️ 第 3 条是此前「后台任务始终显示已结束」的根因：骨架把历史任务一律标成
// completed，而本 store 又实现了「终态不可回退到 running」，于是真在跑的任务
// 被历史推导的 completed 永久压住，实时事件也抢不回来。
// 现在的规则是：**只有权威来源（1、2）写下的终态才锁定**，推导出来的终态
// 允许被权威来源纠正。
// ============================================

import { useSyncExternalStore } from 'react'
import type { BackgroundJobStatus } from '../features/workStatus/backgroundJobs'

export interface LiveBackgroundJob {
  id: string
  status: BackgroundJobStatus
  /** 状态时间（ms）：running 时是开始时刻，终态时是结束时刻 */
  at: number
  /** 输出摘要（完成通知或 shell.output 截断） */
  output?: string
  /** 命令 / 描述 */
  title?: string
  /** 退出码（shell 终态才有） */
  exit?: number
  /** 这个状态是否来自权威来源（SSE 事件 / shell.list 校正 / 完成通知） */
  authoritative?: boolean
  /** 归属的消息（骨架路径只有轮次 id），点条目跳回对话用 */
  messageId?: string
}

type Listener = () => void

class BackgroundJobStore {
  /** sessionId → (jobId → 状态) */
  private bySession = new Map<string, Map<string, LiveBackgroundJob>>()
  private listeners = new Set<Listener>()
  private snapshots = new Map<string, Map<string, LiveBackgroundJob>>()
  /**
   * sessionId → 最近一次 `shell.list` 里确实在跑的 shell id。
   *
   * 骨架/消息推导是**滞后**的（只反映落库那一刻），而校正结果更新。
   * 留下这份现场，后续任何来源写入终态时都能被拦住 —— 否则骨架加载完成
   * 会把刚校正好的 running 打回 completed，用户又看到「已结束」。
   */
  private lastRunningIds = new Map<string, Set<string>>()
  /**
   * sessionId → 用户手动「清除已结束」时忽略掉的 job id。
   *
   * 大部分已结束任务**不在** `bySession` 里 —— 它们是 `collectBackgroundJobs`
   * 从消息流推导出来的（历史回执），没有实时记录。所以「清除」不能只删 store
   * 条目，必须记住一份忽略名单，让推导层也跳过它们。
   *
   * 只允许忽略已结束的任务：正在跑的如果被忽略，后续 `shell.exited` 找不到
   * 归属，面板会永远停在「运行中」。
   */
  private dismissed = new Map<string, Set<string>>()

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 该 job 是否已被用户清除（推导层据此跳过） */
  isDismissed(sessionId: string, jobId: string): boolean {
    return this.dismissed.get(sessionId)?.has(jobId) ?? false
  }

  /** 该会话被清除的 job id 集合（推导层批量过滤用） */
  getDismissed(sessionId: string): ReadonlySet<string> {
    return this.dismissed.get(sessionId) ?? EMPTY_DISMISSED
  }

  /**
   * 某个会话的后台任务实时状态。
   *
   * 快照按需缓存：`useSyncExternalStore` 要求同一份数据返回同一个引用，
   * 否则每次 render 都会判定「变了」→ 无限重渲染。
   */
  getSnapshot = (sessionId: string): Map<string, LiveBackgroundJob> => {
    const cached = this.snapshots.get(sessionId)
    if (cached) return cached
    const value = this.bySession.get(sessionId) ?? EMPTY_JOBS
    this.snapshots.set(sessionId, value)
    return value
  }

  /** 记录一条后台任务状态 */
  set(sessionId: string, job: LiveBackgroundJob): void {
    /**
     * unknown 不进实时表。
     *
     * 历史/骨架推导出来的任务没有终态时才是 unknown；把它写进来只会让界面
     * 从明确状态退回「状态未知」。真的未知就没有条目，面板不显示比显示
     * 错误状态好。
     */
    if (job.status === 'unknown') return
    let jobs = this.bySession.get(sessionId)
    if (!jobs) {
      jobs = new Map()
      this.bySession.set(sessionId, jobs)
    }
    const existing = jobs.get(job.id)

    if (existing) {
      /**
       * 最近一次校正确认「它还在跑」→ 拦住任何终态写入。
       *
       * 场景：`shell.list` 校正先把任务标成 running，随后骨架加载完成、带着
       * 它那份**推导出来的** completed 写进来。不拦住的话，刚校正好的运行中
       * 任务会立刻被打回「已结束」—— 用户看到的就是这个 bug。
       *
       * 只有权威来源（SSE 的 shell.exited / 完成通知）才能结束它。
       */
      const incomingIsFinal = job.status !== 'running'
      if (incomingIsFinal && !job.authoritative && this.isKnownRunning(sessionId, job.id)) {
        return
      }
      /**
       * 权威来源的终态不可被非权威来源覆盖。
       *
       * 反过来**允许**：推导出来的 completed（历史「转过后台」的默认值）必须能
       * 被权威来源的 running 纠正 —— 否则真在跑的任务永远显示成已结束。
       */
      const existingIsFinal = existing.status !== 'running'
      const incomingIsRunning = job.status === 'running'
      if (existingIsFinal && incomingIsRunning) {
        if (existing.authoritative && !job.authoritative) return
      }
      // 同状态、同标题、同退出码的重复写入（工具 part 每帧都会更新）不必通知
      if (
        existing.status === job.status &&
        existing.title === job.title &&
        existing.exit === job.exit &&
        (existing.authoritative ?? false) === (job.authoritative ?? false)
      ) {
        return
      }
      // 合并：保留已有的 title / at 等更精确的信息
      jobs.set(job.id, {
        ...existing,
        ...job,
        // running → 保留最早的开始时刻，避免每次事件都刷新「已运行时长」
        ...(incomingIsRunning && existing.status === 'running' && existing.at < job.at
          ? { at: existing.at }
          : {}),
        ...(job.title ? { title: job.title } : existing.title ? { title: existing.title } : {}),
      })
      this.invalidate(sessionId)
      return
    }

    jobs.set(job.id, job)
    this.invalidate(sessionId)
  }

  /** 该任务在最近一次校正时是否确实在跑 */
  private isKnownRunning(sessionId: string, jobId: string): boolean {
    return this.lastRunningIds.get(sessionId)?.has(jobId) ?? false
  }

  /**
   * 用 `shell.list` 的现场结果校正一次。
   *
   * `runningIds` 是**能确认是后台任务**且仍在跑的 shell id（白名单过滤后）。
   * `presentIds` 是本会话此刻**所有**在跑的 shell id（含前台命令）。
   *
   * 两者分工：
   *   - `runningIds` → 提升为 running（可纠正历史推导的 completed）；
   *   - `presentIds` → **只用来阻止误判**：还在列表里就绝不标成已结束。
   *     前台命令混在列表里没关系，因为它们从来不会进任务表；
   *     但正在跑的后台任务如果被白名单漏掉（它所在轮次未定稿、还没被推导出来），
   *     这里必须保护它，否则会被 candidates 误判成「已完成」。
   *   - `candidates` 里既不在 runningIds 也不在 presentIds 的 → 已结束。
   */
  reconcileRunning(
    sessionId: string,
    runningIds: Map<string, { at: number; title?: string }>,
    candidates: Iterable<string>,
    presentIds?: ReadonlySet<string>,
  ): void {
    let jobs = this.bySession.get(sessionId)
    if (!jobs) {
      jobs = new Map()
      this.bySession.set(sessionId, jobs)
    }
    // 记下本次现场：滞后的终态写入会被 set() 拦住
    this.lastRunningIds.set(sessionId, new Set(presentIds ?? runningIds.keys()))
    let changed = false
    for (const [id, info] of runningIds) {
      const existing = jobs.get(id)
      const next: LiveBackgroundJob = {
        id,
        status: 'running',
        at: info.at,
        ...(info.title ? { title: info.title } : existing?.title ? { title: existing.title } : {}),
        authoritative: true,
      }
      if (existing && existing.status === 'running' && (existing.title === next.title || !next.title)) {
        continue
      }
      jobs.set(id, next)
      changed = true
    }
    for (const id of candidates) {
      if (runningIds.has(id)) continue
      // 还在 shell.list 里 → 确实在跑，不能判成结束
      if (presentIds?.has(id)) continue
      const existing = jobs.get(id)
      // 只纠正我们认为还在跑、且还没拿到权威终态的条目
      if (!existing || existing.status !== 'running') continue
      jobs.set(id, { ...existing, status: 'completed', at: Date.now(), authoritative: true })
      changed = true
    }
    if (changed) this.invalidate(sessionId)
  }

  /** 会话被清空 / 删除时一并清掉 */
  clear(sessionId: string): void {
    const hadJobs = this.bySession.delete(sessionId)
    const hadRunning = this.lastRunningIds.delete(sessionId)
    if (!hadJobs && !hadRunning) return
    this.invalidate(sessionId)
  }

  /**
   * 清掉该会话里**已结束**的后台任务（保留仍在跑的）。
   *
   * 面板上的已结束任务会随会话不断堆积，挤占进行中的位置。
   *
   * 关键：已结束任务大多**不在** `bySession` 里（它们是消息流推导出来的），
   * 所以必须同时登记忽略名单，让 `collectBackgroundJobs` 跳过它们。
   * 只删 store 条目的话，下一帧推导又会把它们变回来。
   *
   * `settledIds` 由调用方给出（它才知道当前面板上哪些已结束）。
   * 返回实际清除的条数。
   */
  clearSettled(sessionId: string, settledIds: Iterable<string> = []): number {
    const jobs = this.bySession.get(sessionId)
    const dismissed = this.dismissed.get(sessionId) ?? new Set<string>()
    let removed = 0

    for (const id of settledIds) {
      // 正在跑的任务绝不能忽略：删了之后 shell.exited 找不到归属，
      // 面板会永远停在「运行中」。
      const live = jobs?.get(id)
      if (live && live.status === 'running') continue
      if (!dismissed.has(id)) {
        dismissed.add(id)
        removed += 1
      }
      // store 里若有这条记录，一并删掉
      if (live) jobs?.delete(id)
    }

    if (dismissed.size > 0) this.dismissed.set(sessionId, dismissed)
    if (removed > 0) this.invalidate(sessionId)
    return removed
  }

  /**
   * 找出登记了某个 job 的会话。
   *
   * `shell.exited` 事件只带 shell id、不带 sessionID，而任务的归属只在
   * `shell.created` 时才知道。用这里反查，就能把退出事件投递到正确的会话。
   * 已结束的会话通常只登记了少量任务，遍历成本可忽略。
   */
  sessionIdsFor(jobId: string): string[] {
    const result: string[] = []
    for (const [sessionId, jobs] of this.bySession) {
      if (jobs.has(jobId)) result.push(sessionId)
    }
    return result
  }

  /**
   * 该会话是否已经登记过这个任务。
   *
   * 用来区分「后台任务」与「前台命令」：两者都会产生 shell 与 `shell.created`
   * 事件，只有**已经在任务表里**（由工具回执/骨架/完成通知登记过）的才是
   * 后台任务。否则面板会把正在执行的前台工具调用也列成后台任务。
   */
  has(sessionId: string, jobId: string): boolean {
    return this.bySession.get(sessionId)?.has(jobId) ?? false
  }

  clearAll(): void {
    if (this.bySession.size === 0 && this.lastRunningIds.size === 0) return
    const ids = new Set([...this.bySession.keys(), ...this.lastRunningIds.keys()])
    this.bySession.clear()
    this.lastRunningIds.clear()
    for (const id of ids) this.invalidate(id)
  }

  private invalidate(sessionId: string) {
    this.snapshots.delete(sessionId)
    this.listeners.forEach(listener => listener())
  }
}

const EMPTY_JOBS = new Map<string, LiveBackgroundJob>()
/** 空忽略集合：避免每次 getDismissed 都新建一个 Set */
const EMPTY_DISMISSED: ReadonlySet<string> = new Set()

export const backgroundJobStore = new BackgroundJobStore()

/** 订阅某会话的后台任务实时状态 */
export function useLiveBackgroundJobs(sessionId: string | null): Map<string, LiveBackgroundJob> {
  return useSyncExternalStore(
    backgroundJobStore.subscribe,
    () => (sessionId ? backgroundJobStore.getSnapshot(sessionId) : EMPTY_JOBS),
    () => EMPTY_JOBS,
  )
}
