import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionChangesPanel } from './SessionChangesPanel'
import { changeScopeStore } from '../store/changeScopeStore'
import { layoutStore } from '../store/layoutStore'
import { FullscreenProvider } from '../contexts'

const { getCurrentProject, initGitProject, getSessionDiff, getLastTurnDiff, getVcsInfo, getVcsDiff, listDirectory } =
  vi.hoisted(() => ({
    getCurrentProject: vi.fn(),
    initGitProject: vi.fn(),
    getSessionDiff: vi.fn(),
    getLastTurnDiff: vi.fn(),
    getVcsInfo: vi.fn(),
    getVcsDiff: vi.fn(),
    listDirectory: vi.fn(),
  }))

vi.mock('../api/client', () => ({
  getCurrentProject,
  initGitProject,
}))

vi.mock('../api/vcs', () => ({
  getVcsInfo,
  getVcsDiff,
}))

vi.mock('../api/session', () => ({
  getSessionDiff,
  getLastTurnDiff,
}))

vi.mock('../api/file', () => ({
  listDirectory,
}))

vi.mock('./DiffViewer', () => ({
  DiffViewer: () => <div data-testid="diff-viewer">diff viewer</div>,
  useDiffViewerData: () => ({
    beforeTokens: null,
    afterTokens: null,
    pairedLines: [],
    unifiedLines: [],
    lineNumberWidth: 1,
  }),
}))

/**
 * 切换到指定范围。
 *
 * 默认范围是 Git 变更（见 changeScopeStore.DEFAULT_CHANGE_SCOPE_MODE），
 * 需要验证其它范围的用例必须显式切换 —— 依赖默认值会让用例随默认值改动而
 * 静默失效。
 */
