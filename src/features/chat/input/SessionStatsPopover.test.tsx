import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SessionStatsPopover } from './SessionStatsPopover'
import { formatTokenRate } from '../../../utils/formatUtils'
import type { SessionTurnStats } from '../../../hooks/useSessionTurnStats'
import '../../../i18n'

const baseStats: SessionTurnStats = {
  turns: 3,
  steps: 7,
  modelMs: 204_000,
  toolMs: 113_000,
  ttftMs: 1900,
  tokensPerSec: 285,
  outputTokens: 2900,
  cacheReadTokens: 800,
  inputTokens: 1000,
  cacheHitPercent: 80,
  hasData: true,
}

describe('formatTokenRate', () => {
  it('renders zero rate as 0 tok/s', () => {
    expect(formatTokenRate(0)).toBe('0 tok/s')
  })

  it('keeps one decimal below ten', () => {
    expect(formatTokenRate(2.34)).toBe('2.3 tok/s')
  })

  it('rounds at ten and above', () => {
    // 10 及以上取整；9.99 仍在「小于 10」分支，保留一位小数
    expect(formatTokenRate(9.99)).toBe('10.0 tok/s')
    expect(formatTokenRate(10)).toBe('10 tok/s')
    expect(formatTokenRate(285.4)).toBe('285 tok/s')
  })
})

describe('SessionStatsPopover', () => {
  it('shows the last turn rate on the trigger by default', () => {
    render(<SessionStatsPopover stats={baseStats} tokensPerSec={123.4} />)
    expect(screen.getByText('123 tok/s')).toBeInTheDocument()
    expect(screen.getByText('TPS')).toBeInTheDocument()
  })

  it('shows 0 tok/s on the trigger when there is no completed turn', () => {
    render(<SessionStatsPopover stats={baseStats} tokensPerSec={0} />)
    expect(screen.getByText('0 tok/s')).toBeInTheDocument()
  })

  it('renders configured multiple fields on the bottom trigger with labels', () => {
    render(
      <SessionStatsPopover
        stats={baseStats}
        tokensPerSec={123.4}
        displayFields={{
          modelTime: true,
          toolTime: true,
          ttft: true,
          tps: true,
          cacheHit: true,
          outputTokens: true,
        }}
      />,
    )

    // 各项标签存在（英文默认环境）
    expect(screen.getByText('TPS')).toBeInTheDocument()
    expect(screen.getByText('123 tok/s')).toBeInTheDocument()
    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('3m 24s')).toBeInTheDocument() // 204s = 3m 24s
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('1m 53s')).toBeInTheDocument() // 113s = 1m 53s
    expect(screen.getByText('TTFT')).toBeInTheDocument()
    expect(screen.getByText('1.9s')).toBeInTheDocument()
    expect(screen.getByText('Cache')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText('Out')).toBeInTheDocument()
    expect(screen.getByText('2.9k')).toBeInTheDocument()
  })

  it('falls back to title text when all metric fields are disabled', () => {
    render(
      <SessionStatsPopover
        stats={baseStats}
        tokensPerSec={123.4}
        displayFields={{
          modelTime: false,
          toolTime: false,
          ttft: false,
          tps: false,
          cacheHit: false,
          outputTokens: false,
        }}
      />,
    )

    expect(screen.getByText('Session statistics')).toBeInTheDocument()
    expect(screen.queryByText('123 tok/s')).not.toBeInTheDocument()
  })

  it('renders the trigger as a collapsed popover button', () => {
    render(<SessionStatsPopover stats={baseStats} tokensPerSec={123.4} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})
