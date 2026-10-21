// ============================================
// 文件树 git 状态（v2 vcs.status）
// ============================================
//
// 回归用例：此前 getFileStatus 直接 `return []`，理由是「v2 没有全仓库文件状态
// 端点」。实际上 `GET /api/vcs/status` 是可用的，只是字段名与前端 FileStatusItem
// 不同（file/additions/deletions → path/added/removed）。这里锁住映射关系。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const statusMock = vi.fn()

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({ vcs: { status: statusMock } }),
}))
vi.mock('../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'local' },
}))
vi.mock('./v2NativeFile', () => ({
  nativeListDirectory: vi.fn(),
  nativeReadFile: vi.fn(),
  nativeFindFiles: vi.fn(),
}))

const { getFileStatus } = await import('./file')

describe('getFileStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('把 vcs.status 的字段映射成 FileStatusItem', async () => {
    statusMock.mockResolvedValue({
      location: { directory: '/repo' },
      data: [{ file: 'src/a.ts', additions: 12, deletions: 3, status: 'modified' }],
    })

    expect(await getFileStatus('/repo')).toEqual([
      { path: 'src/a.ts', added: 12, removed: 3, status: 'modified' },
    ])
  })

  it('保留 added / deleted 状态', async () => {
    statusMock.mockResolvedValue({
      data: [
        { file: 'new.ts', additions: 5, deletions: 0, status: 'added' },
        { file: 'gone.ts', additions: 0, deletions: 9, status: 'deleted' },
      ],
    })

    const result = await getFileStatus('/repo')
    expect(result.map(item => item.status)).toEqual(['added', 'deleted'])
  })

  it('跳过缺少 file 的异常条目', async () => {
    statusMock.mockResolvedValue({
      data: [{ additions: 1, deletions: 1, status: 'modified' }, { file: 'ok.ts', additions: 1, deletions: 0, status: 'added' }],
    })

    const result = await getFileStatus('/repo')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('ok.ts')
  })

  it('未知状态归一为 modified，缺失计数补 0', async () => {
    statusMock.mockResolvedValue({
      data: [{ file: 'x.ts', status: 'weird' }],
    })

    expect(await getFileStatus('/repo')).toEqual([
      { path: 'x.ts', added: 0, removed: 0, status: 'modified' },
    ])
  })

  it('空响应返回空数组', async () => {
    statusMock.mockResolvedValue({ data: [] })
    expect(await getFileStatus('/repo')).toEqual([])
  })
})
