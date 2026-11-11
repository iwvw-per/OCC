// nativeRevertMessage 必须**只 stage、不 commit**。
//
// ## 为什么（2026-11-11 实测 + 官方源码，推翻了此前的错误假设）
//
// 曾按「stage 只是暂存、commit 才持久化」补过 commit，结果造成用户报障：
// 点「从此处撤销」后消息立刻回来、界面退回发送态、无法编辑。
//
// 真实语义（packages/core/src/session/revert.ts + projector.ts）：
//   - stage  → 把 {messageID, snapshot, files} 写入 session.revert，并回滚文件
//              快照。**撤销态本身就是持久化的**：实测 stage 后 GET /api/session
//              立刻能读到 revert 字段。
//   - commit → 物理删除边界 seq 之后的全部消息：
//                delete from SessionMessage where seq >= boundary.seq
//                setSession(..., { revert: null })   ← 撤销态被清空
//              实测 commit 后 revert 变 null，再 stage 同一 messageID 报
//              MessageNotFoundError（消息真的被删了）。
//   - clear  → 清掉 session.revert 并恢复文件快照。
//
// 所以 commit 是「确认丢弃这些消息」的破坏性动作，不该由「从此处撤销」触发。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { stageMock, commitMock, clearMock, getMock } = vi.hoisted(() => ({
  stageMock: vi.fn(),
  commitMock: vi.fn(),
  clearMock: vi.fn(),
  getMock: vi.fn(),
}))

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    session: {
      revert: { stage: stageMock, commit: commitMock, clear: clearMock },
      get: getMock,
    },
  }),
}))

import { nativeRevertMessage, nativeUnrevertSession } from './v2NativeSession'

describe('nativeRevertMessage（v2 只 stage）', () => {
  beforeEach(() => {
    stageMock.mockReset()
    commitMock.mockReset()
    clearMock.mockReset()
    getMock.mockReset()
    stageMock.mockResolvedValue(undefined)
    commitMock.mockResolvedValue(undefined)
    clearMock.mockResolvedValue(undefined)
    getMock.mockResolvedValue({ id: 'ses_1', revert: { messageID: 'm2' } })
  })

  it('只调用 stage，绝不调用 commit', async () => {
    await nativeRevertMessage('srv', { sessionID: 'ses_1', messageID: 'm2' })

    expect(stageMock).toHaveBeenCalledWith({ sessionID: 'ses_1', messageID: 'm2' })
    /**
     * 关键回归：commit 会物理删除消息并把 revert 置 null，
     * 表现为「撤销后立刻恢复发送状态、无法编辑」。
     */
    expect(commitMock).not.toHaveBeenCalled()
    // stage 之后回读权威快照，返回给调用方用于校正 revert 点
    expect(getMock).toHaveBeenCalledWith({ sessionID: 'ses_1' })
  })

  it('撤销已提交时（redo 到底）只调用 clear，不碰 stage/commit', async () => {
    getMock.mockResolvedValue({ id: 'ses_1' })

    await nativeUnrevertSession('srv', 'ses_1')

    expect(clearMock).toHaveBeenCalledWith({ sessionID: 'ses_1' })
    expect(commitMock).not.toHaveBeenCalled()
    expect(stageMock).not.toHaveBeenCalled()
  })
})
