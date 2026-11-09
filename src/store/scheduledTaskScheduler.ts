// ============================================
// scheduledTaskScheduler — 定时任务调度引擎
// ============================================
//
// 纯客户端调度：应用打开时，为每个启用的任务计算下一次触发时间并用单个
// 定时器轮询触发。opencode 没有服务端调度接口，应用关闭期间的到点任务
// 不会补跑——这是本功能的固有限制，UI 中已注明。
//
// 触发动作：在任务指定的目录创建一个新会话，按指定模型/agent 发送 prompt。
// 运行结果（成功/失败/下次时间）回写到 scheduledTaskStore。

import { Cron } from 'croner'
import { scheduledTaskStore, type ScheduledTask } from '../store/scheduledTaskStore'
import { createSession } from '../api/session'
import { sendMessageAsync } from '../api/message'
import { serverStore } from '../store/serverStore'
import { apiErrorHandler } from '../utils/errorHandling'

/** 轮询间隔：30 秒足够，避免长驻定时器精度问题 */
const POLL_INTERVAL_MS = 30_000

let pollTimer: ReturnType<typeof setInterval> | null = null
let running = false
const inFlight = new Set<string>()

/** 计算某任务的下一次触发时间（毫秒）。无后续触发返回 null。 */
export function computeNextRun(task: ScheduledTask, from = Date.now()): number | null {
  const { schedule } = task
  try {
    if (schedule.kind === 'cron' && schedule.cron) {
      const cron = new Cron(schedule.cron)
      const next = cron.nextRun(new Date(from))
      return next ? next.getTime() : null
    }
    if (schedule.kind === 'once' && schedule.date && schedule.time) {
      const target = new Date(`${schedule.date}T${schedule.time}:00`).getTime()
      return Number.isFinite(target) && target > from ? target : null
    }
    if (schedule.kind === 'daily' && schedule.times?.length) {
      return nextDaily(schedule.times, from)
    }
    if (schedule.kind === 'weekly' && schedule.times?.length && schedule.weekdays?.length) {
      return nextWeekly(schedule.times, schedule.weekdays, from)
    }
  } catch {
    return null
  }
  return null
}

function nextDaily(times: string[], from: number): number | null {
  const candidates: number[] = []
  const base = new Date(from)
  for (const time of times) {
    const [h, m] = time.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue
    const d = new Date(base)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
    candidates.push(d.getTime())
  }
  return candidates.length ? Math.min(...candidates) : null
}

function nextWeekly(times: string[], weekdays: number[], from: number): number | null {
  const candidates: number[] = []
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from)
    day.setDate(day.getDate() + offset)
    if (!weekdays.includes(day.getDay())) continue
    for (const time of times) {
      const [h, m] = time.split(':').map(Number)
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue
      const d = new Date(day)
      d.setHours(h, m, 0, 0)
      if (d.getTime() > from) candidates.push(d.getTime())
    }
  }
  return candidates.length ? Math.min(...candidates) : null
}

export async function runTask(task: ScheduledTask): Promise<void> {
  if (inFlight.has(task.id)) return
  inFlight.add(task.id)
  const serverId = serverStore.getActiveServerId()
  scheduledTaskStore.recordRun(task.id, {
    lastRunAt: Date.now(),
    lastStatus: 'running',
    lastError: undefined,
    nextRunAt: computeNextRun(task) ?? undefined,
  })
  try {
    const session = await createSession({ directory: task.execution.directory }, serverId)
    const messageID = `msg_${crypto.randomUUID().replace(/-/g, '')}`
    await sendMessageAsync(
      {
        sessionId: session.id,
        text: task.execution.prompt,
        attachments: [],
        model: { providerID: task.execution.providerID, modelID: task.execution.modelID },
        agent: task.execution.agent,
        directory: task.execution.directory,
        messageID,
      },
      serverId,
    )
    scheduledTaskStore.recordRun(task.id, {
      lastRunAt: Date.now(),
      lastStatus: 'success',
      nextRunAt: computeNextRun(task) ?? undefined,
    })
  } catch (e) {
    apiErrorHandler('run scheduled task', e)
    scheduledTaskStore.recordRun(task.id, {
      lastRunAt: Date.now(),
      lastStatus: 'error',
      lastError: e instanceof Error ? e.message : String(e),
      nextRunAt: computeNextRun(task) ?? undefined,
    })
  } finally {
    inFlight.delete(task.id)
  }
}

function tick() {
  const now = Date.now()
  for (const task of scheduledTaskStore.list()) {
    if (!task.enabled) continue
    const next = task.nextRunAt ?? computeNextRun(task)
    if (next != null && next <= now) {
      void runTask(task)
    } else if (task.nextRunAt == null && next != null) {
      // 首次补齐 nextRunAt（例如从存储加载后尚未计算）。next 仍为 null 时
      // 无需回写，避免已结束的一次性任务每 30s 触发无意义的落盘与重渲染。
      scheduledTaskStore.recordRun(task.id, {
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus,
        lastError: task.lastError,
        nextRunAt: next,
      })
    }
  }
}

export function startScheduledTaskScheduler(): void {
  if (running) return
  running = true
  tick()
  pollTimer = setInterval(tick, POLL_INTERVAL_MS)
}

export function stopScheduledTaskScheduler(): void {
  running = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
