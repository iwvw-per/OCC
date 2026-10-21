import { describe, expect, it, vi, beforeEach } from 'vitest'
import { hasLongLivedCredentials } from './ptyCredentials'
import { getPtyConnectUrl } from './pty'

const auth = { username: 'opencode', password: 's3cret' }

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'srv',
    getServerAuth: () => auth,
    getActiveAuth: () => auth,
  },
  getUnifiedFetch: async () => globalThis.fetch,
}))

vi.mock('./http', () => ({
  getApiBaseUrl: () => 'https://remote.example',
  getAuthHeader: () => ({ Authorization: 'Basic abc' }),
  buildQueryString: (params: Record<string, string | number | undefined>) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&')
    return query ? `?${query}` : ''
  },
}))

vi.mock('../utils/directoryUtils', () => ({ formatPathForApi: (dir?: string) => dir ?? '' }))
vi.mock('../utils/tauri', () => ({ isTauri: () => false }))

describe('getPtyConnectUrl — 不在 URL 里写长期凭据', () => {
  beforeEach(() => vi.clearAllMocks())

  it('omits password and userinfo when no stream token is supplied', () => {
    const url = getPtyConnectUrl('pty-1', '/repo', {}, 'srv')

    expect(url).not.toContain('s3cret')
    expect(url).not.toContain('opencode:')
    expect(hasLongLivedCredentials(url)).toBe(false)
  })

  it('carries only the short-lived stream token', () => {
    const url = getPtyConnectUrl('pty-1', '/repo', { streamToken: 'grant-abc' }, 'srv')

    expect(url).toContain('st=grant-abc')
    expect(hasLongLivedCredentials(url)).toBe(false)
  })
})
