import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const savedDirectoriesMock = vi.hoisted(() => [
  { path: 'E:/dev/OpenCodeUI', name: 'OpenCodeUI', addedAt: 1 },
  { path: 'E:/dev/api-monitor', name: 'API-Monitor', addedAt: 2 },
])

vi.mock('../../../contexts/useDirectory', () => ({
  useDirectory: () => ({
    currentDirectory: 'E:/dev/OpenCodeUI',
    savedDirectories: savedDirectoriesMock,
    addDirectory: vi.fn(),
    registerDirectory: vi.fn(),
    removeDirectory: vi.fn(),
    reorderDirectories: vi.fn(),
    setCurrentDirectory: vi.fn(),
    pathInfo: null,
    sidebarExpanded: false,
    setSidebarExpanded: vi.fn(),
    recentProjects: {},
  }),
}))

import { WelcomeHero, WelcomeProjectPill } from './WelcomeHero'

describe('WelcomeHero', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a non-empty greeting when active', () => {
    const { container } = render(<WelcomeHero active />)
    expect(container.querySelector('h1')?.textContent?.trim().length).toBeGreaterThan(0)
  })

  it('renders nothing when inactive after exit delay', () => {
    const { container } = render(<WelcomeHero active={false} />)
    expect(container.querySelector('h1')).toBeNull()
  })
})

describe('WelcomeProjectPill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the current project name from the directory', () => {
    render(
      <WelcomeProjectPill
        active
        directory="E:/dev/OpenCodeUI"
        onSelectProject={vi.fn()}
        onClearProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /switch project/i })).toBeInTheDocument()
    expect(screen.getByText('OpenCodeUI')).toBeInTheDocument()
  })

  it('falls back to "no project" when no directory is selected', () => {
    render(
      <WelcomeProjectPill
        active
        directory=""
        onSelectProject={vi.fn()}
        onClearProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    )

    expect(screen.getByText('No project')).toBeInTheDocument()
  })
})
