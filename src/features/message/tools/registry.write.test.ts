import { describe, expect, it } from 'vitest'
import { extractToolData } from './registry'

function writePart(state: unknown) {
  return {
    type: 'tool',
    id: 'call_1',
    callID: 'call_1',
    tool: 'write',
    state,
  } as never
}

describe('extractToolData write (v2 input.path)', () => {
  it('extracts filePath from input.path (v2 write tool)', () => {
    const data = extractToolData(
      writePart({ status: 'completed', input: { path: '/tmp/opencode/v2qa/workdir/hello.txt', content: 'hi' }, metadata: { truncated: false } }),
    )
    expect(data.filePath).toBe('/tmp/opencode/v2qa/workdir/hello.txt')
  })

  it('still uses metadata.filepath when present (v1 shape)', () => {
    const data = extractToolData(
      writePart({ status: 'completed', input: { filePath: 'src/a.ts', content: 'x' }, metadata: { filepath: 'src/b.ts' } }),
    )
    expect(data.filePath).toBe('src/b.ts')
  })

  it('falls back to input.filePath when no metadata/path (v1 shape)', () => {
    const data = extractToolData(
      writePart({ status: 'completed', input: { filePath: 'src/a.ts', content: 'x' }, metadata: {} }),
    )
    expect(data.filePath).toBe('src/a.ts')
  })
})
