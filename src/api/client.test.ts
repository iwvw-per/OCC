import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateMicroCache } from '../utils/microCache'

const { nativeGetProvidersMock } = vi.hoisted(() => ({ nativeGetProvidersMock: vi.fn() }))

vi.mock('./v2NativeConfig', () => ({
  nativeGetProviders: (...args: unknown[]) => nativeGetProvidersMock(...args),
  nativeGetConfig: vi.fn(),
  nativeGetConfigEntries: vi.fn(),
  nativeReloadLocations: vi.fn(),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    getServerBaseUrl: () => 'http://127.0.0.1:4096',
    getActiveBaseUrl: () => 'http://127.0.0.1:4096',
    getServerAuth: () => undefined,
    getActiveAuth: () => undefined,
    getEnabledServers: () => [],
    onServerChange: () => () => {},
    subscribe: () => () => {},
    getApiVersion: () => 'v2',
    getHealth: () => undefined,
    checkHealth: async () => ({ status: 'online' }),
  },
  makeAuthHeader: () => ({}),
  getUnifiedFetch: async () => globalThis.fetch,
}))

const providersPayload = {
  providers: [
    {
      id: 'p1',
      name: 'P1',
      models: { m1: { id: 'm1', name: 'M1', status: 'active', limit: {}, capabilities: {} } },
    },
  ],
}

describe('getActiveModels 缓存', () => {
  beforeEach(() => {
    invalidateMicroCache('providers-models:')
    nativeGetProvidersMock.mockReset()
    nativeGetProvidersMock.mockResolvedValue(providersPayload)
  })

  it('同一 server 的 provider/model 只拉一次(模块预取 + 组件挂载合并)', async () => {
    // 回归:此前仅在途合并,没有结果缓存;模块级预取与组件挂载先后触发时
    // 会各发一次 provider.list + model.list(经隧道每次约 1.1s)。
    const { getActiveModels } = await import('./client')

    const first = await getActiveModels(undefined, 'local')
    const second = await getActiveModels(undefined, 'local')

    expect(nativeGetProvidersMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({ id: 'm1', providerId: 'p1' })
  })
})
