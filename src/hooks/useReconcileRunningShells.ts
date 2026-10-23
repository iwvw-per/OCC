// ============================================
// useReconcileRunningShells — 用 shell.list 校正后台任务状态
// ============================================
//
// 实时事件（`shell.created` / `shell.exited`）能覆盖「页面开着」的情况，
// 但断线重连、切到后台标签页、或**任务在页面打开前就已启动**时，事件全都错过了。
//
// `shell.list` 只返回**仍在运行**的 shell，是一个极轻的权威快照。但它有一个
// 硬限制：**分不出前台与后台** —— 前台阻塞执行的命令同样在列表里。所以不能
// 拿它直接建条目（实测会把每条前台命令都列进面板）。
//
// 因此校正只做两件事，且都以「消息里推导出的后台任务」为准：
//   - 推导出的任务在 shell.list 里 → 确认仍在跑（可纠正历史推导的「已完成」）；
//   - 我们认为在跑、但列表里没有 → 已结束。
//
// 只在挂载、会话切换与页面重新可见时各跑一次，不轮询：启停都有实时事件，
// 轮询只会换来无谓的往返（经隧道一次 1s+）。

import { useEffect } from 'react'
import { listRunningShells } from '../api/shell'
import { backgroundJobStore, useLiveBackgroundJobs } from '../store/backgroundJobStore'
import { sessionKeyToSessionId } from '../utils/sessionKey'

export function useReconcileRunningShells(
  sessionId: string | null,
  directory: string | undefined,
  serverId: string | undefined,
  /**
   * 从消息流推导出的后台任务 id（判据含 `background: true` 与后台回执，
   * 因此能可靠区分前后台）。只有这些 id 允许被 shell.list 提升为「运行中」。
   */
  derivedJobIds?: ReadonlySet<string>,
): void {
  const live = useLiveBackgroundJobs(sessionId)
  /**
   * 实时表的状态签名。
   *
   * 校正必须在**任务表变化后**再跑一次：骨架写入发生在首屏渲染之后，
   * 若只按 sessionId 触发，校正会赶在骨架之前跑完，那时任务表还是空的，
   * 刚加载出来的任务就永远停在「已完成」占位状态（实测如此）。
   */
  const liveSignature = (() => {
    if (live.size === 0) return ''
    const parts: string[] = []
    for (const [id, job] of live) parts.push(`${id}:${job.status}`)
    return parts.join(',')
  })()

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    const run = async () => {
      const shells = await listRunningShells(directory, serverId)
      if (cancelled) return
      /**
       * 属于本会话、且**消息流能证明是后台任务**的 shell。
       *
       * ⚠️ 两边会话 id 格式不同：面板里是**复合 key**
       * （`aiagent:inst_x::ses_y`），shell metadata 里是**原始 id**（`ses_y`），
       * 直接比较永不相等 —— 这是「运行中永远匹配不到」的一个成因。
       */
      const rawSessionId = sessionKeyToSessionId(sessionId)
      const running = new Map<string, { at: number; title?: string }>()
      /** 本会话此刻在跑的所有 shell（含前台命令）：只用于「不要误判结束」 */
      const present = new Set<string>()
      for (const shell of shells) {
        if (!shell.sessionID || shell.sessionID !== rawSessionId) continue
        present.add(shell.id)
        /**
         * 已登记的条目直接提升为 running。
         *
         * `backgroundJobStore.has` 为真说明它已经进了任务表（骨架/工具回执/
         * 完成通知），那就一定是后台任务，可以放心提升 —— 这一步能纠正
         * 骨架给的 unknown/completed。
         *
         * 未登记的条目只接受白名单（`derivedJobIds`）：`shell.list` 分不出
         * 前后台，无条件采纳会把正在执行的前台命令也列进面板。
         */
        if (!backgroundJobStore.has(sessionId, shell.id) && !derivedJobIds?.has(shell.id)) continue
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

      backgroundJobStore.reconcileRunning(sessionId, running, candidates, present)
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
    // 依赖里带上「白名单规模」：骨架加载完成后白名单才会出现，
    // 那之后必须再校正一次，否则当时还未知的任务会一直停在占位状态。
    // 用规模而非 Set 引用，避免集合内容抖动导致重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, directory, serverId, derivedJobIds?.size ?? 0, liveSignature])
}
