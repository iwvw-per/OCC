// nativeRevertMessage 必须 stage + commit 两段完成。
//
// v2 的 revert 是两段式：stage 只是暂存回退点（服务端保持 pending），commit 才
// 真正落库（GET /session 的 revert 字段才带值、广播 session.revert.committed）。
// 只 stage 不 commit 会让本地乐观的 revertState 在服务端没有持久化对应物，
// 任何以服务端为准的重拉都会把它覆盖回 null —— 正是「撤销后又恢复，需要重复
// 好多次」的根因（官方对照见 opencode-mobile#751 / 官方 web/TUI 的 submit.ts）。

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

describe('nativeRevertMessage (v2 stage + commit)', () => {
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

  it('stages then commits the revert so it persists server-side', async () => {
    await nativeRevertMessage('srv', { sessionID: 'ses_1', messageID: 'm2' })

    expect(stageMock).toHaveBeenCalledWith({ sessionID: 'ses_1', messageID: 'm2' })
    // 关键：stage 之后必须 commit，否则回退一直 pending，刷新/重拉后被覆盖
    expect(commitMock).toHaveBeenCalledWith({ sessionID: 'ses_1' })
    // 之后 re-read 会话，返回给调用方的是 commit 后的权威快照
    expect(getMock).toHaveBeenCalledWith({ sessionID: 'ses_1' })
  })

  it('clear only calls revert.clear (undo of revert is one step)', async () => {
    getMock.mockResolvedValue({ id: 'ses_1' })

    await nativeUnrevertSession('srv', 'ses_1')

    expect(clearMock).toHaveBeenCalledWith({ sessionID: 'ses_1' })
    expect(commitMock).not.toHaveBeenCalled()
    expect(stageMock).not.toHaveBeenCalled()
  })
})