// ============================================
// backgroundJobStore — 后台任务的实时状态
//
// v2 没有「查询后台任务」的 HTTP 端点（`Job.Service` 只在 opencode 进程内可用），
// 前端只能从两个信号推导：
//
//   1. **启动**：工具 part 的「已转入后台」回执（历史消息里能读到）；
//   2. **结束**：`session.synthetic` 事件（实时）或同一条 synthetic 消息（历史）。
//
// 历史消息只能覆盖「已发生的」，实时事件才是「现在还在跑」的唯一来源。
// 因此这里单独存一份实时表，与从消息推导出来的结果合并（见 collectBackgroundJobs）。
// ============================================

import { useSyncExternalStore } from 'react'
import type { BackgroundJobStatus } from '../features/workStatus/backgroundJobs'

export interface LiveBackgroundJob {
  id: string
  status: BackgroundJobStatus
  /** 完成时间（ms） */
  at: number
  /** 输出摘要 */
  output?: string
  /** 命令 / 描述 */
  title?: string
}

type Listener = () => void

class BackgroundJobStore {
  /** sessionId → (jobId → 状态) */
  private bySession = new Map<string, Map<string, LiveBackgroundJob>>()
  private listeners = new Set<Listener>()
  /** 版本号：让 useSyncExternalStore 的快照引用稳定 */
  private versions = new Map<string, number>()
  private snapshots = new Map<string, Map<string, LiveBackgroundJob>>()

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 某个会话的后台任务实时状态。
   *
   * 快照按版本缓存：`useSyncExternalStore` 要求同一份数据返回同一个引用，
   * 否则每次 render 都会判定「变了」→ 无限重渲染。
   */
  getSnapshot = (sessionId: string): Map<string, LiveBackgroundJob> => {
    const cached = this.snapshots.get(sessionId)
    if (cached) return cached
    const value = this.bySession.get(sessionId) ?? EMPTY_JOBS
    this.snapshots.set(sessionId, value)
    return value
  }

  /** 记录一条后台任务状态（实时 synthetic 事件 / 本地乐观） */
  set(sessionId: string, job: LiveBackgroundJob): void {
    /**
     * unknown 不进实时表。
     *
     * 历史/骨架推导出来的任务默认就是「已完成」，unknown 只会把界面从明确的
     * 终态拉回「状态未知」，让用户以为还有东西在跑。真的未知就没有条目，
     * 面板不显示比显示错误状态好。
     */
    if (job.status === 'unknown') return
    let jobs = this.bySession.get(sessionId)
    if (!jobs) {
      jobs = new Map()
      this.bySession.set(sessionId, jobs)
    }
    const existing = jobs.get(job.id)
    // 终态不可被覆盖回 running（事件乱序时后者会撤销前者）
    if (existing && existing.status !== 'running' && job.status === 'running') return
    // 同状态同标题的重复写入（工具 part 每帧都会更新）不必通知
    if (existing && existing.status === job.status && existing.title === job.title) return
    jobs.set(job.id, job)
    this.invalidate(sessionId)
  }

  /** 会话被清空 / 删除时一并清掉 */
  clear(sessionId: string): void {
    if (!this.bySession.delete(sessionId)) return
    this.invalidate(sessionId)
  }

  clearAll(): void {
    if (this.bySession.size === 0) return
    const ids = [...this.bySession.keys()]
    this.bySession.clear()
    for (const id of ids) this.invalidate(id)
  }

  private invalidate(sessionId: string) {
    this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1)
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
