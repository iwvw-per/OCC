// 验证 v2 原生 vcs.diff 的 mode 映射与路径透传。
//
// 前端沿用 v1 的 mode 命名（git/branch），v2 只接受 working/branch/committed。
// 若把 'git' 直接透传会 400，变更面板显示 "Failed to load changes"。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { vcsDiffMock } = vi.hoisted(() => ({ vcsDiffMock: vi.fn() }))

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({ vcs: { diff: vcsDiffMock } }),
}))

describe('nativeGetVcsDiff mode 映射', () => {
  beforeEach(() => {
    vcsDiffMock.mockReset()
    vcsDiffMock.mockResolvedValue({ location: { directory: '/d' }, data: [] })
  })

  it("前端 'git' → v2 'working'", async () => {
    const { nativeGetVcsDiff } = await import('./v2NativeAgent')
    await nativeGetVcsDiff('s1', { mode: 'git', directory: '/d' })
    expect(vcsDiffMock.mock.calls[0][0]).toMatchObject({ mode: 'working' })
  })

  it("前端 'branch' → v2 'branch'", async () => {
    const { nativeGetVcsDiff } = await import('./v2NativeAgent')
    await nativeGetVcsDiff('s1', { mode: 'branch', directory: '/d' })
    expect(vcsDiffMock.mock.calls[0][0]).toMatchObject({ mode: 'branch' })
  })

  it('未知 mode 回退到 working', async () => {
    const { nativeGetVcsDiff } = await import('./v2NativeAgent')
    await nativeGetVcsDiff('s1', { mode: 'whatever', directory: '/d' })
    expect(vcsDiffMock.mock.calls[0][0]).toMatchObject({ mode: 'working' })
  })

  it('解包 {location,data} 信封返回 data 数组', async () => {
    vcsDiffMock.mockResolvedValue({ location: { directory: '/d' }, data: [{ file: 'a.txt', additions: 1, deletions: 0 }] })
    const { nativeGetVcsDiff } = await import('./v2NativeAgent')
    const out = await nativeGetVcsDiff('s1', { mode: 'git', directory: '/d' })
    expect(out).toEqual([{ file: 'a.txt', additions: 1, deletions: 0 }])
  })
})
