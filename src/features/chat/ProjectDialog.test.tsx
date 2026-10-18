import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('keeps a trailing slash when going up a level', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    const input = await screen.findByDisplayValue('/workspace/project/')
    fireEvent.click(screen.getByText('.. (Parent)'))

    // 少了尾斜杠会被当作过滤词，列表看起来是空的
    await waitFor(() => expect(input).toHaveValue('/workspace/'))
    expect(vi.mocked(listDirectory)).toHaveBeenLastCalledWith('/workspace/', undefined, undefined)
  })

  it('goes up one level by trimming the absolute path', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/opt/code/OCC/" />)

    const input = await screen.findByDisplayValue('/opt/code/OCC/')
    fireEvent.click(screen.getByText('.. (Parent)'))

    // 直接砍掉一级，不做任何补全
    await waitFor(() => expect(input).toHaveValue('/opt/code/'))
    expect(vi.mocked(listDirectory)).toHaveBeenLastCalledWith('/opt/code/', undefined, undefined)
  })

  it('stops at the filesystem root when going up', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/opt/" />)

    const input = await screen.findByDisplayValue('/opt/')
    fireEvent.click(screen.getByText('.. (Parent)'))

    await waitFor(() => expect(input).toHaveValue('/'))
  })

  it('rejects relative input without rewriting it', async () => {
    const onSelect = vi.fn()
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={onSelect} initialPath="/opt/code/" />)

    const input = await screen.findByDisplayValue('/opt/code/')
    fireEvent.change(input, { target: { value: '../code/' } })

    expect(await screen.findByTestId('relative-path-hint')).toBeInTheDocument()

    // 不猜、不补全：原样保留，交给用户改成绝对路径
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(input).toHaveValue('../code/')
  })

  it('leaves a relative path untouched when going up', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/opt/code/" />)

    const input = await screen.findByDisplayValue('/opt/code/')
    fireEvent.change(input, { target: { value: '../code/' } })
    fireEvent.click(screen.getByText('.. (Parent)'))

    // 返回上级不猜相对路径：原样保留，绝不变成 `/code/`
    expect(input).toHaveValue('../code/')
  })

  it('opens at home when the initial path is relative', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="../code/OCC" />)

    await waitFor(() => expect(screen.getByDisplayValue('/workspace/project/')).toBeInTheDocument())
  })

  it('ignores a late async init after the user already navigated', async () => {
    // getPath 很慢：初始化还没回来，用户已经手动改了路径
    let resolvePath: (v: { home: string }) => void = () => {}
    vi.mocked(getPath).mockImplementationOnce(
      () =>
        new Promise<{ home: string }>(r => {
          resolvePath = r
        }) as never,
    )

    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/opt/code/OCC/" />)
    const input = document.querySelector('input') as HTMLInputElement
    await waitFor(() => expect(input).not.toBeNull())

    fireEvent.change(input, { target: { value: '/opt/' } })
    expect(input).toHaveValue('/opt/')

    // 迟到的 home 不能覆盖用户输入
    resolvePath({ home: '/workspace/project' })
    await waitFor(() => expect(input).toHaveValue('/opt/'))
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
