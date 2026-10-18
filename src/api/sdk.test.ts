import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createV2FacadeMock, getActiveBaseUrlMock, getActiveAuthMock, isTauriMock, getServerBaseUrlMock, getServerAuthMock, getActiveServerIdMock } =
  vi.hoisted(() => ({
    createV2FacadeMock: vi.fn(() => ({ kind: 'v2-facade' })),
    getActiveBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getActiveAuthMock: vi.fn(() => null),
    isTauriMock: vi.fn(() => false),
    getServerBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getServerAuthMock: vi.fn(() => null),
    getActiveServerIdMock: vi.fn(() => 'srv-1'),
  }))

vi.mock('../store/serverStore', () => ({
  makeBasicAuthHeader: vi.fn(() => 'Basic token'),
  serverStore: {
    getActiveBaseUrl: getActiveBaseUrlMock,
    getActiveAuth: getActiveAuthMock,
    getActiveServerId: getActiveServerIdMock,
    getServerBaseUrl: getServerBaseUrlMock,
    getServerAuth: getServerAuthMock,
  },
}))

vi.mock('./clientFacade', () => ({
  createV2Facade: createV2FacadeMock,
}))

vi.mock('../utils/tauri', () => ({
  isTauri: isTauriMock,
}))

describe('sdk client lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    createV2FacadeMock.mockClear()
    getActiveBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getActiveAuthMock.mockReturnValue(null)
    isTauriMock.mockReturnValue(false)
    getServerBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getServerAuthMock.mockReturnValue(null)
    getActiveServerIdMock.mockReturnValue('srv-1')
    const { abortInFlightApiRequests, invalidateSDKClient } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
    invalidateSDKClient()
  })

  it('always returns the v2 facade and caches it per server', async () => {
    const { getSDKClient } = await import('./sdk')

    const first = getSDKClient() as unknown as { kind: string }
    expect(first.kind).toBe('v2-facade')
    // 同一 serverId 复用缓存，不重复构建
    expect(getSDKClient()).toBe(first)
  })

  it('rebuilds the facade after invalidateSDKClient', async () => {
    const { getSDKClient, invalidateSDKClient } = await import('./sdk')

    const first = getSDKClient()
    invalidateSDKClient()
    const second = getSDKClient()

    expect(second).not.toBe(first)
  })

  it('rebuilds the facade when the server endpoint changes', async () => {
    const { getSDKClient } = await import('./sdk')

    const first = getSDKClient('srv-1')
    getServerBaseUrlMock.mockReturnValue('http://127.0.0.1:4599')
    const second = getSDKClient('srv-1')

    expect(second).not.toBe(first)
  })
})

describe('trackedFetch lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    const { abortInFlightApiRequests, invalidateSDKClient } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
    invalidateSDKClient()
  })

  it('aborts in-flight requests when the server endpoint changes', async () => {
    const { abortInFlightApiRequests } = await import('./sdk')
    let signal: AbortSignal | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })

    const { trackedFetch, getApiRequestGeneration } = await import('./sdk')
    const request = trackedFetch('http://127.0.0.1:4096/project/current', undefined, getApiRequestGeneration())

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
      trackedFetch('http://127.0.0.1:4096/project/current', undefined, staleGeneration),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
