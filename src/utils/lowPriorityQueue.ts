// ============================================
// lowPriorityQueue - 低优先级请求池（并发受限）
// ============================================
//
// 背景：首屏之后有大量「可有可无」的辅助请求（侧边轴大纲补全、用量回填、缺口
// 元数据重拉、重连后的 inbox 恢复等）。它们过去各用 setTimeout 魔法数或独立
// 的 requestIdleCallback 单独调度，一旦多台服务器同时重连，会叠加出几十个并发
// 请求，把首屏内容请求挤在浏览器同域连接上限后面排队（实测峰值 29 个在途，
// 见 contextBackfill 的注释）。
//
// 这里把这类请求收口到一个池：
//   - 并发上限 MAX_CONCURRENCY（默认 2），无论多少调用方、多少台服务器；
//   - 由 requestIdleCallback 驱动（空闲才开工），超时兜底不饿死；
//   - FIFO；任务失败静默（辅助请求失败不该影响任何主流程）。
//
// ⚠️ 首屏 / 主链路请求**不**走这个池：它们调用时立即发起，天然享有全部连接
// 额度。池只约束「辅助请求」不要挤占首屏带宽。
// ============================================

type Task = () => void | Promise<void>

/** 并发上限：同时最多在途的辅助请求数 */
const MAX_CONCURRENCY = 2
/** idle 回调最长等待：再忙也要在此时限内把任务排上队 */
const IDLE_TIMEOUT_MS = 600

const queue: Task[] = []
let running = 0
let scheduled = false

/** 驱动池运转：有多余额度就从队列取任务启动；任务结束后自动续泵。 */
function pump(): void {
  scheduled = false
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const task = queue.shift()
    if (!task) continue
    running += 1
    void Promise.resolve()
      .then(task)
      .catch(() => {
        // 辅助请求失败静默：与调用方各自 catch 双保险
      })
      .finally(() => {
        running -= 1
        pump()
      })
  }
}

/**
 * 安排一次泵回调。
 *
 * 幂等节流：同一 tick 内多次入队只会安排一次 pump，任务本身仍逐个执行；
 * pump 执行完毕（异步任务开始后）scheduled 即清空，之后的入队会再安排一次。
 */
function schedulePump(): void {
  if (scheduled) return
  scheduled = true
  const ric = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown
  }).requestIdleCallback
  if (typeof ric === 'function') {
    ric(pump, { timeout: IDLE_TIMEOUT_MS })
  } else {
    setTimeout(pump, 0)
  }
}

/** 把一段低优先级辅助工作排入池。返回后不保证开始时间；失败静默。 */
export function enqueueLowPriority(run: Task): void {
  queue.push(run)
  schedulePump()
}

/** 测试用：清空队列与在途计数 */
export function resetLowPriorityQueue(): void {
  queue.length = 0
  running = 0
  scheduled = false
}