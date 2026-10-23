// ============================================
// useReconcileRunningShells — 用 shell.list 校正一次后台任务状态
// ============================================
//
// 实时事件（`shell.created` / `shell.exited`）能覆盖「打开着页面」的情况，
// 但断线重连、切到后台标签页、或先开页面后启动的任务，都可能错过退出事件。
//
// `shell.list` 只返回**仍在运行**的 shell，因此它是一个极轻的权威快照：
//   - 列表里有的 → 标成 running（可纠正历史推导的「已完成」）；
//   - 我们以为在跑、列表里没有的 → 标成已完成。
//
// 只在挂载、会话切换与页面重新可见时各跑一次，不轮询：后台任务的启停都有
// 实时事件，轮询只会换来无谓的往返（经隧道一次 1s+）。

import { useEffect } from 'react'
import { listRunningShells } from '../api/shell'
import { backgroundJobStore, useLiveBackgroundJobs } from '../store/backgroundJobStore'
import { sessionKeyToSessionId } from '../utils/sessionKey'

export function useReconcileRunningShells(
  sessionId: string | null,
  directory: string | undefined,
  serverId: string | undefined,
): void {
  const live = useLiveBackgroundJobs(sessionId)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    const run = async () => {
      const shells = await listRunningShells(directory, serverId)
      if (cancelled) return
      /**
       * 只把属于本会话的任务标成 running。
       *
       * `shell.list` 按目录返回，同一目录下可能有别的会话（或其他窗口）启动的
       * 任务。用 metadata.sessionID 过滤，避免把别人的任务显示到本会话面板。
       * 没有 sessionID 的条目（第三方客户端启动）不参与归属判断，跳过。
       *
       * ⚠️ 两边格式不同：面板里的 sessionId 是**复合 key**
       * （`aiagent:inst_x::ses_y`），而 shell metadata 里是**原始 id**（`ses_y`）。
       * 直接比较永远不相等，会导致「运行中」永远匹配不到 —— 这正是
       * 「后台任务始终显示已结束」的第二个成因。
       */
      const rawSessionId = sessionKeyToSessionId(sessionId)
      const running = new Map<string, { at: number; title?: string }>()
      for (const shell of shells) {
        if (!shell.sessionID || shell.sessionID !== rawSessionId) continue
        running.set(shell.id, {
          at: shell.startedAt,
          ...(shell.command ? { title: shell.command.slice(0, 80) } : {}),
        })
      }
      /**
       * 候选集：当前认为还在跑的条目。
       *
       * 不在 `shell.list` 里说明它们已经结束 —— 但要排除子代理任务
       * （它们不是 shell，本来就不会出现在这个列表里）。
       */
      const candidates =
        live.size === 0
          ? []
          : [...live.entries()]
              .filter(([, job]) => job.status === 'running')
              .map(([id]) => id)

      backgroundJobStore.reconcileRunning(sessionId, running, candidates)
    }

    void run()

    // 页面重新可见时再校正一次：后台标签页里的 SSE 可能被浏览器节流
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // live 刻意不进依赖：它是本 hook 的输入快照，变化只影响 candidates 的取值，
    // 放进依赖会让「每次状态变化都重发一次 shell.list」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, directory, serverId])
}