async function switchScope(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))
  await act(async () => {
    vi.advanceTimersByTime(48)
    await Promise.resolve()
  })
  fireEvent.click(screen.getByText(name))
  await act(async () => {
    vi.advanceTimersByTime(240)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderSessionChangesPanel() {
  return render(
    <FullscreenProvider>
      <SessionChangesPanel sessionId="session-1" directory="/repo" />
    </FullscreenProvider>,
  )
}

describe('SessionChangesPanel', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    getCurrentProject.mockResolvedValue({
      id: 'project-1',
      worktree: '/repo',
      vcs: 'git',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })
    getVcsInfo.mockResolvedValue({
      branch: 'feature/test',
      default_branch: 'main',
    })
    getVcsDiff.mockImplementation(async mode => {
      if (mode === 'branch') {
        return [
          {
            file: 'src/branch.ts',
            before: 'const branch = 1',
            after: 'const branch = 2',
            additions: 1,
            deletions: 1,
          },
        ]
      }

      return [
        {
          file: 'src/git.ts',
          before: 'const git = 1',
          after: 'const git = 2',
          additions: 1,
          deletions: 1,
        },
      ]
    })
    getSessionDiff.mockResolvedValue([
      {
        file: 'src/app.ts',
        before: 'const a = 1',
        after: 'const a = 2',
        additions: 1,
        deletions: 1,
      },
      {
        file: 'src/components/Button.tsx',
        before: 'export const Button = 1',
        after: 'export const Button = 2',
        additions: 1,
        deletions: 1,
      },
    ])
    getLastTurnDiff.mockResolvedValue([
      {
        file: 'src/turn.ts',
        before: 'const turn = 1',
        after: 'const turn = 2',
        additions: 1,
        deletions: 1,
      },
    ])
    initGitProject.mockResolvedValue({
      id: 'project-1',
      worktree: '/repo',
      vcs: 'git',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })
    listDirectory.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * 默认范围是 Git 变更，不是「上一轮变更」。
   *
   * 用户反馈：面板叫「变更」，第一反应是「仓库现在有什么改动」。而 turn 为空时
   * 显示「本轮无变更」，容易被误读成「什么都没改」（实测踩过：那一轮助手没动
   * 文件，但工作区有 92 个改动）。
   */
  it('defaults to Git changes and loads working-tree diffs', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getVcsDiff).toHaveBeenCalledWith('git', '/repo', undefined)
    expect(screen.getByRole('button', { name: /Change mode: Git changes/ })).toBeInTheDocument()
    expect(screen.getAllByText('git.ts').length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
  })

  it('shows last turn diffs after switching to that scope', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    await switchScope('Last turn changes')

    expect(getLastTurnDiff).toHaveBeenCalledWith('session-1', '/repo', undefined)
    expect(screen.getByText('1f')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Change mode: Last turn changes/ })).toBeInTheDocument()
    expect(screen.getAllByText('turn.ts').length).toBeGreaterThan(0)
  })
  it('switches to session changes on demand', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Session changes'))

    await act(async () => {
      vi.advanceTimersByTime(240)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getSessionDiff).toHaveBeenCalledWith('session-1', '/repo', undefined)
    expect(changeScopeStore.getMode('session-1')).toBe('session')
    expect(screen.getByText('2f')).toBeInTheDocument()
    expect(screen.getAllByText('app.ts').length).toBeGreaterThan(0)
  })

  it('passes serverId in the 3rd argument slot when loading session diffs', async () => {
    // 回归：getSessionDiff 的第 3 参曾是 messageId，调用方传 serverId 会被当成
    // messageID 发给服务端，导致 session 模式恒为空。这里用真实 serverId 锁死顺序。
    render(
      <FullscreenProvider>
        <SessionChangesPanel sessionId="session-1" directory="/repo" serverId="srv-remote" />
      </FullscreenProvider>,
    )

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Session changes'))

    await act(async () => {
      vi.advanceTimersByTime(240)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getSessionDiff).toHaveBeenCalledWith('session-1', '/repo', 'srv-remote')
  })

  it('switches to branch changes when available', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Branch changes'))

    await act(async () => {
      vi.advanceTimersByTime(240)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getVcsDiff).toHaveBeenCalledWith('branch', '/repo', undefined)
    expect(changeScopeStore.getMode('session-1')).toBe('branch')
    expect(screen.getAllByText('branch.ts').length).toBeGreaterThan(0)
  })

  it('supports keyboard navigation in the change mode menu and exposes toggle state', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    const menu = screen.getByRole('menu', { name: 'Change mode' })
    const lastTurnOption = screen.getByRole('menuitemradio', { name: 'Last turn changes' })
    const gitChangesOption = screen.getByRole('menuitemradio', { name: 'Git changes' })

    // 打开菜单时焦点落在「当前选中项」（默认是 Git 变更）
    expect(gitChangesOption).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    // 菜单顺序是 turn → git → branch → session，从 git 往下是 branch
    expect(screen.getByRole('menuitemradio', { name: 'Branch changes' })).toHaveFocus()
    expect(lastTurnOption).toBeInTheDocument()

    // 列表/视图切换现为 Radix Tabs（role="tab" + aria-selected），
    // 取代原先手写按钮的 aria-pressed。
    const treeTab = screen.getByRole('tab', { name: 'Tree' })
    const listTab = screen.getByRole('tab', { name: 'List' })
    const unifiedTab = screen.getByRole('tab', { name: 'Unified' })
    const splitTab = screen.getByRole('tab', { name: 'Split' })

    expect(treeTab).toHaveAttribute('aria-selected', 'true')
    expect(unifiedTab).toHaveAttribute('aria-selected', 'true')

    // Radix Tabs 在 mouseDown 上激活。
    fireEvent.mouseDown(listTab)
    fireEvent.mouseDown(splitTab)

    expect(listTab).toHaveAttribute('aria-selected', 'true')
    expect(treeTab).toHaveAttribute('aria-selected', 'false')
    expect(splitTab).toHaveAttribute('aria-selected', 'true')
    expect(unifiedTab).toHaveAttribute('aria-selected', 'false')
  })

  it('opens the change mode menu from ArrowUp with focus on the last option', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.keyDown(screen.getByRole('button', { name: /Change mode:/ }), { key: 'ArrowUp' })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('menuitemradio', { name: 'Session changes' })).toHaveFocus()
  })

  it('offers git initialization when the project is not a git repository', async () => {
    getCurrentProject.mockResolvedValueOnce({
      id: 'global',
      worktree: '/repo',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })

    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git repository' }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(initGitProject).toHaveBeenCalledWith('/repo', undefined)
    expect(getLastTurnDiff).toHaveBeenCalledWith('session-1', '/repo', undefined)
  })

  it('lists workspace files instead of blocking when the project is not a git repository', async () => {
    getCurrentProject.mockResolvedValue({
      id: 'global',
      worktree: '/repo',
      time: { created: 0, updated: 0 },
      sandboxes: [],
    })
    listDirectory.mockResolvedValue([
      { name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false },
      { name: 'README.md', path: 'README.md', absolute: '/repo/README.md', type: 'file', ignored: false },
    ])

    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listDirectory).toHaveBeenCalledWith('', '/repo', undefined)
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
    // 仍保留初始化入口
    expect(screen.getByRole('button', { name: 'Initialize Git repository' })).toBeInTheDocument()
  })

  it('opens the selected change file in the files panel from the context menu', async () => {
    const openFilePreview = vi.spyOn(layoutStore, 'openFilePreview')

    render(
      <FullscreenProvider>
        <SessionChangesPanel sessionId="session-1" directory="/repo" position="bottom" />
      </FullscreenProvider>,
    )

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 该用例验证的是右键菜单本身，与范围无关；turn.ts 来自 last-turn 数据，
    // 因此先切到该范围（默认已是 Git 变更）
    await switchScope('Last turn changes')

    const fileButtons = screen.getAllByRole('button', { name: /turn\.ts/ })
    fireEvent.contextMenu(fileButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }))

    expect(openFilePreview).toHaveBeenCalledWith({ path: 'src/turn.ts', name: 'turn.ts' }, 'bottom')
  })
})
