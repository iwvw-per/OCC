import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputFooter } from './InputFooter'

// 只打桩数据来源，渲染与分支判断用真实实现
const useTodosMock = vi.fn()
const useTodoStatsMock = vi.fn()
const useCurrentTaskMock = vi.fn()
const useTokenRateMock = vi.fn()
const useIsMobileMock = vi.fn()

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => useIsMobileMock(),
}))

vi.mock('../../../store', async () => {
  const actual = await vi.importActual<typeof import('../../../store')>('../../../store')
  return {
    ...actual,
    useTodos: () => useTodosMock(),
    useTodoStats: () => useTodoStatsMock(),
    useCurrentTask: () => useCurrentTaskMock(),
  }
})

vi.mock('../../../hooks/useTokenRate', () => ({
  useTokenRate: (...args: unknown[]) => useTokenRateMock(...args),
}))

// 统计面板的数据来源：只测 footer 渲染时用空统计，避免真实 hook 去订阅 messageStore
vi.mock('../../../hooks/useSessionTurnStats', () => ({
  useSessionTurnStats: () => ({
    turns: 0,
    steps: 0,
    modelMs: 0,
    toolMs: 0,
    ttftMs: null,
    tokensPerSec: null,
    outputTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    cacheHitPercent: null,
    hasData: false,
  }),
}))

vi.mock('../../../api/session', () => ({
  getSessionTodos: vi.fn().mockResolvedValue([]),
}))

describe('InputFooter token rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTodosMock.mockReturnValue([])
    useTodoStatsMock.mockReturnValue({ completed: 0, total: 0 })
    useCurrentTaskMock.mockReturnValue(null)
    useTokenRateMock.mockReturnValue({ tokensPerSec: 0, hasData: false })
    useIsMobileMock.mockReturnValue(false)
  })

  it('shows the token rate when there are no todos', () => {
    useTodosMock.mockReturnValue([])
    useTokenRateMock.mockReturnValue({ tokensPerSec: 123.4, hasData: true })

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('123 tok/s')).toBeInTheDocument()
  })

  it('shows the token rate alongside the todo progress when todos exist', () => {
    useTodosMock.mockReturnValue([{ id: 'todo-1', content: 'Do a thing', status: 'in_progress' }])
    useTodoStatsMock.mockReturnValue({ completed: 1, total: 3 })
    useCurrentTaskMock.mockReturnValue({ id: 'todo-1', content: 'Do a thing', status: 'in_progress' })
    useTokenRateMock.mockReturnValue({ tokensPerSec: 42.6, hasData: true })

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('43 tok/s')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('does not render the todo progress block when there are no todos', () => {
    useTodosMock.mockReturnValue([])
    useTodoStatsMock.mockReturnValue({ completed: 0, total: 0 })
    useTokenRateMock.mockReturnValue({ tokensPerSec: 5, hasData: true })

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.queryByText('0/0')).not.toBeInTheDocument()
  })

  it('renders zero when there is no completed turn yet', () => {
    useTokenRateMock.mockReturnValue({ tokensPerSec: 0, hasData: false })

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('0 tok/s')).toBeInTheDocument()
  })

  it('formats rates below ten with one decimal', () => {
    useTokenRateMock.mockReturnValue({ tokensPerSec: 2.34, hasData: true })

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('2.3 tok/s')).toBeInTheDocument()
  })
})

describe('InputFooter 可配置字段', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTodosMock.mockReturnValue([{ id: 'todo-1', content: 'Do a thing', status: 'in_progress' }])
    useTodoStatsMock.mockReturnValue({ completed: 1, total: 3 })
    useCurrentTaskMock.mockReturnValue({ id: 'todo-1', content: 'Do a thing', status: 'in_progress' })
    useTokenRateMock.mockReturnValue({ tokensPerSec: 42.6, hasData: true })
    useIsMobileMock.mockReturnValue(false)
  })

  it('hides session stats when that field is off', () => {
    render(
      <InputFooter
        paneId="pane-1"
        sessionId="session-1"
        fields={{ autoApprove: true, sessionStats: false, taskProgress: true }}
      />,
    )

    expect(screen.queryByText('43 tok/s')).not.toBeInTheDocument()
    // 任务进度仍在
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('hides task progress when that field is off', () => {
    render(
      <InputFooter
        paneId="pane-1"
        sessionId="session-1"
        fields={{ autoApprove: true, sessionStats: true, taskProgress: false }}
      />,
    )

    expect(screen.getByText('43 tok/s')).toBeInTheDocument()
    expect(screen.queryByText('1/3')).not.toBeInTheDocument()
  })

  it('hides auto-approve when that field is off', () => {
    const { container } = render(
      <InputFooter
        paneId="pane-1"
        sessionId="session-1"
        fields={{ autoApprove: false, sessionStats: true, taskProgress: true }}
      />,
    )

    // 自动放行是唯一带 title 的三态按钮；关掉后不应再有该 title
    expect(container.querySelector('button[title*="auto"]')).toBeNull()
    expect(screen.getByText('43 tok/s')).toBeInTheDocument()
  })

  it('defaults to showing every field when no config is passed', () => {
    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('43 tok/s')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })
})

describe('InputFooter 移动端', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTodosMock.mockReturnValue([{ id: 'todo-1', content: 'Do a thing', status: 'in_progress' }])
    useTodoStatsMock.mockReturnValue({ completed: 1, total: 3 })
    useCurrentTaskMock.mockReturnValue({ id: 'todo-1', content: 'Do a thing', status: 'in_progress' })
    useTokenRateMock.mockReturnValue({ tokensPerSec: 42.6, hasData: true })
  })

  it('只显示进度与计数，不显示任务名（窄屏）', () => {
    useIsMobileMock.mockReturnValue(true)

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('1/3')).toBeInTheDocument()
    // 任务名不进 DOM：窄屏下它只会被截成几个字，既读不出信息又把 TPS 挤掉
    expect(screen.queryByText('Do a thing')).not.toBeInTheDocument()
    // 进度条本身仍在（「走到哪」）
    expect(screen.getByRole('button', { name: /1\/3/ })).toBeInTheDocument()
  })

  it('移动端仍显示 TPS', () => {
    useIsMobileMock.mockReturnValue(true)

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('43 tok/s')).toBeInTheDocument()
  })

  it('桌面端仍然显示任务名', () => {
    useIsMobileMock.mockReturnValue(false)

    render(<InputFooter paneId="pane-1" sessionId="session-1" />)

    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByText('Do a thing')).toBeInTheDocument()
  })
})
