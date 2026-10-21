import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlashTrigger } from './useSlashTrigger'

function setup(initialText: string) {
  const textarea = { current: document.createElement('textarea') } as { current: HTMLTextAreaElement | null }
  let text = initialText
  let attachments: unknown[] = []
  const onCommand = vi.fn(async () => true)
  const submitCommandOptimistically = vi.fn()
  const hook = renderHook(() =>
    useSlashTrigger({
      text,
      setText: next => {
        text = next
      },
      setAttachments: updater => {
        attachments = updater(attachments as never)
      },
      textareaRef: textarea,
      onCommand,
      submitCommandOptimistically,
    }),
  )
  return { hook, getText: () => text, getAttachments: () => attachments, onCommand, submitCommandOptimistically }
}

describe('useSlashTrigger', () => {
  it('replaces the query with the command and adds a command attachment', () => {
    const { hook, getText, getAttachments } = setup('/rev')
    act(() => hook.result.current.updateQuery('rev'))
    act(() => hook.result.current.updateQuery('rev', 0))

    act(() => hook.result.current.select({ name: 'review', source: 'api' } as never))

    expect(getText()).toBe('/review ')
    expect(getAttachments()).toHaveLength(1)
    expect(hook.result.current.open).toBe(false)
  })

  it('executes frontend commands without touching the text', () => {
    const { hook, getText, submitCommandOptimistically } = setup('/new')
    act(() => hook.result.current.select({ name: 'new', source: 'frontend' } as never))

    expect(submitCommandOptimistically).toHaveBeenCalledWith('/new')
    expect(getText()).toBe('/new')
  })
})
