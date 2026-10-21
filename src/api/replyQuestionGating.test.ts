import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeReplyFormMock, nativeCancelFormMock, getActiveServerIdMock } = vi.hoisted(() => ({
  nativeReplyFormMock: vi.fn(),
  nativeCancelFormMock: vi.fn(),
  getActiveServerIdMock: vi.fn(() => 'srv'),
}))

vi.mock('./v2NativeSession', () => ({
  nativeReplyForm: (...args: unknown[]) => nativeReplyFormMock(...args),
  nativeCancelForm: (...args: unknown[]) => nativeCancelFormMock(...args),
}))

vi.mock('./v2NativeAgent', () => ({ nativeListPermissions: vi.fn() }))
vi.mock('./sdkV2', () => ({ getV2Client: () => ({}) }))
vi.mock('./v2/form', () => ({ adaptFormToQuestionRequest: (f: unknown) => f }))
vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => getActiveServerIdMock(),
  },
}))
vi.mock('../utils/microCache', () => ({ microCache: (_k: string, fn: () => unknown) => fn(), invalidateMicroCache: vi.fn() }))
vi.mock('../utils/sessionKey', () => ({
  resolveSessionTarget: (sessionId: string, serverId?: string) => ({ sessionId, serverId }),
  splitSessionKey: (key: string) => ({ serverId: 'srv', sessionId: key.includes('::') ? key.split('::')[1] : key }),
}))
vi.mock('../utils/directoryUtils', () => ({ formatPathForApi: (d?: string) => d, directoryCacheKey: (d?: string) => d ?? '' }))

import { replyQuestion } from './permission'

describe('replyQuestion form gating', () => {
  beforeEach(() => {
    nativeReplyFormMock.mockReset()
    getActiveServerIdMock.mockReturnValue('srv')
  })

  it('posts a form answer when the request carries fields', async () => {
    await replyQuestion('form_1', [['prod']], undefined, 'srv', 'srv::ses_1', [{ key: 'env', type: 'string' }])

    expect(nativeReplyFormMock).toHaveBeenCalledWith('srv', {
      sessionID: 'ses_1',
      formID: 'form_1',
      answer: { env: 'prod' },
    })
  })

  it('does not post an empty form answer for a native question without fields', async () => {
    // v2 原生 question.asked 没有 fieldKey → fields 为空。若仍走 form.reply 会提交空 answer，
    // 因此直接拒绝作答（返回 false），绝不调用 nativeReplyForm。
    const result = await replyQuestion('q_1', [['yes']], undefined, 'srv', 'srv::ses_1', [])

    expect(nativeReplyFormMock).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })
})
