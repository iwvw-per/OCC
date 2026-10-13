import { describe, expect, it, vi } from 'vitest'
import { detectServerVersion } from './serverVersion'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function htmlResponse(status = 200): Response {
  return new Response('<!doctype html><html></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

describe('detectServerVersion', () => {
  it('detects v1 when /global/health returns JSON', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.18.34' })
      return new Response('not found', { status: 404 })
    })
    const info = await detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })
    expect(info).toEqual({ apiVersion: 'v1', version: '1.18.34' })
  })

  it('detects v2 when /global/health returns HTML and /api/info returns JSON', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return htmlResponse()
      if (url.endsWith('/api/info')) return jsonResponse({ version: '2.0.28', pid: 1 })
      return new Response('not found', { status: 404 })
    })
    const info = await detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })
    expect(info).toEqual({ apiVersion: 'v2', version: '2.0.28' })
  })

  it('falls back to v2 when /global/health returns HTML but /api/info is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return htmlResponse()
      return new Response('unauthorized', { status: 401 })
    })
    const info = await detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })
    expect(info).toEqual({ apiVersion: 'v2' })
  })

  it('throws when neither endpoint is recognizable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(detectServerVersion({ baseUrl: 'http://host', fetch: fetchMock as never })).rejects.toThrow()
  })

  it('normalizes trailing slashes', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return jsonResponse({ healthy: true, version: '1.18.34' })
    })
    await detectServerVersion({ baseUrl: 'http://host/', fetch: fetchMock as never })
    expect(seen[0]).toBe('http://host/global/health')
  })
})
