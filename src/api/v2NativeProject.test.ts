// 验证 v2 原生 project 访问层的 git 检测。
//
// v2 的 location.get 返回的 project 字段不含 vcs（只有 id/directory/canonical），
// vcs 只在 project.list 的项目上。检测顺序：project.list 同 id → 规范化路径匹配
// → vcs.get 的 provider 兜底。用 mock 覆盖各条路径，避免依赖真实沙盒。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateMicroCache } from '../utils/microCache'

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
    // location.get 与 project.list 现在都经 microCache 合并:
    // 测试里 serverId/目录固定,必须逐例失效,否则后续用例会读到上一例的缓存。
    invalidateMicroCache('location:')
    invalidateMicroCache('project-list-raw:')
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

  it('同一 server + 目录的 location.get 合并为一次请求', async () => {
    // 回归:项目面板与 worktree 面板会对同一目录各调一次,URL 完全相同
    // (实测打开会话时该请求发了两遍,经隧道每次约 1.1s)。
    locationGetMock.mockResolvedValue({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })
    projectListMock.mockResolvedValue([{ id: 'p1', canonical: '/d', vcs: 'git' }])
    const { nativeGetCurrentProject } = await import('./v2NativeProject')

    await nativeGetCurrentProject('s1', { directory: '/d' })
    await nativeGetCurrentProject('s1', { directory: '/d' })

    expect(locationGetMock).toHaveBeenCalledTimes(1)
    // project.list 也被两处(项目面板 vcs 检测 / 侧栏分组)共用,同样只发一次
    expect(projectListMock).toHaveBeenCalledTimes(1)
  })
})
