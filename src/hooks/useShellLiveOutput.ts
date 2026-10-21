/**
 * 长命令的实时输出。
 *
 * 背景：v2 的 bash 工具执行期间，事件流只给 `session.tool.called`（开始）和
 * `session.tool.success`（结束）。中间几十秒界面完全静止 —— 用户看到的是
 * 「命令发出去了但什么也没发生」，会以为卡死。
 *
 * 而服务端其实一直在按字节缓存该 shell 进程的输出，并且
 * `session.tool.progress` 事件里带着 `metadata.shellID`。于是只要在工具运行
 * 期间按 cursor 增量读取 `/api/shell/{id}/output`，就能把输出实时喂给界面。
 *
 * 设计要点：
 *   - 只在 running 且拿到 shellID 时轮询，结束立刻停；
 *   - 用 cursor 增量读，不重复下载已读内容；
 *   - 页面隐藏时不轮询（后台标签页没人看，省流量与网关往返）；
 *   - 失败静默并退避：轮询是增强显示，绝不能影响工具本身的最终结果
 *     （最终输出仍以 `tool.success` 的 content 为准）。
 */

import { useEffect, useState } from 'react'
import { getShellOutput } from '../api/shell'

/** 轮询间隔：本地/局域网很快，网关隧道下每次约 1 个往返，1s 是体感与开销的折中 */
const POLL_INTERVAL_MS = 1000
/** 连续失败上限：超过就停，避免对着一个已失效的 shellID 无限打请求 */
const MAX_CONSECUTIVE_FAILURES = 3

export interface ShellLiveOutput {
  /** 已累积的输出（仅在拿到增量时有值） */
  output: string
  /** 是否仍在轮询 */
  active: boolean
}

/** 一次轮询会话的累积状态；按 shellId 换新，天然完成「切换即重置」 */
interface LiveState {
  shellId: string
  output: string
}

export function useShellLiveOutput(params: {
  /** shell 进程 id（来自 tool.progress 的 metadata.shellID） */
  shellId: string | undefined
  /** 工具是否仍在运行 */
  isRunning: boolean
  directory?: string
  serverId?: string
}): ShellLiveOutput {
  const { shellId, isRunning, directory, serverId } = params
  /**
   * 状态里带上它属于哪个 shellId。
   *
   * 这样「切换到另一次工具调用」时不需要 effect + setState 去重置
   * （那会触发一轮级联渲染，lint 也会报 cascading renders），
   * 而是渲染时直接判断：状态里的 shellId 与当前不一致 → 视为空。
   */
  const [live, setLive] = useState<LiveState | null>(null)
  const [stoppedFor, setStoppedFor] = useState<string | null>(null)

  useEffect(() => {
    if (!shellId || !isRunning) return
    if (stoppedFor === shellId) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let cursor = 0
    let failures = 0

    const tick = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        timer = setTimeout(tick, POLL_INTERVAL_MS)
        return
      }
      try {
        const page = await getShellOutput(shellId, { cursor, directory, serverId })
        if (cancelled) return
        failures = 0
        if (page.output) {
          cursor = page.cursor
          const chunk = page.output
          setLive(prev => ({
            shellId,
            output: prev && prev.shellId === shellId ? prev.output + chunk : chunk,
          }))
        }
      } catch {
        if (cancelled) return
        failures += 1
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          setStoppedFor(shellId)
          return
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [shellId, isRunning, directory, serverId, stoppedFor])

  const output = live && live.shellId === shellId ? live.output : ''
  return { output, active: !!shellId && isRunning && stoppedFor !== shellId }
}
