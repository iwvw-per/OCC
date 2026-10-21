import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVcsInfo } from './useVcsInfo'
import type { VcsInfo } from '../types/domain/vcs'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function makeVcsInfo(branch: string): VcsInfo {
  return { branch }
}

const getVcsInfoMock = vi.fn()
const onServerChangeMock = vi.fn()

vi.mock('../api/vcs', () => ({
  getVcsInfo: (...args: unknown[]) => getVcsInfoMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
  },
}))

describe('useVcsInfo request race handling', () => {
  beforeEach(() => {
    getVcsInfoMock.mockReset()
    onServerChangeMock.mockReset()
    onServerChangeMock.mockReturnValue(vi.fn())
  })

  it('does not let a stale in-flight request overwrite the result after serverId changes', async () => {
    const stale = createDeferred<VcsInfo | null>()
    const fresh = createDeferred<VcsInfo | null>()

    getVcsInfoMock.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => fresh.promise)

    const { result, rerender } = renderHook(
      ({ serverId }: { serverId: string }) => useVcsInfo('C:/repo', serverId),
      { initialProps: { serverId: 'server-a' } },
    )

    await waitFor(() => expect(getVcsInfoMock).toHaveBeenCalledTimes(1))

    rerender({ serverId: 'server-b' })
    await waitFor(() => expect(getVcsInfoMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      fresh.resolve(makeVcsInfo('fresh-branch'))
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.vcsInfo?.branch).toBe('fresh-branch'))

    await act(async () => {
      stale.resolve(makeVcsInfo('stale-branch'))
      await Promise.resolve()
    })

    expect(result.current.vcsInfo?.branch).toBe('fresh-branch')
    expect(result.current.isLoading).toBe(false)
  })

  it('still delivers the current request result after the effect is re-run by fetchVcs identity', async () => {
    const deferred = createDeferred<VcsInfo | null>()
    getVcsInfoMock.mockImplementation(() => deferred.promise)

    const { result } = renderHook(() => useVcsInfo('C:/repo', 'server-a'))

    await waitFor(() => expect(getVcsInfoMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      deferred.resolve(makeVcsInfo('current-branch'))
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.vcsInfo?.branch).toBe('current-branch'))
    expect(result.current.isLoading).toBe(false)
  })

})
