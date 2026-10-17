import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkspaceCatalog } from './useGitWorkspaceCatalog'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const getCurrentProjectMock = vi.fn()
const listWorktreesMock = vi.fn()
const subscribeToEventsMock = vi.fn()
const onServerChangeMock = vi.fn()
let latestServerChange: (() => void) | undefined

const probeDirectoryMock = vi.fn<(directory: string, serverId?: string) => Promise<'exists' | 'missing' | 'unknown'>>(
  () => Promise.resolve('exists'),
)
vi.mock('../api', () => ({
  getCurrentProject: (...args: unknown[]) => getCurrentProjectMock(...args),
  listWorktrees: (...args: unknown[]) => listWorktreesMock(...args),
  probeDirectory: (directory: string, serverId?: string) => probeDirectoryMock(directory, serverId),
}))

vi.mock('../api/events', () => ({
  subscribeToEvents: (...args: unknown[]) => subscribeToEventsMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
  },
}))

describe('useGitWorkspaceCatalog', () => {
  beforeEach(() => {
    getCurrentProjectMock.mockReset()
    listWorktreesMock.mockReset()
    probeDirectoryMock.mockReset()
    probeDirectoryMock.mockResolvedValue('exists')
    subscribeToEventsMock.mockReset()
    onServerChangeMock.mockReset()
    latestServerChange = undefined

    subscribeToEventsMock.mockReturnValue(vi.fn())
    onServerChangeMock.mockImplementation(listener => {
      latestServerChange = listener as () => void
      return vi.fn()
    })
    listWorktreesMock.mockResolvedValue(['C:/repo', 'C:/repo-worktree'])
  })

  it('refetches workspace metadata on server endpoint changes while stale requests are in flight', async () => {
    const staleRequest = createDeferred<{ vcs: string; worktree: string }>()
    const freshRequest = createDeferred<{ vcs: string; worktree: string }>()

    getCurrentProjectMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const directories = ['C:\\repo']
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))

    await waitFor(() => expect(getCurrentProjectMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      latestServerChange?.()
      await Promise.resolve()
    })

    expect(getCurrentProjectMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve({ vcs: 'git', worktree: 'C:/repo' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
    })

    await act(async () => {
      staleRequest.resolve({ vcs: 'git', worktree: 'C:/stale' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.catalog.get('C:/repo')?.rootDirectory).toBe('C:/repo')
    expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
  })

  it('marks a git root as missing when its directory no longer exists', async () => {
    getCurrentProjectMock.mockResolvedValue({
      vcs: 'git',
      worktree: '/opt/komidash',
      sandboxes: ['/opt/code/komidash'],
    })
    listWorktreesMock.mockResolvedValue(['/opt/komidash', '/opt/code/komidash'])
    probeDirectoryMock.mockImplementation((directory: string) =>
      Promise.resolve(directory === '/opt/komidash' ? 'missing' : 'exists'),
    )
    subscribeToEventsMock.mockReturnValue(() => {})

    const { result } = renderHook(() => useGitWorkspaceCatalog(['/opt/code/komidash'], 'server-1'))

    await waitFor(() => {
      expect(result.current.catalog.get('/opt/code/komidash')?.rootExists).toBe(false)
    })
  })

  it('keeps a git root when the probe is unknown (request error)', async () => {
    // 请求失败（路由非法、网络抖动）不能把项目拆成独立分组
    getCurrentProjectMock.mockResolvedValue({
      vcs: 'git',
      worktree: '/opt/komidash',
      sandboxes: ['/opt/code/komidash'],
    })
    listWorktreesMock.mockResolvedValue(['/opt/komidash', '/opt/code/komidash'])
    probeDirectoryMock.mockResolvedValue('unknown')
    subscribeToEventsMock.mockReturnValue(() => {})

    const { result } = renderHook(() => useGitWorkspaceCatalog(['/opt/code/komidash'], 'server-1'))

    await waitFor(() => {
      expect(result.current.catalog.get('/opt/code/komidash')?.rootDirectory).toBe('/opt/komidash')
      expect(result.current.catalog.get('/opt/code/komidash')?.rootExists).toBe(true)
    })
  })
})
