import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServersSettings } from './ServersSettings'

const { useServerStoreMock, restoreWorkspaceMock, clearSessionMock } = vi.hoisted(() => ({
  useServerStoreMock: vi.fn(),
  restoreWorkspaceMock: vi.fn(),
  clearSessionMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      typeof values?.latency === 'number' ? `${key} ${values.latency}` : key,
  }),
}))

vi.mock('../../../hooks', () => ({
  useServerStore: useServerStoreMock,
  useRouter: () => ({ restoreWorkspace: restoreWorkspaceMock, sessionId: 'session-1', directory: '/foo' }),
}))

vi.mock('../../../store', () => ({
  messageStore: { clearSession: clearSessionMock },
}))

const localServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096', isDefault: true }
const remoteServer = { id: 'remote', name: 'Remote', url: 'http://remote.test' }

describe('ServersSettings', () => {
  const checkHealthMock = vi.fn()
  const setActiveServerMock = vi.fn()

  beforeEach(() => {
    checkHealthMock.mockReset()
    setActiveServerMock.mockReset()
    restoreWorkspaceMock.mockReset()
    clearSessionMock.mockReset()
    useServerStoreMock.mockReturnValue({
      servers: [localServer, remoteServer],
      activeServer: localServer,
      addServer: vi.fn(),
      removeServer: vi.fn(),
      updateServer: vi.fn(),
      setActiveServer: setActiveServerMock,
      checkHealth: checkHealthMock,
      checkAllHealth: vi.fn(),
      getHealth: vi.fn(() => null),
    })
  })

  it('switches servers even when health verification fails', async () => {
    checkHealthMock.mockResolvedValueOnce({ status: 'error', error: 'Not an OpenCode server' })

    render(<ServersSettings />)

    fireEvent.click(screen.getByRole('button', { name: /Remote/ }))

    await waitFor(() => {
      expect(checkHealthMock).toHaveBeenCalledWith('remote')
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('remote')
    expect(restoreWorkspaceMock).toHaveBeenCalledWith('remote', null, '/foo')
    expect(clearSessionMock).toHaveBeenCalledWith('session-1')
  })
})
