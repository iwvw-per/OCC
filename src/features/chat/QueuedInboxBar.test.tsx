import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueuedInboxBar } from './QueuedInboxBar'

describe('QueuedInboxBar', () => {
  it('列出排队项,点取消回调 inbox id', () => {
    const onCancel = vi.fn()
    render(
      <QueuedInboxBar
        items={[
          { id: 'q1', text: 'hello', createdAt: 1 },
          { id: 'q2', text: '', createdAt: 2 },
        ]}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByText('hello')).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0])
    expect(onCancel).toHaveBeenCalledWith('q1')
  })

  it('空列表不渲染', () => {
    const { container } = render(<QueuedInboxBar items={[]} onCancel={vi.fn()} />)
    expect(container.querySelector('[data-queued-inbox]')).toBeNull()
  })
})
