import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SyncStatusIcon } from './SyncStatusRow'
import { syncStatusView, formatSyncedAt } from './syncStatus'
import type { SyncState } from '../../../api/preferencesSyncEngine'

const STORAGE_KEY = 'opencode-aiagent-account'
const SYNC_ENABLED_KEY = 'opencode-preferences-sync-enabled'

const NOW = Date.UTC(2026, 8, 22, 10, 0, 0)

describe('syncStatusView', () => {
  it('maps syncing to the loader state', () => {
    expect(syncStatusView({ status: 'syncing', lastSyncedAt: 0 }, NOW)).toEqual({
      kind: 'syncing',
      label: '正在同步…',
      title: '正在同步…',
    })
  })

  it('maps error to a failed state carrying the reason', () => {
    const view = syncStatusView({ status: 'error', lastSyncedAt: 0, error: 'boom' }, NOW)
    expect(view.kind).toBe('error')
    expect(view.label).toBe('同步失败')
    expect(view.title).toContain('boom')
  })

  it('maps a fresh sync to 已同步 · 刚刚', () => {
    const view = syncStatusView({ status: 'synced', lastSyncedAt: NOW - 5_000 }, NOW)
    expect(view.kind).toBe('synced')
    expect(view.label).toBe('已同步 · 刚刚')
  })

  it('maps an older sync to a relative time', () => {
    expect(formatSyncedAt(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatSyncedAt(NOW - 3 * 60 * 60_000, NOW)).toBe('3 小时前')
  })

  it('maps never-synced to 待同步', () => {
    const view = syncStatusView({ status: 'idle', lastSyncedAt: 0 }, NOW)
    expect(view.kind).toBe('synced')
    expect(view.label).toBe('待同步')
  })
})

describe('SyncStatusIcon', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  function seedLoggedInAndEnabled() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ domain: 'https://p.example.com', username: 'u', token: 't', loginAt: Date.now() }),
    )
    localStorage.setItem(SYNC_ENABLED_KEY, '1')
  }

  it('renders nothing when sync is disabled', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ domain: 'https://p.example.com', username: 'u', token: 't', loginAt: Date.now() }),
    )
    const { container } = render(<SyncStatusIcon />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when not logged in', () => {
    localStorage.setItem(SYNC_ENABLED_KEY, '1')
    const { container } = render(<SyncStatusIcon />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an icon-only indicator (no text node) when available', () => {
    seedLoggedInAndEnabled()
    const { container } = render(<SyncStatusIcon />)
    // 只保留图标：不应渲染文案
    expect(screen.queryByText(/待同步|已同步|正在同步/)).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeTruthy()
  })

  it('renders the synced state as a fully lit pixel grid, not a check mark', () => {
    seedLoggedInAndEnabled()
    const { container } = render(<SyncStatusIcon />)
    // 与「正在同步」同款九宫格几何，但静态全亮（不带动画类）
    const cells = container.querySelectorAll('.grid.grid-cols-3 > span')
    expect(cells).toHaveLength(9)
    cells.forEach(cell => expect(cell.className).not.toContain('loader-pixel-cell'))
  })

  it('uses the theme accent color for the synced grid', () => {
    // 成功态与同步中同属一个图标的两阶段，颜色应跟随主题强调色；
    // 曾用 success 语义色（绿），在紫色主题下与同步中的紫色不一致。
    seedLoggedInAndEnabled()
    const { container } = render(<SyncStatusIcon />)
    const glyph = container.querySelector('[role="status"] > span')
    expect(glyph?.className).toContain('text-accent-main-100')
    expect(glyph?.className).not.toContain('text-success-100')
  })

  it('exposes the status via aria-label and a self-drawn tooltip', () => {
    seedLoggedInAndEnabled()
    render(<SyncStatusIcon />)
    const node = screen.getByRole('status')
    expect(node.getAttribute('aria-label')).toBeTruthy()
    // 原生 title 已由自绘提示(HintTooltip)取代,不再挂在 DOM 上。
    expect(node.getAttribute('title')).toBeNull()
  })

  it('accepts a SyncState shape from the engine', () => {
    const state: SyncState = { status: 'synced', lastSyncedAt: Date.now() }
    expect(syncStatusView(state).kind).toBe('synced')
  })
})
