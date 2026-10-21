import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsInlineButton, SettingsRow } from './SettingsRow'

describe('SettingsRow', () => {
  it('renders title, description and trailing control', () => {
    render(
      <SettingsRow title="自动批准" description="所有工具调用直接执行">
        <button type="button">开关</button>
      </SettingsRow>,
    )

    expect(screen.getByText('自动批准')).toBeInTheDocument()
    expect(screen.getByText('所有工具调用直接执行')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开关' })).toBeInTheDocument()
  })

  it('omits the control container when no children', () => {
    const { container } = render(<SettingsRow title="仅标题" />)
    expect(container.firstElementChild?.children).toHaveLength(1)
  })
})

describe('SettingsInlineButton', () => {
  it('applies size and tone classes and forwards props', () => {
    render(
      <SettingsInlineButton size="xs" tone="danger" disabled>
        删除
      </SettingsInlineButton>,
    )
    const button = screen.getByRole('button', { name: '删除' })
    expect(button).toBeDisabled()
    expect(button.className).toContain('h-6')
    expect(button.className).toContain('text-danger-100')
  })
})
