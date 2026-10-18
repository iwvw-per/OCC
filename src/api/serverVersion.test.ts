import { describe, expect, it, vi } from 'vitest'
import { detectServerVersion } from './serverVersion'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('detectServerVersion', () => {
  it('reads the version from /api/info', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: '2.0.28', pid: 1 }))
    const info = await detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })
    expect(info).toEqual({ version: '2.0.28' })
  })

  it('throws when /api/info is unavailable (v1 servers are unsupported)', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }))
    await expect(detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })).rejects.toThrow()
  })

  it('throws when the endpoint is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })).rejects.toThrow()
  })

  it('normalizes trailing slashes', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return jsonResponse({ version: '2.0.28' })
    })
    await detectServerVersion({ baseUrl: 'http://host/', fetch: fetchMock as never })
    expect(seen[0]).toBe('http://host/api/info')
  })
})
