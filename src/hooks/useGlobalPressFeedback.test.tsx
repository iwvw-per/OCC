import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useGlobalPressFeedback } from './useGlobalPressFeedback'

/**
 * jsdom 没有 PointerEvent,这里用普通 Event 补上 hook 需要的字段
 * (pointerType / clientX / clientY),足以覆盖判定逻辑。
 */
function firePointer(
  type: string,
  target: Element,
  init: { pointerType?: string; clientX?: number; clientY?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    pointerType: init.pointerType ?? 'touch',
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  })
  target.dispatchEvent(event)
  return event
}

describe('useGlobalPressFeedback', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('marks the pressed element on touch and clears it on pointerup', () => {
    renderHook(() => useGlobalPressFeedback(true))
    const button = document.createElement('button')
    document.body.appendChild(button)

    firePointer('pointerdown', button)
    expect(button.getAttribute('data-pressed')).toBe('true')

    firePointer('pointerup', button)
    expect(button.getAttribute('data-pressed')).toBeNull()
  })

  it('does nothing for mouse pointers', () => {
    renderHook(() => useGlobalPressFeedback(true))
    const button = document.createElement('button')
    document.body.appendChild(button)

    firePointer('pointerdown', button, { pointerType: 'mouse' })
    expect(button.getAttribute('data-pressed')).toBeNull()
  })

  it('clears the highlight once the finger moves past the scroll threshold', () => {
    renderHook(() => useGlobalPressFeedback(true))
    const button = document.createElement('button')
    document.body.appendChild(button)

    firePointer('pointerdown', button, { clientY: 0 })
    expect(button.getAttribute('data-pressed')).toBe('true')

    firePointer('pointermove', button, { clientY: 40 })
    expect(button.getAttribute('data-pressed')).toBeNull()
  })

  it('clears the highlight on scroll', () => {
    renderHook(() => useGlobalPressFeedback(true))
    const button = document.createElement('button')
    document.body.appendChild(button)

    firePointer('pointerdown', button)
    expect(button.getAttribute('data-pressed')).toBe('true')

    window.dispatchEvent(new Event('scroll'))
    expect(button.getAttribute('data-pressed')).toBeNull()
  })

  it('is inert when disabled', () => {
    renderHook(() => useGlobalPressFeedback(false))
    const button = document.createElement('button')
    document.body.appendChild(button)

    firePointer('pointerdown', button)
    expect(button.getAttribute('data-pressed')).toBeNull()
  })
})
