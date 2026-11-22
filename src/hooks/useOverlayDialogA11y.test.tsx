import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { useOverlayDialogA11y } from './useOverlayDialogA11y'

function Harness({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayDialogA11y({ isOpen, onClose, containerRef: ref })
  return (
    <div ref={ref}>
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  )
}

afterEach(cleanup)

describe('useOverlayDialogA11y', () => {
  it('closes on Escape when open', () => {
    const onClose = vi.fn()
    render(<Harness isOpen onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while a nested modal dialog is open', () => {
    const onClose = vi.fn()
    render(<Harness isOpen onClose={onClose} />)

    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('aria-modal', 'true')
    nested.setAttribute('data-dialog-open', 'true')
    document.body.appendChild(nested)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    nested.remove()
  })

  it('wraps focus from the last element back to the first', () => {
    const onClose = vi.fn()
    const { container } = render(<Harness isOpen onClose={onClose} />)
    const buttons = container.querySelectorAll('button')

    buttons[buttons.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })

    expect(document.activeElement).toBe(buttons[0])
  })

  it('does not react when closed', () => {
    const onClose = vi.fn()
    render(<Harness isOpen={false} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
