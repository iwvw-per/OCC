import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveBaseUrlMock, getActiveAuthMock, isTauriMock, getServerBaseUrlMock, getServerAuthMock, getActiveServerIdMock } =
  vi.hoisted(() => ({
    getActiveBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getActiveAuthMock: vi.fn(() => null),
    isTauriMock: vi.fn(() => false),
    getServerBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getServerAuthMock: vi.fn(() => null),
    getActiveServerIdMock: vi.fn(() => 'srv-1'),
  }))

vi.mock('../store/serverStore', () => ({
  makeAuthHeader: vi.fn(() => 'Bearer token'),
  serverStore: {
    getActiveBaseUrl: getActiveBaseUrlMock,
    getActiveAuth: getActiveAuthMock,
    getActiveServerId: getActiveServerIdMock,
    getServerBaseUrl: getServerBaseUrlMock,
    getServerAuth: getServerAuthMock,
  },
}))

vi.mock('../utils/tauri', () => ({
  isTauri: isTauriMock,
}))

describe('trackedFetch lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    isTauriMock.mockReturnValue(false)
    getActiveAuthMock.mockReturnValue(null)
    getServerAuthMock.mockReturnValue(null)
    const { abortInFlightApiRequests } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
  })

  it('aborts in-flight requests when the server endpoint changes', async () => {
    const { abortInFlightApiRequests, getApiRequestGeneration, trackedFetch } = await import('./sdk')
    let signal: AbortSignal | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })

    const request = trackedFetch('http://127.0.0.1:4096/api/project', undefined, getApiRequestGeneration())

    abortInFlightApiRequests('Server endpoint changed')

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
  })

  it('prevents stale requests from starting after endpoint changes', async () => {
    const { abortInFlightApiRequests, trackedFetch } = await import('./sdk')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    const staleGeneration = 0
    abortInFlightApiRequests('Server endpoint changed')

    await expect(
      trackedFetch('http://127.0.0.1:4096/api/project', undefined, staleGeneration),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('buildHeaders', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    getActiveAuthMock.mockReturnValue(null as never)
    getServerAuthMock.mockReturnValue(null as never)
  })

  it('adds Authorization only when credentials are configured', async () => {
    const { buildHeaders } = await import('./sdk')
    expect(buildHeaders('srv-1')).toEqual({})

    getServerAuthMock.mockReturnValue({ username: 'u', password: 'p' } as never)
    expect(buildHeaders('srv-1')).toEqual({ Authorization: 'Bearer token' })
  })
})
