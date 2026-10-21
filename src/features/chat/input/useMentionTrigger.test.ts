import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMentionTrigger } from './useMentionTrigger'

function setup(initialText: string) {
  const textarea = { current: document.createElement('textarea') } as { current: HTMLTextAreaElement | null }
  let text = initialText
  const setText = vi.fn((next: string) => {
    text = next
  })
  const hook = renderHook(() => useMentionTrigger({ text, setText, textareaRef: textarea }))
  return { hook, getText: () => text, setText, textarea }
}

describe('useMentionTrigger', () => {
  it('inserts the selected mention and appends a space', () => {
    const { hook, setText } = setup('hello @src/ma')
    act(() => hook.result.current.setOpen(true))
    act(() => hook.result.current.updateQuery('src/ma'))
    act(() => hook.result.current.updateQuery('src/ma', 6))

    let inserted: string | null = null
    act(() => {
      inserted = hook.result.current.selectItem({
        type: 'file',
        relativePath: 'src/main.ts',
        displayName: 'main.ts',
      } as never)
    })

    expect(inserted).toBe('hello @src/main.ts ')
    expect(setText).toHaveBeenCalled()
    expect(hook.result.current.open).toBe(false)
  })

  it('expands a folder instead of inserting it', () => {
    const { hook, setText } = setup('@src')
    act(() => hook.result.current.updateQuery('src'))
    act(() => hook.result.current.updateQuery('src/', 0))

    let inserted: string | null = 'not-reset'
    act(() => {
      inserted = hook.result.current.selectItem({
        type: 'folder',
        _enterFolder: true,
        relativePath: 'src',
        displayName: 'src',
      } as never)
    })

    expect(inserted).toBeNull()
    expect(setText).toHaveBeenCalledWith('@src/')
  })

  it('does nothing when no trigger position is known', () => {
    const { hook, setText } = setup('plain text')
    let inserted: string | null = 'not-reset'
    act(() => {
      inserted = hook.result.current.selectItem({ type: 'file', relativePath: 'a.ts', displayName: 'a.ts' } as never)
    })
    expect(inserted).toBeNull()
    expect(setText).not.toHaveBeenCalled()
  })
})
