import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDirectoryExistenceCache, useMissingDirectories } from './useMissingDirectories'

const directoryExistsMock = vi.fn<(path: string, serverId?: string) => Promise<boolean>>()

vi.mock('../api', () => ({
  directoryExists: (...args: [string, string?]) => directoryExistsMock(...args),
}))

describe('useMissingDirectories', () => {
  beforeEach(() => {
    directoryExistsMock.mockReset()
    clearDirectoryExistenceCache()
  })

  it('reports only directories that no longer exist', async () => {
    directoryExistsMock.mockImplementation((path: string) =>
      Promise.resolve(path !== '/opt/komidash'),
    )

    const { result } = renderHook(() =>
      useMissingDirectories(['/opt/komidash', '/opt/code/komidash'], 'server-1'),
    )

    await waitFor(() => {
      expect(result.current.has('/opt/komidash')).toBe(true)
    })
    expect(result.current.has('/opt/code/komidash')).toBe(false)
  })

  it('does not hide anything when the probe fails', async () => {
    // 探测失败按「存在」处理：网络抖动不应让项目从侧栏消失
    directoryExistsMock.mockResolvedValue(true)

    const { result } = renderHook(() => useMissingDirectories(['/opt/komidash'], 'server-1'))

    await waitFor(() => expect(directoryExistsMock).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it('normalizes backslashes before comparing', async () => {
    directoryExistsMock.mockImplementation((path: string) => Promise.resolve(path !== 'C:/repo/old'))

    const { result } = renderHook(() => useMissingDirectories(['C:\\repo\\old'], 'server-1'))

    await waitFor(() => expect(result.current.has('C:/repo/old')).toBe(true))
  })
})
