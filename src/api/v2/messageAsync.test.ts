import { describe, expect, it } from 'vitest'
import { adaptMessagePage, adaptMessagePageAsync } from './message'

function v2User(id: string) {
  return { id, sessionID: 'ses-1', type: 'user', text: `hi ${id}`, time: { created: 1 } }
}

describe('adaptMessagePageAsync', () => {
  it('produces exactly the same result as the synchronous adapter', async () => {
    const raw = {
      data: [v2User('m1'), { id: 'c1', sessionID: 'ses-1', type: 'compaction', status: 'completed', time: { created: 9 } }, v2User('m2')],
      cursor: { next: 'next-1', previous: 'prev-1' },
    }

    const sync = adaptMessagePage(raw)
    const asyncResult = await adaptMessagePageAsync(raw)

    expect(asyncResult).toEqual(sync)
    expect(asyncResult.nextCursor).toBe('next-1')
    expect(asyncResult.compactedAt).toBe(9)
    expect(asyncResult.messages.map(m => m.info.id)).toEqual(['m1', 'm2'])
  })

  it('preserves order for large pages', async () => {
    const data = Array.from({ length: 300 }, (_, i) => v2User(`m${i}`))
    const result = await adaptMessagePageAsync({ data, cursor: {} })
    expect(result.messages.map(m => m.info.id)).toEqual(data.map(d => d.id))
  })
})
