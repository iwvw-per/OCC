import { describe, expect, it } from 'vitest'
import { normalizeFileReadResult } from './v2NativeFile'

describe('normalizeFileReadResult', () => {
  it('decodes text bytes into the shape the preview expects', () => {
    const raw = new TextEncoder().encode('# title\nbody')

    expect(normalizeFileReadResult(raw, 'README.md')).toEqual({
      type: 'text',
      content: '# title\nbody',
      mimeType: 'text/markdown',
    })
  })

  it('turns binary bytes into base64 with an inferred mime type', () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])

    expect(normalizeFileReadResult(raw, 'logo.png')).toMatchObject({
      type: 'binary',
      encoding: 'base64',
      mimeType: 'image/png',
    })
  })

  it('passes non-byte payloads through untouched', () => {
    const payload = { type: 'text', content: 'already shaped' }

    expect(normalizeFileReadResult(payload, 'a.ts')).toBe(payload)
  })
})