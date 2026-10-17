import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../../../contexts/SessionNavigationContext'
import { TaskHeader, TaskBody } from './TaskRenderer'
import type { ToolPart } from '../../../../types/message'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key.startsWith('agent.') ? (options?.defaultValue ?? key) : key,
  }),
}))

vi.mock('../../../../store', () => ({
  useSessionState: () => null,
  messageStore: {
    getSessionState: () => undefined,
    setLoadState: vi.fn(),
    setMessages: vi.fn(),
  },
  childSessionStore: {
    getSessionInfo: () => undefined,
  },
}))

vi.mock('../../../../api', () => ({
  getSessionMessages: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../../../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    onServerChange: () => () => {},
    subscribe: () => () => {},
  },
}))

vi.mock('../../../../utils', () => ({
  sessionErrorHandler: vi.fn(),
  createErrorHandler: () => vi.fn(),
}))

vi.mock('../../../../components', () => ({
  ContentBlock: () => null,
}))

function renderHeader(options: { sessionId?: string; openSessionInSplit?: (sessionId: string, directory?: string) => boolean } = { sessionId: 'child-session' }) {
  const sessionId = options.sessionId
  const navigateToSession = vi.fn()
  const onToggle = vi.fn()

  render(
    <SessionNavigationContext.Provider
      value={{
        navigateToSession,
        openSessionInSplit: options.openSessionInSplit,
        currentSessionId: 'parent-session',
        currentDirectory: 'E:\\workspace',
      }}
    >
      <TaskHeader
        agentType="explore"
        description="Inspect the renderer"
        status="completed"
        expanded={false}
        onToggle={onToggle}
        sessionId={sessionId}
      />
    </SessionNavigationContext.Provider>,
  )

  return { navigateToSession, onToggle }
}

describe('TaskHeader', () => {
  it('opens the child session from the jump button', () => {
    const { navigateToSession, onToggle } = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('also opens the child session from the agent badge', () => {
    const { navigateToSession, onToggle } = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: 'explore' }))

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('uses the title row to toggle details', () => {
    const { navigateToSession, onToggle } = renderHeader()
    const rowButton = screen.getByRole('button', { name: /Inspect the renderer/ })

    fireEvent.click(rowButton)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(navigateToSession).not.toHaveBeenCalled()
  })

  it('hides the jump button until a child session exists', () => {
    const { onToggle } = renderHeader({ sessionId: undefined })

    expect(screen.queryByRole('button', { name: 'task.openSession' })).not.toBeInTheDocument()
    expect(screen.getByText('explore').tagName).toBe('SPAN')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('prefers opening in split view when the pane handler accepts', () => {
    const openSessionInSplit = vi.fn(() => true)
    const { navigateToSession } = renderHeader({ sessionId: 'child-session', openSessionInSplit })

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(openSessionInSplit).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(navigateToSession).not.toHaveBeenCalled()
  })

  it('falls back to in-pane navigation when split is unavailable', () => {
    const openSessionInSplit = vi.fn(() => false)
    const { navigateToSession } = renderHeader({ sessionId: 'child-session', openSessionInSplit })

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(openSessionInSplit).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
  })
})

describe('TaskBody prompt visibility', () => {
  function createTaskPart(metadata: Record<string, unknown> | undefined): ToolPart {
    return {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'completed',
        title: 'explore',
        input: { prompt: 'FIND THE UNREAD LOGIC' },
        output: 'result',
        metadata,
        time: { start: 1, end: 2 },
      },
    }
  }

  function renderBody(metadata: Record<string, unknown> | undefined) {
    return render(
      <SessionNavigationContext.Provider
        value={{ navigateToSession: vi.fn(), currentSessionId: 'parent-session', currentDirectory: 'E:\\workspace' }}
      >
        <TaskBody part={createTaskPart(metadata)} />
      </SessionNavigationContext.Provider>,
    )
  }

  it('hides the prompt outside when a child session exists (shown inside the box instead)', () => {
    renderBody({ sessionId: 'child-session' })
    expect(screen.queryByText('FIND THE UNREAD LOGIC')).not.toBeInTheDocument()
  })

  it('falls back to showing the prompt when there is no child session', () => {
    renderBody(undefined)
    expect(screen.getByText('FIND THE UNREAD LOGIC')).toBeInTheDocument()
  })
})
