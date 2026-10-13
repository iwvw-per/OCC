import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createOpencodeClientMock, createV2FacadeMock, getActiveBaseUrlMock, getActiveAuthMock, isTauriMock, getApiVersionMock, getServerBaseUrlMock, getServerAuthMock, getActiveServerIdMock } =
  vi.hoisted(() => ({
    createOpencodeClientMock: vi.fn((config: unknown) => ({ config, kind: 'v1-path' })),
    createV2FacadeMock: vi.fn(() => ({ kind: 'v2-facade' })),
    getActiveBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getActiveAuthMock: vi.fn(() => null),
    isTauriMock: vi.fn(() => false),
    getApiVersionMock: vi.fn(() => undefined),
    getServerBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
    getServerAuthMock: vi.fn(() => null),
    getActiveServerIdMock: vi.fn(() => 'srv-1'),
  }))

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: createOpencodeClientMock,
}))

vi.mock('../store/serverStore', () => ({
  makeBasicAuthHeader: vi.fn(() => 'Basic token'),
  serverStore: {
    getActiveBaseUrl: getActiveBaseUrlMock,
    getActiveAuth: getActiveAuthMock,
    getActiveServerId: getActiveServerIdMock,
    getServerBaseUrl: getServerBaseUrlMock,
    getServerAuth: getServerAuthMock,
    getApiVersion: getApiVersionMock,
  },
}))

vi.mock('./clientFacade', () => ({
  createV2Facade: createV2FacadeMock,
}))

vi.mock('../utils/tauri', () => ({
  isTauri: isTauriMock,
}))

type MockClient = {
  config: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }
}

describe('sdk request lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    getActiveBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getActiveAuthMock.mockReturnValue(null)
    isTauriMock.mockReturnValue(false)
    getApiVersionMock.mockReturnValue(undefined)
    getServerBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getServerAuthMock.mockReturnValue(null)
    getActiveServerIdMock.mockReturnValue('srv-1')
    const { abortInFlightApiRequests, invalidateSDKClient } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
    invalidateSDKClient()
  })

  it('aborts in-flight SDK requests when the server endpoint changes', async () => {
    const { abortInFlightApiRequests, getSDKClient } = await import('./sdk')
    let signal: AbortSignal | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })

    const client = getSDKClient() as unknown as MockClient
    const request = client.config.fetch('http://127.0.0.1:4096/project/current')

    abortInFlightApiRequests('Server endpoint changed')

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
  })

  it('prevents stale SDK clients from starting new requests after endpoint changes', async () => {
    const { abortInFlightApiRequests, getSDKClient } = await import('./sdk')
    const client = getSDKClient() as unknown as MockClient
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    abortInFlightApiRequests('Server endpoint changed')

    await expect(client.config.fetch('http://127.0.0.1:4096/project/current')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rebuilds the v2 facade when version detection flips to v2 after a v1-path client was cached', async () => {
    const { getSDKClient } = await import('./sdk')

    // 启动阶段版本未探测：先按 v1 路径建 client 并缓存。
    getApiVersionMock.mockReturnValue(undefined)
    const first = getSDKClient() as unknown as { kind: string }
    expect(first.kind).toBe('v1-path')

    // 健康检查随后探测到 v2：缓存必须失效，重建为 v2 facade。
    getApiVersionMock.mockReturnValue('v2')
    const second = getSDKClient() as unknown as { kind: string }
    expect(second.kind).toBe('v2-facade')

    // v2 结果稳定后不重复重建。
    expect(getSDKClient()).toBe(second)
  })
})
