import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDirectoryExistenceCache, useMissingDirectories } from './useMissingDirectories'
import type { DirectoryExistence } from '../api'

const probeDirectoryMock = vi.fn<(path: string, serverId?: string) => Promise<DirectoryExistence>>()

vi.mock('../api', () => ({
  probeDirectory: (...args: [string, string?]) => probeDirectoryMock(...args),
}))

describe('useMissingDirectories', () => {
  beforeEach(() => {
    probeDirectoryMock.mockReset()
    clearDirectoryExistenceCache()
  })

  it('reports only directories that no longer exist', async () => {
    probeDirectoryMock.mockImplementation((path: string) =>
      Promise.resolve(path !== '/opt/komidash' ? 'exists' : 'missing'),
    )

    const { result } = renderHook(() => useMissingDirectories(['/opt/komidash', '/opt/code/komidash'], 'server-1'))

    await waitFor(() => {
      expect(result.current.has('/opt/komidash')).toBe(true)
    })
    expect(result.current.has('/opt/code/komidash')).toBe(false)
  })

  it('does not hide anything when the probe is unknown', async () => {
    // 请求本身失败（网络抖动、路径非法等）无法断定目录不存在，不能隐藏项目
    probeDirectoryMock.mockResolvedValue('unknown')

    const { result } = renderHook(() => useMissingDirectories(['/opt/komidash'], 'server-1'))

    await waitFor(() => expect(probeDirectoryMock).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it('does not hide a relative path when the backend rejects it', async () => {
    probeDirectoryMock.mockResolvedValue('unknown')

    const { result } = renderHook(() => useMissingDirectories(['../code/OCC'], 'server-1'))

    await waitFor(() => expect(probeDirectoryMock).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it('normalizes backslashes before comparing', async () => {
    probeDirectoryMock.mockImplementation((path: string) =>
      Promise.resolve(path !== 'C:/repo/old' ? 'exists' : 'missing'),
    )

    const { result } = renderHook(() => useMissingDirectories(['C:\\repo\\old'], 'server-1'))

    await waitFor(() => expect(result.current.has('C:/repo/old')).toBe(true))
  })
})
