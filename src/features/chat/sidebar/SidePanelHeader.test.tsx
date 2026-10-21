import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

/**
 * 网页端与桌面端的侧栏顶栏必须共用同一套控件。
 *
 * 用户报的是「网页端左上角按钮样式和桌面端不一致」。根因是两端各写了一套：
 * 桌面端（Windows 全高侧栏）用 DesktopNavControls 的一排 IconButton，网页端
 * 用的是「折叠按钮 + Logo 文字」的独立 header。两边各自演进，尺寸/间距/hover
 * 自然分叉。
 *
 * 这里锁定：传入 headerContent 时默认 header（Logo 文字）不再渲染。
 */

const directoryStub = {
  currentDirectory: undefined,
  setCurrentDirectory: vi.fn(),
  removeDirectory: vi.fn(),
  reorderDirectories: vi.fn(),
  savedDirectories: [],
  pathInfo: null,
  recentProjects: {},
}

vi.mock('../../../hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../hooks')>()
  return {
    ...actual,
    useDirectory: () => directoryStub,
    useServerStore: () => ({
      servers: [{ id: 'local', name: 'Local', url: 'http://127.0.0.1:4096' }],
      activeServer: { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096' },
    }),
    useGitWorkspaceCatalog: () => new Map(),
    useMissingDirectories: () => new Set<string>(),
  }
})

vi.mock('../../../hooks/useServerStore', () => ({
  useServerStore: () => ({
    servers: [{ id: 'local', name: 'Local', url: 'http://127.0.0.1:4096' }],
    activeServer: { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096' },
  }),
}))

vi.mock('./SidebarFooter', () => ({ SidebarFooter: () => null }))
vi.mock('./FolderRecentList', () => ({ FolderRecentList: () => null }))
vi.mock('./HostQuickSwitcher', () => ({ HostQuickSwitcher: () => null }))
vi.mock('./useProjectGroups', () => ({
  useProjectGroups: () => ({
    folderProjects: [],
    savedDirectoryPaths: [],
    hiddenProjectPaths: [],
    hideProjectDirectory: vi.fn(),
    unhideProjectDirectory: vi.fn(),
    sortedFolderProjects: [],
    currentProject: { id: 'local', worktree: '', name: '', canReorder: false },
    expandedProjectIds: [],
    setExpandedProjectIds: vi.fn(),
    allProjectsCollapsed: true,
    workspaceDirectoriesByProjectId: new Map(),
    projectLastUsedAt: {},
  }),
}))
vi.mock('../../../contexts/useSessionContext', () => ({
  useSessionContext: () => ({
    sessions: [],
    isLoading: false,
    refreshSessions: vi.fn(),
    getSession: vi.fn(),
  }),
}))

vi.mock('../../../store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../store')>()
  return {
    ...actual,
    layoutStore: { ...actual.layoutStore, setSidebarExpandedProjects: vi.fn(), openRightPanel: vi.fn() },
    useLayoutStore: () => ({
      sidebarChildSessions: 'off',
      sidebarFolderRecents: false,
      sidebarFolderRecentsShowDiff: false,
      sidebarProjectSortField: 'updated',
      sidebarProjectSortDesc: true,
    }),
  }
})

const { SidePanel } = await import('./SidePanel')
const { DesktopNavControls } = await import('../../../components/DesktopNavControls')

const baseProps = {
  onNewSession: () => {},
  onSelectSession: () => {},
  selectedSessionId: null,
  onAddProject: () => {},
  onToggleSidebar: () => {},
}

describe('SidePanel header', () => {
  it('replaces the default header (logo text) when headerContent is provided', () => {
    const { container, queryByText } = render(
      <SidePanel
        {...baseProps}
        isMobile={false}
        isExpanded
        headerContent={<DesktopNavControls sidebarOpen onToggleSidebar={() => {}} />}
      />,
    )

    // 默认 header 的 Logo 文字必须消失，否则会出现「图标行 + Logo 行」两套顶栏
    expect(queryByText('OpenCode')).toBeNull()
    // 导航控件已渲染：IconButton 存在
    expect(container.querySelector('[data-icon-button]')).not.toBeNull()
  })

  it('keeps the default header when no headerContent is given', () => {
    const { container } = render(<SidePanel {...baseProps} isMobile={false} isExpanded />)
    // 默认 header 含 Logo 链接（href="#/"）；自定义 header 用导航控件替换后它不该存在
    expect(container.querySelector('a[href="#/"]')).not.toBeNull()
  })

  it('draws a divider under the custom header', () => {
    // 顶栏与下方内容之间必须有分割线：用户反馈换成导航控件后分割线消失
    const { container } = render(
      <SidePanel
        {...baseProps}
        isMobile={false}
        isExpanded
        headerContent={<span>nav</span>}
      />,
    )
    const header = container.querySelector('[data-sidebar] > div')
    expect(header?.className).toContain('border-b')
  })
})
