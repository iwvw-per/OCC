// ============================================
// scheduledTaskStore — 定时任务定义与持久化
// ============================================
//
// 任务定义存 localStorage（按服务器分片），由 scheduler 引擎负责触发。
// 注意：OpenCodeUI 是纯前端，opencode 没有调度接口，因此定时任务只在
// 页面打开时生效；应用关闭期间的到点任务不会补跑（见 scheduler 的说明）。
//
// 每个任务：在指定目录创建一个新会话，按指定模型/agent 发送一段 prompt。

import { useSyncExternalStore } from 'react'
import { serverStorage } from '../utils/perServerStorage'
import { serverStore } from './serverStore'

export type ScheduledTaskKind = 'once' | 'daily' | 'weekly' | 'cron'
export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error'

export interface ScheduledTaskSchedule {
  kind: ScheduledTaskKind
  /** daily 用：HH:mm 列表 */
  times?: string[]
  /** once 用：HH:mm */
  time?: string
  /** once 用：YYYY-MM-DD */
  date?: string
  /** weekly 用：0-6（周日=0） */
  weekdays?: number[]
  /** cron 用：标准 5 段表达式 */
  cron?: string
}

export interface ScheduledTaskExecution {
  prompt: string
  providerID: string
  modelID: string
  agent?: string
  directory: string
}

export interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  schedule: ScheduledTaskSchedule
  execution: ScheduledTaskExecution
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastStatus?: ScheduledTaskStatus
  lastError?: string
  nextRunAt?: number
}

const STORAGE_KEY = 'opencode-scheduled-tasks'

function isTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object') return false
  const t = value as ScheduledTask
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.enabled === 'boolean' &&
    !!t.schedule &&
    typeof t.schedule.kind === 'string' &&
    !!t.execution &&
    typeof t.execution.prompt === 'string'
  )
}

function load(): ScheduledTask[] {
  try {
    const raw = serverStorage.get(STORAGE_KEY, serverStore.getActiveServerId())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isTask) : []
  } catch {
    return []
  }
}

type Subscriber = () => void

class ScheduledTaskStore {
  private tasks: ScheduledTask[] = []
  private listeners = new Set<Subscriber>()

  constructor() {
    this.tasks = load()
    // 任务按服务器分片存储。切服务器后必须重新加载，否则会继续用旧服务器的
    // 任务列表（而调度器按当前活动服务器执行），导致任务被发到错误的服务器。
    serverStore.onServerChange(() => this.reload())
  }

  subscribe = (cb: Subscriber): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot = (): ScheduledTask[] => this.tasks

  private persist() {
    try {
      serverStorage.set(STORAGE_KEY, JSON.stringify(this.tasks), serverStore.getActiveServerId())
    } catch {
      // quota exceeded
    }
    this.listeners.forEach(cb => cb())
  }

  /** 服务器切换后重新加载该服务器的任务 */
  reload() {
    this.tasks = load()
    this.listeners.forEach(cb => cb())
  }

  list(): ScheduledTask[] {
    return this.tasks
  }

  upsert(task: ScheduledTask) {
    const index = this.tasks.findIndex(t => t.id === task.id)
    const next = { ...task, updatedAt: Date.now() }
    if (index >= 0) {
      this.tasks = this.tasks.map(t => (t.id === task.id ? next : t))
    } else {
      this.tasks = [...this.tasks, next]
    }
    this.persist()
  }

  remove(id: string) {
    this.tasks = this.tasks.filter(t => t.id !== id)
    this.persist()
  }

  setEnabled(id: string, enabled: boolean) {
    this.tasks = this.tasks.map(t => (t.id === id ? { ...t, enabled, updatedAt: Date.now() } : t))
    this.persist()
  }

  /** 调度引擎回写运行结果（不改变 updatedAt，避免影响“最后修改”语义） */
  recordRun(id: string, patch: Pick<ScheduledTask, 'lastRunAt' | 'lastStatus' | 'lastError' | 'nextRunAt'>) {
    this.tasks = this.tasks.map(t => (t.id === id ? { ...t, ...patch } : t))
    this.persist()
  }
}

export const scheduledTaskStore = new ScheduledTaskStore()

export function useScheduledTasks(): ScheduledTask[] {
  return useSyncExternalStore(scheduledTaskStore.subscribe, scheduledTaskStore.getSnapshot)
}

export function createScheduledTask(input: {
  name: string
  schedule: ScheduledTaskSchedule
  execution: ScheduledTaskExecution
}): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    name: input.name,
    enabled: true,
    schedule: input.schedule,
    execution: input.execution,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastStatus: 'idle',
  }
}
