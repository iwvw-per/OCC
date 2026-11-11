// ============================================
// lowPriorityQueue - 低优先级请求池的行为测试
//
// jsdom 无 requestIdleCallback，池回退到 setTimeout(0) 驱动 pump；
// 测试用 fake timers 精确控制「泵何时开工」。
// ============================================

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enqueueLowPriority, resetLowPriorityQueue } from './lowPriorityQueue'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 触发一次 setTimeout 泵回调，并排空随之产生的微任务 */
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  resetLowPriorityQueue()
})

afterEach(() => {
  vi.useRealTimers()
  resetLowPriorityQueue()
})

it('runs tasks only when the pump fires, never synchronously on enqueue', async () => {
  const started: string[] = []
  enqueueLowPriority(() => {
    started.push('a')
  })
  expect(started).toEqual([])

  await flush()
  expect(started).toEqual(['a'])
})

it('caps concurrent tasks at the pool limit and resumes when a slot frees', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const started: string[] = []
  const runningPeaks: number[] = []
  let running = 0

  for (let i = 0; i < 3; i++) {
    enqueueLowPriority(() => {
      running += 1
      runningPeaks.push(running)
      started.push(`t${i}`)
      return gates[i].promise
    })
  }

  await flush()
  // 限额 2：前两个开跑，第三个排队
  expect(started).toEqual(['t0', 't1'])
  expect(runningPeaks.every(peak => peak <= 2)).toBe(true)

  gates[0].resolve()
  await flush()
  // 空出一个槽位 → 排队中的 t2 开始（t1 仍占用另一个槽位）
  expect(started).toEqual(['t0', 't1', 't2'])

  gates[1].resolve()
  gates[2].resolve()
  await flush()
})

it('executes in FIFO order', async () => {
  const order: string[] = []
  const g0 = deferred()
  const g1 = deferred()

  enqueueLowPriority(() => {
    order.push('first')
    return g0.promise
  })
  enqueueLowPriority(() => {
    order.push('second')
    return g1.promise
  })
  enqueueLowPriority(() => {
    order.push('third')
  })

  await flush()
  expect(order).toEqual(['first', 'second'])

  g0.resolve()
  g1.resolve()
  await flush()
  expect(order).toEqual(['first', 'second', 'third'])
})

it('swallows a task rejection so later tasks and callers are unaffected', async () => {
  const started: string[] = []
  enqueueLowPriority(() => {
    throw new Error('boom')
  })
  enqueueLowPriority(() => {
    started.push('after')
  })

  await flush()
  // 抛错的任务被吞掉，后继任务照常执行
  expect(started).toEqual(['after'])
})

it('a rejecting async task is swallowed too', async () => {
  const started: string[] = []
  enqueueLowPriority(async () => {
    throw new Error('async boom')
  })
  enqueueLowPriority(() => {
    started.push('after')
  })

  await flush()
  expect(started).toEqual(['after'])
})

it('reset drops pending tasks', async () => {
  const started: string[] = []
  enqueueLowPriority(() => {
    started.push('x')
  })
  resetLowPriorityQueue()
  enqueueLowPriority(() => {
    started.push('y')
  })

  await flush()
  expect(started).toEqual(['y'])
})