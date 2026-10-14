import { describe, expect, it } from 'vitest'
import { compressMessageParts } from './turnCompression'
import type { Part, ToolPart } from '../types/message'

function base(id: string) {
  return { id, sessionID: 'ses-1', messageID: 'msg-1' }
}

function toolPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    ...base('prt-tool'),
    type: 'tool',
    callID: 'call-1',
    tool: 'edit',
    state: {
      status: 'completed',
      input: { filePath: 'src/app.ts' },
      output: 'x'.repeat(5000),
      title: 'edit src/app.ts',
      metadata: {
        filepath: 'src/app.ts',
        diff: 'unified diff body',
        filediff: { patch: 'patch body', before: 'a', after: 'b', additions: 3, deletions: 1 },
        files: [{ filePath: 'src/app.ts', diff: 'file diff', additions: 3, deletions: 1 }],
      },
      time: { start: 1, end: 2 },
    },
    ...overrides,
  }
}

function reasoningPart(id: string, text = 'thinking'): Part {
  return { ...base(id), type: 'reasoning', text, time: { start: 1, end: 2 } }
}

function textPart(id: string, text: string): Part {
  return { ...base(id), type: 'text', text }
}

describe('compressMessageParts', () => {
  it('drops reasoning parts and counts them', () => {
    const result = compressMessageParts([reasoningPart('r1'), reasoningPart('r2'), textPart('t1', 'answer')])
    expect(result.reasoningCount).toBe(2)
    expect(result.content.map(p => p.type)).toEqual(['text'])
  })

  it('strips heavy tool state fields while keeping file stats for changed-files', () => {
    const result = compressMessageParts([toolPart()])
    const part = result.content[0] as ToolPart
    expect(result.stepCount).toBe(1)

    const state = part.state as unknown as Record<string, unknown>
    expect(state.output).toBeUndefined()
    expect(state.title).toBe('edit src/app.ts')

    const metadata = state.metadata as Record<string, unknown>
    expect(metadata.diff).toBeUndefined()
    expect(metadata.filepath).toBe('src/app.ts')
    expect(metadata.filediff).toEqual({ additions: 3, deletions: 1 })
    expect(metadata.files).toEqual([{ filePath: 'src/app.ts', additions: 3, deletions: 1 }])
  })

  it('returns the original parts reference when nothing is compressible', () => {
    const parts = [textPart('t1', 'hello')]
    const result = compressMessageParts(parts)
    expect(result.content).toBe(parts)
    expect(result.reasoningCount).toBe(0)
    expect(result.stepCount).toBe(0)
  })
})
