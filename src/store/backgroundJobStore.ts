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

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

  /**
   * 用 `shell.list` 的现场结果校正一次。
   *
   * `runningIds` 是此刻确实还在跑的 shell id。列表里没有的**不**代表任务结束
   * （可能早已被清理、也可能是别的目录），所以这里只做两件事：
   *   - 把在跑的标成 running（权威，可纠正历史推导的 completed）；
   *   - 把「当前会话里我们以为是 running」但列表里没有的，标成 completed。
   */
  reconcileRunning(
    sessionId: string,
    runningIds: Map<string, { at: number; title?: string }>,
    candidates: Iterable<string>,
  ): void {
    let jobs = this.bySession.get(sessionId)
    if (!jobs) {
      jobs = new Map()
      this.bySession.set(sessionId, jobs)
    }
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
    if (!this.bySession.delete(sessionId)) return
    this.invalidate(sessionId)
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

  clearAll(): void {
    if (this.bySession.size === 0) return
    const ids = [...this.bySession.keys()]
    this.bySession.clear()
    for (const id of ids) this.invalidate(id)
  }

  private invalidate(sessionId: string) {
    this.snapshots.delete(sessionId)
    this.listeners.forEach(listener => listener())
  }
}

const EMPTY_JOBS = new Map<string, LiveBackgroundJob>()

export const backgroundJobStore = new BackgroundJobStore()

/** 订阅某会话的后台任务实时状态 */
export function useLiveBackgroundJobs(sessionId: string | null): Map<string, LiveBackgroundJob> {
  return useSyncExternalStore(
    backgroundJobStore.subscribe,
    () => (sessionId ? backgroundJobStore.getSnapshot(sessionId) : EMPTY_JOBS),
    () => EMPTY_JOBS,
  )
}
