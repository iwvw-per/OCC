import { describe, expect, it, vi, beforeEach } from 'vitest'

const isTauriMock = vi.fn(() => false)
const readHostBootstrapMock = vi.fn(() => ({} as { host?: 'tauri' | 'web' }))
const invokeMock = vi.fn(async () => true)

vi.mock('../utils/tauri', () => ({ isTauri: () => isTauriMock() }))
vi.mock('../utils/hostBootstrap', () => ({ readHostBootstrap: () => readHostBootstrapMock() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...(args as [])) }))
vi.mock('../store/serverStore', () => ({
  makeAuthHeader: () => 'Basic dTpw',
}))

import { handOffCredential, hostCredentialsAvailable, hostOwnsCredential, forgetHostCredential } from './hostCredential'

describe('hostCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(false)
    readHostBootstrapMock.mockReturnValue({})
  })

  it('is unavailable in the browser', () => {
    expect(hostCredentialsAvailable()).toBe(false)
  })

  it('requires the host bootstrap marker, not just Tauri', () => {
    isTauriMock.mockReturnValue(true)
    expect(hostCredentialsAvailable()).toBe(false)

    readHostBootstrapMock.mockReturnValue({ host: 'tauri' })
    expect(hostCredentialsAvailable()).toBe(true)
  })

  it('hands the credential to the host when available', async () => {
    isTauriMock.mockReturnValue(true)
    readHostBootstrapMock.mockReturnValue({ host: 'tauri' })

    expect(await handOffCredential('srv-1', { username: 'u', password: 'p' } as never)).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('credential_set', { serverId: 'srv-1', authorization: 'Basic dTpw' })
  })

  it('degrades silently when handing off fails', async () => {
    isTauriMock.mockReturnValue(true)
    readHostBootstrapMock.mockReturnValue({ host: 'tauri' })
    invokeMock.mockRejectedValueOnce(new Error('no such command'))

    expect(await handOffCredential('srv-1', { username: 'u', password: 'p' } as never)).toBe(false)
  })

  it('reports ownership conservatively on errors', async () => {
    isTauriMock.mockReturnValue(true)
    readHostBootstrapMock.mockReturnValue({ host: 'tauri' })
    invokeMock.mockRejectedValueOnce(new Error('boom'))

    expect(await hostOwnsCredential('srv-1')).toBe(false)
  })

  it('swallows delete errors', async () => {
    isTauriMock.mockReturnValue(true)
    readHostBootstrapMock.mockReturnValue({ host: 'tauri' })
    invokeMock.mockRejectedValueOnce(new Error('boom'))

    await expect(forgetHostCredential('srv-1')).resolves.toBeUndefined()
  })
})
