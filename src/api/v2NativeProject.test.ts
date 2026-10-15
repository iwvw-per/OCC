// 验证 v2 原生 project 访问层的 git 检测。
//
// v2 的 location.get 返回的 project 字段不含 vcs（只有 id/directory/canonical），
// vcs 只在 project.list 的项目上。检测顺序：project.list 同 id → 规范化路径匹配
// → vcs.get 的 provider 兜底。用 mock 覆盖各条路径，避免依赖真实沙盒。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { locationGetMock, projectListMock, vcsGetMock } = vi.hoisted(() => ({
  locationGetMock: vi.fn(),
  projectListMock: vi.fn(),
  vcsGetMock: vi.fn(),
}))

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    location: { get: locationGetMock },
    project: { list: projectListMock },
    vcs: { get: vcsGetMock },
  }),
}))

describe('nativeGetCurrentProject vcs 检测', () => {
  beforeEach(() => {
    locationGetMock.mockReset()
    projectListMock.mockReset()
    vcsGetMock.mockReset()
    // 默认：vcs.get 不可用，强制走 project.list 路径
    vcsGetMock.mockRejectedValue(new Error('no vcs'))
  })

  it('project.list 同 id 命中 → vcs git（不依赖路径字符串）', async () => {
    locationGetMock.mockResolvedValue({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })
    projectListMock.mockResolvedValue([{ id: 'p1', canonical: '/completely/different', vcs: 'git' }])
    const { nativeGetCurrentProject } = await import('./v2NativeProject')
    const p = await nativeGetCurrentProject('s1', { directory: '/d' })
    expect(p.vcs).toBe('git')
  })

  it('Windows 反斜杠 + 大小写差异：规范化路径匹配命中', async () => {
    locationGetMock.mockResolvedValue({
      directory: 'C:\\dev\\Proj',
      project: { id: 'x', directory: 'C:\\dev\\Proj', canonical: 'C:\\dev\\Proj' },
    })
    projectListMock.mockResolvedValue([{ id: 'other', canonical: 'c:/dev/proj', vcs: 'git' }])
    const { nativeGetCurrentProject } = await import('./v2NativeProject')
    const p = await nativeGetCurrentProject('s1', { directory: 'C:\\dev\\Proj' })
    expect(p.vcs).toBe('git')
  })

  it('project.list 无匹配 → 用 vcs.get 的 provider 兜底', async () => {
    locationGetMock.mockResolvedValue({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })
    projectListMock.mockResolvedValue([{ id: 'p2', canonical: '/other' }])
    vcsGetMock.mockResolvedValue({ location: { directory: '/d' }, data: { provider: 'git', branch: { current: 'main', default: 'main' } } })
    const { nativeGetCurrentProject } = await import('./v2NativeProject')
    const p = await nativeGetCurrentProject('s1', { directory: '/d' })
    expect(p.vcs).toBe('git')
  })

  it('非 git 仓库：project.list 无 vcs 且 vcs.get 无 provider → vcs undefined', async () => {
    locationGetMock.mockResolvedValue({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })
    projectListMock.mockResolvedValue([{ id: 'p1', canonical: '/d' }])
    vcsGetMock.mockResolvedValue({ location: { directory: '/d' }, data: { branch: {} } })
    const { nativeGetCurrentProject } = await import('./v2NativeProject')
    const p = await nativeGetCurrentProject('s1', { directory: '/d' })
    expect(p.vcs).toBeUndefined()
  })

  it('project.list 抛错时仍能用 vcs.get 兜底', async () => {
    locationGetMock.mockResolvedValue({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })
    projectListMock.mockRejectedValue(new Error('boom'))
    vcsGetMock.mockResolvedValue({ location: { directory: '/d' }, data: { provider: 'git', branch: { current: 'main', default: 'main' } } })
    const { nativeGetCurrentProject } = await import('./v2NativeProject')
    const p = await nativeGetCurrentProject('s1', { directory: '/d' })
    expect(p.vcs).toBe('git')
  })
})
