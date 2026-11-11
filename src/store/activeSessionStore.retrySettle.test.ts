// 回归：重试成功后，「重试中」卡片必须消失。
//
// 用户报障（2026-11-11）：截图里工具已经在正常调用、内容也在输出，但
// 「重试中(第 2 次)」卡片一直挂着不消失。
//
// 根因：`touchSession`（消息/part/工具事件到达时调用）本来负责把 retry
// 推回 busy —— 它的注释写得很明确「重试结束、真的开始产出了 → 把 retry 推回
// busy，否则界面会一直停在『正在重试』」。但函数第一行是：
//
//     if (this.serverBusySessions.has(sessionId)) return
//
// 而 `updateStatus({ type: 'retry' })` 里正好调了 `markEvidence(sessionId)`，
// 把该会话加进 serverBusySessions。于是重试开始后，touchSession 每次都在
// 第一行直接返回，推回 busy 的分支永远执行不到 —— 卡片永久滞留。
//
// 修复：retry → busy 的收口必须优先于「已有服务端佐证就跳过」的早退。

import { beforeEach, describe, expect, it } from 'vitest'
import { activeSessionStore } from './activeSessionStore'

describe('retry 状态收敛', () => {
  beforeEach(() => {
    activeSessionStore.initialize({})
    activeSessionStore.initializePendingRequests([], [])
  })

  it('重试被调度后，收到真实活动应把状态推回 busy（卡片消失）', () => {
    const sid = 'local::ses_retry'

    // 1. 服务端调度了第 2 次重试
    activeSessionStore.updateStatus(sid, {
      type: 'retry',
      attempt: 2,
      message: 'ECONNRESET',
      next: Date.now() + 5000,
    } as never)
    expect(activeSessionStore.getSessionStatus(sid)?.type).toBe('retry')

    // 2. 重试成功，模型开始产出（消息/part/工具事件到达 → touchSession）
    activeSessionStore.touchSession(sid)

    // 关键：必须收敛为 busy，否则界面永远停在「重试中」
    expect(activeSessionStore.getSessionStatus(sid)?.type).toBe('busy')
  })

  it('retry 状态下连续多次活动也只收敛为 busy，不反复', () => {
    const sid = 'local::ses_retry2'
    activeSessionStore.updateStatus(sid, {
      type: 'retry',
      attempt: 1,
      message: 'timeout',
      next: Date.now(),
    } as never)

    activeSessionStore.touchSession(sid)
    activeSessionStore.touchSession(sid)

    expect(activeSessionStore.getSessionStatus(sid)?.type).toBe('busy')
  })
})
