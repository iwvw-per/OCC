// nativeUpdateSession 归档时不得覆盖既有 metadata：后端对 metadata 是整段替换，
// 必须读出合并后只改 __archived。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateMock, getMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  getMock: vi.fn(),
}))

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    session: { update: updateMock, get: getMock },
  }),
}))

import { nativeUpdateSession } from './v2NativeSession'

describe('nativeUpdateSession metadata handling', () => {
  beforeEach(() => {
    updateMock.mockReset()
    getMock.mockReset()
    updateMock.mockResolvedValue(undefined)
  })

  it('merges existing metadata instead of replacing it when archiving', async () => {
    getMock
      .mockResolvedValueOnce({ id: 'ses_1', metadata: { keep: 'ORIG', __archived: 0 } })
      .mockResolvedValueOnce({ id: 'ses_1', metadata: { keep: 'ORIG', __archived: 123 } })

    await nativeUpdateSession('srv', { sessionID: 'ses_1', archived: 123 })

    expect(updateMock).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      metadata: { keep: 'ORIG', __archived: 123 },
    })
  })

  it('does not send a time field (SDK drops it) and preserves metadata on restore', async () => {
    getMock
      .mockResolvedValueOnce({ id: 'ses_1', metadata: { keep: 'ORIG', __archived: 123 } })
      .mockResolvedValueOnce({ id: 'ses_1', metadata: { keep: 'ORIG', __archived: 0 } })

    await nativeUpdateSession('srv', { sessionID: 'ses_1', archived: 0 })

    const arg = updateMock.mock.calls[0][0]
    expect(arg).not.toHaveProperty('time')
    expect(arg.metadata).toEqual({ keep: 'ORIG', __archived: 0 })
  })

  it('only sends the title when no archived value is given', async () => {
    getMock.mockResolvedValueOnce({ id: 'ses_1' })

    await nativeUpdateSession('srv', { sessionID: 'ses_1', title: 'renamed' })

    expect(updateMock).toHaveBeenCalledWith({ sessionID: 'ses_1', title: 'renamed' })
  })
})
