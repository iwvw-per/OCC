import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectDialog } from './ProjectDialog'
import { inferRepoName, isLikelyGitUrl } from './gitCloneUrl'
import { getPath, listDirectory } from '../../api'

const { isTauriMock, isTauriMobileMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  isTauriMobileMock: vi.fn(() => false),
}))

vi.mock('../../utils/tauri', () => ({
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
}))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock('../../api', () => ({
  getPath: vi.fn().mockResolvedValue({ home: '/workspace/project' }),
  listDirectory: vi.fn().mockResolvedValue([
    { name: '.config', type: 'directory', absolute: '/workspace/project/.config' },
    { name: 'src', type: 'directory', absolute: '/workspace/project/src' },
    { name: 'docs', type: 'directory', absolute: '/workspace/project/docs' },
  ]),
}))

describe('ProjectDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    isTauriMock.mockReturnValue(false)
    isTauriMobileMock.mockReturnValue(false)
  })

  it('initializes from path api and loads directory entries', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByDisplayValue('/workspace/project/')).toBeInTheDocument()
    expect(await screen.findByText('.config')).toBeInTheDocument()
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(await screen.findByText('docs')).toBeInTheDocument()

    expect(screen.getByText('Add current')).toBeInTheDocument()
  })

  it('reloads the same directory when reopened', async () => {
    const { rerender } = render(<ProjectDialog key="first" isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByText('src')).toBeInTheDocument()

    rerender(<ProjectDialog key="closed" isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} />)
    rerender(<ProjectDialog key="second" isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => expect(vi.mocked(getPath).mock.calls.length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(vi.mocked(listDirectory).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  it('offers the system folder picker for a local server on desktop', async () => {
    isTauriMock.mockReturnValue(true)
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} serverId="local" />)
    expect(await screen.findByText('System folder')).toBeInTheDocument()
  })

  it('offers the system folder picker for a remote server on desktop', async () => {
    // 云端/远程服务器是多数用户的主场景：若按「焦点服务器必须是本机」门控，
    // 系统选择器按钮永远不会出现，用户无法从资源管理器挑目录。
    isTauriMock.mockReturnValue(true)
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} serverId="aiagent:inst_remote" />)
    expect(await screen.findByText('System folder')).toBeInTheDocument()
  })

  it('hides the system folder picker outside the desktop client', async () => {
    isTauriMock.mockReturnValue(false)
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} serverId="local" />)
    expect(await screen.findByText('Add current')).toBeInTheDocument()
    expect(screen.queryByText('System folder')).toBeNull()
  })
})

describe('git clone helpers', () => {
  it('infers the repo name from common URL shapes', () => {
    expect(inferRepoName('https://github.com/user/repo.git')).toBe('repo')
    expect(inferRepoName('https://github.com/user/repo/')).toBe('repo')
    expect(inferRepoName('git@github.com:org/my-repo.git')).toBe('my-repo')
    expect(inferRepoName('ssh://git@host:22/team/proj.git')).toBe('proj')
    expect(inferRepoName('')).toBe('')
  })

  it('accepts http(s), ssh, git and scp-style URLs only', () => {
    expect(isLikelyGitUrl('https://github.com/u/r.git')).toBe(true)
    expect(isLikelyGitUrl('http://host/r')).toBe(true)
    expect(isLikelyGitUrl('ssh://git@host/r.git')).toBe(true)
    expect(isLikelyGitUrl('git://host/r.git')).toBe(true)
    expect(isLikelyGitUrl('git@github.com:org/r.git')).toBe(true)
    expect(isLikelyGitUrl('not a url')).toBe(false)
    expect(isLikelyGitUrl('')).toBe(false)
  })
})
