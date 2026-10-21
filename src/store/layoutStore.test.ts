import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LayoutStore } from './layoutStore'

const STORAGE_KEY_PANEL_LAYOUT = 'opencode-panel-layout'
describe('LayoutStore panel and terminal layout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('persists global panel layout without persisting terminal tabs', () => {
    const store = new LayoutStore()

    store.addMcpTab('bottom')
    store.addTerminalTab({ id: 'term-1', title: 'Terminal 1', status: 'connected' }, true, 'right')
    store.openRightPanel('changes')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY_PANEL_LAYOUT) ?? 'null')

    expect(persisted).toMatchObject({
      version: 1,
      rightPanelOpen: true,
      bottomPanelOpen: true,
    })
    expect(persisted.panelTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'files', type: 'files', position: 'right' }),
        expect.objectContaining({ id: 'changes', type: 'changes', position: 'right' }),
        expect.objectContaining({ id: 'mcp', type: 'mcp', position: 'bottom' }),
      ]),
    )
    expect(persisted.panelTabs.some((tab: { id: string }) => tab.id === 'term-1')).toBe(false)

    const restored = new LayoutStore().getState()
    expect(restored.rightPanelOpen).toBe(true)
    expect(restored.bottomPanelOpen).toBe(true)
    expect(restored.panelTabs.some(tab => tab.id === 'mcp' && tab.position === 'bottom')).toBe(true)
    expect(restored.panelTabs.some(tab => tab.id === 'term-1')).toBe(false)
  })

  it('does not let a sync pull re-open the mobile sidebar', () => {
    // 回归：移动端侧栏是 overlay 手势翻页的临时状态，关掉后同步拉取读到持久化的
    // true 会把它重新弹开（表现为「关掉后随同步重复出现」）。
    // 关键：持久化值必须是 true，否则重读是空操作，测不出问题。
    localStorage.setItem('opencode-sidebar-expanded', 'true')
    const store = new LayoutStore()
    expect(store.getState().sidebarExpanded).toBe(true)

    store.setSidebarExpandedTransient(false) // 手机上滑走侧栏
    expect(store.getState().sidebarExpanded).toBe(false)

    // 同步拉取触发重读：不得用持久化的 true 覆盖移动端的临时收起状态
    store.reloadFromStorage()
    expect(store.getState().sidebarExpanded).toBe(false)
  })

  it('does not write the sync key when toggling the mobile sidebar', () => {
    const store = new LayoutStore()
    store.setSidebarExpanded(true)
    const persisted = localStorage.getItem('opencode-sidebar-expanded')

    store.setSidebarExpandedTransient(false)
    // 持久化值不变（移动端开合不落盘、不同步）
    expect(localStorage.getItem('opencode-sidebar-expanded')).toBe(persisted)
    expect(store.getState().sidebarExpanded).toBe(false)
  })

  it('persists the expanded project keys for cross-device sync', () => {
    const store = new LayoutStore()
    // 存储键是 `主机::项目名`：裸名会让两台主机上的同名项目共用一份状态
    store.setSidebarExpandedProjects(['local::API-Monitor', 'local::OpenCodeUI'])

    expect(JSON.parse(localStorage.getItem('opencode-sidebar-expanded-projects') ?? 'null')).toEqual([
      'local::API-Monitor',
      'local::OpenCodeUI',
    ])
    // 重建后恢复
    expect(new LayoutStore().getState().sidebarExpandedProjects).toEqual([
      'local::API-Monitor',
      'local::OpenCodeUI',
    ])
  })

  it('migrates legacy bare project names to the active host', () => {
    // 旧版本只存裸名；升级后归给当前活动主机，否则已有展开状态全部失效
    localStorage.setItem('opencode-sidebar-expanded-projects', JSON.stringify(['HS10162']))

    const store = new LayoutStore()

    expect(store.getState().sidebarExpandedProjects).toEqual(['local::HS10162'])
    // 迁移结果要落盘，避免每次读取都重新推断
    expect(JSON.parse(localStorage.getItem('opencode-sidebar-expanded-projects') ?? 'null')).toEqual([
      'local::HS10162',
    ])
  })

  it('does not let the same project name on another host share expand state', () => {
    const store = new LayoutStore()
    // 笔电主机展开了 OCC；工作机上的同名项目不应受影响
    store.setSidebarExpandedProjects(['aiagent:inst_laptop::OCC'])

    const expanded = store.getState().sidebarExpandedProjects
    expect(expanded).toContain('aiagent:inst_laptop::OCC')
    expect(expanded).not.toContain('aiagent:inst_work::OCC')
  })

  it('picks up expanded project keys written externally (sync pull)', () => {
    const store = new LayoutStore()
    expect(store.getState().sidebarExpandedProjects).toEqual([])

    localStorage.setItem('opencode-sidebar-expanded-projects', JSON.stringify(['local::HS10162']))
    store.reloadFromStorage()

    expect(store.getState().sidebarExpandedProjects).toEqual(['local::HS10162'])
  })

  it('reveals a changed file in the changes tab and clears it after consumption', () => {
    const store = new LayoutStore()
    // 先关闭右侧面板，验证 reveal 会把它打开
    store.closeRightPanel()

    store.revealChangesFile('src/foo.ts', 'right')

    const state = store.getState()
    expect(state.rightPanelOpen).toBe(true)
    const changesTab = state.panelTabs.find(t => t.type === 'changes' && t.position === 'right')
    expect(changesTab?.revealFile).toBe('src/foo.ts')
    // 定位后该 tab 成为活动 tab
    expect(state.activeTabId.right).toBe(changesTab?.id)

    store.consumeRevealFile(changesTab!.id)
    const after = store.getState().panelTabs.find(t => t.id === changesTab!.id)
    expect(after?.revealFile).toBeNull()
  })

  it('does not persist the transient revealFile field', () => {
    const store = new LayoutStore()
    store.revealChangesFile('src/foo.ts', 'right')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY_PANEL_LAYOUT) ?? 'null')
    const persistedChanges = persisted.panelTabs.find((t: { type: string }) => t.type === 'changes')
    expect(persistedChanges?.revealFile).toBeUndefined()
  })

  it('keeps bottom and right panels open when syncing a directory with no terminal sessions', () => {
    const store = new LayoutStore()

    store.openBottomPanel()
    store.openRightPanel('files')
    store.syncTerminalSessions('dir-a', [])

    expect(store.getState().bottomPanelOpen).toBe(true)
    expect(store.getState().rightPanelOpen).toBe(true)
    expect(store.getTerminalTabs('bottom')).toEqual([])
    expect(store.getTerminalTabs('right')).toEqual([])
  })

  it('restores terminal positions for each directory when switching between projects', () => {
    const store = new LayoutStore()

    store.syncTerminalSessions('dir-a', [
      { id: 'term-a1', title: 'A1', status: 'connected' },
      { id: 'term-a2', title: 'A2', status: 'connected' },
    ])
    store.moveTab('term-a2', 'right')

    store.syncTerminalSessions('dir-b', [{ id: 'term-b1', title: 'B1', status: 'connected' }])
    store.syncTerminalSessions('dir-a', [
      { id: 'term-a1', title: 'A1', status: 'connected' },
      { id: 'term-a2', title: 'A2', status: 'connected' },
    ])

    expect(store.getTerminalTabs('bottom').map(tab => tab.id)).toEqual(['term-a1'])
    expect(store.getTerminalTabs('right').map(tab => tab.id)).toEqual(['term-a2'])
  })

  it('removes project terminal tabs when syncing global terminal sessions', () => {
    const store = new LayoutStore()

    store.syncTerminalSessions('dir-a', [{ id: 'term-a1', title: 'A1', status: 'connected' }])
    store.syncTerminalSessions(undefined, [])

    expect(store.getTerminalTabs('bottom')).toEqual([])
    expect(store.getState().panelTabs.some(tab => tab.id === 'term-a1')).toBe(false)
  })

  it('does not notify when a terminal snapshot is unchanged', () => {
    const store = new LayoutStore()
    store.syncTerminalSessions('dir-a', [{ id: 'term-a1', title: 'A1', status: 'connected' }])
    const snapshot = { buffer: 'pwd\r\n/workspace\r\n', scrollY: 2, cursor: 18, rows: 24, cols: 80 }

    store.updateTerminalSnapshot('term-a1', snapshot)
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.updateTerminalSnapshot('term-a1', snapshot)

    unsubscribe()
    expect(notifications).toBe(0)
  })

  it('falls back to a valid right tab when a stale terminal active id disappears after sync', () => {
    const store = new LayoutStore()

    store.syncTerminalSessions('dir-a', [{ id: 'term-a1', title: 'A1', status: 'connected' }])
    store.moveTab('term-a1', 'right')
    store.setActiveTab('right', 'term-a1')

    store.syncTerminalSessions('dir-b', [])

    expect(store.getState().activeTabId.right).toBe('files')
  })

  it('persists terminal snapshots and restores them on the next sync', () => {
    const store = new LayoutStore()

    store.syncTerminalSessions('dir-a', [{ id: 'term-a1', title: 'A1', status: 'connected' }])
    store.updateTerminalSnapshot('term-a1', {
      buffer: 'pwd\r\n/workspace\r\n',
      scrollY: 2,
      cursor: 18,
      rows: 24,
      cols: 80,
    })

    const persisted = JSON.parse(localStorage.getItem('opencode-terminal-layout') ?? 'null')
    expect(persisted.directories['dir-a'].sessions['term-a1']).toMatchObject({
      buffer: 'pwd\r\n/workspace\r\n',
      scrollY: 2,
      cursor: 18,
      rows: 24,
      cols: 80,
    })

    const restored = new LayoutStore()
    restored.syncTerminalSessions('dir-a', [{ id: 'term-a1', title: 'A1', status: 'connected' }])

    expect(restored.getState().panelTabs.find(tab => tab.id === 'term-a1')).toMatchObject({
      buffer: 'pwd\r\n/workspace\r\n',
      scrollY: 2,
      cursor: 18,
      rows: 24,
      cols: 80,
    })
  })

  it('persists terminal clipboard interaction preferences', () => {
    const store = new LayoutStore()

    store.setTerminalCopyOnSelect(true)
    store.setTerminalRightClickPaste(true)

    expect(localStorage.getItem('opencode-terminal-copy-on-select')).toBe('true')
    expect(localStorage.getItem('opencode-terminal-right-click-paste')).toBe('true')

    const restored = new LayoutStore().getState()
    expect(restored.terminalCopyOnSelect).toBe(true)
    expect(restored.terminalRightClickPaste).toBe(true)
  })
})

describe('LayoutStore backup import', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('updates the singleton in-memory state and notifies subscribers on import', async () => {
    const { layoutStore, importLayoutBackup, exportLayoutBackup } = await import('./layoutStore')

    // 前置状态：与备份相反
    layoutStore.setSidebarExpanded(true)
    layoutStore.setSendOnEnter(true)
    layoutStore.setRightPanelWidth(300)

    let notifications = 0
    const unsubscribe = layoutStore.subscribe(() => {
      notifications += 1
    })

    importLayoutBackup({
      sidebarExpanded: false,
      sidebarFolderRecents: true,
      sidebarFolderRecentsShowDiff: false,
      sidebarChildSessions: 'all',
      sidebarProjectSortField: 'created',
      sidebarProjectSortDesc: false,
      sendOnEnter: false,
      wakeLock: true,
      rightPanelWidth: 640,
      bottomPanelHeight: 320,
      sidebarWidth: 280,
    })

    // 内存状态（UI + 再次导出读的是它）必须同步更新
    expect(layoutStore.getState().sidebarExpanded).toBe(false)
    expect(layoutStore.getState().sidebarFolderRecents).toBe(true)
    expect(layoutStore.getState().sidebarChildSessions).toBe('all')
    expect(layoutStore.getState().sidebarProjectSortField).toBe('created')
    expect(layoutStore.getState().sidebarProjectSortDesc).toBe(false)
    expect(layoutStore.getState().sendOnEnter).toBe(false)
    expect(layoutStore.getState().wakeLock).toBe(true)
    expect(layoutStore.getState().rightPanelWidth).toBe(640)
    expect(layoutStore.getState().bottomPanelHeight).toBe(320)
    expect(notifications).toBeGreaterThan(0)

    // 导入后立即导出必须反映导入值，而不是旧内存状态
    const exported = exportLayoutBackup()
    expect(exported.sidebarExpanded).toBe(false)
    expect(exported.sendOnEnter).toBe(false)
    expect(exported.rightPanelWidth).toBe(640)
    expect(exported.sidebarWidth).toBe(280)

    unsubscribe()
  })

  it('keeps existing terminal tabs when importing a panel layout', async () => {
    const { layoutStore, importLayoutBackup } = await import('./layoutStore')

    layoutStore.syncTerminalSessions('dir-a', [{ id: 'term-1', title: 'T1', status: 'connected' }])
    layoutStore.setActiveTab('bottom', 'term-1')

    importLayoutBackup({ sidebarExpanded: true })

    expect(layoutStore.getState().panelTabs.some(tab => tab.id === 'term-1')).toBe(true)
    expect(layoutStore.getState().activeTabId.bottom).toBe('term-1')
  })
})

describe('LayoutStore reloadFromStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('picks up a project sort preference written by an external writer', () => {
    // 回归：排序等偏好由偏好同步引擎从外部写入 localStorage，
    // store 只在构造时读一次，不重读就会停在旧值 —— 表现为「另一台改了排序，
    // 这边要切换主机才生效」。
    const store = new LayoutStore()
    expect(store.getState().sidebarProjectSortField).toBe('updated')

    localStorage.setItem('opencode-sidebar-project-sort', JSON.stringify({ field: 'created', desc: false }))
    store.reloadFromStorage()

    expect(store.getState().sidebarProjectSortField).toBe('created')
    expect(store.getState().sidebarProjectSortDesc).toBe(false)
  })
  it('picks up sidebar toggles written externally', () => {
    const store = new LayoutStore()
    store.setSidebarFolderRecents(false)

    localStorage.setItem('opencode-sidebar-folder-recents', 'true')
    store.reloadFromStorage()

    expect(store.getState().sidebarFolderRecents).toBe(true)
  })

  it('persists and restores the project sort field and direction', () => {
    const store = new LayoutStore()
    expect(store.getState().sidebarProjectSortField).toBe('updated')
    expect(store.getState().sidebarProjectSortDesc).toBe(true)

    store.setSidebarProjectSort('created', false)
    expect(localStorage.getItem('opencode-sidebar-project-sort')).toBe(
      JSON.stringify({ field: 'created', desc: false }),
    )

    const restored = new LayoutStore()
    expect(restored.getState().sidebarProjectSortField).toBe('created')
    expect(restored.getState().sidebarProjectSortDesc).toBe(false)
  })

  it('notifies subscribers only when something actually changed', () => {
    const store = new LayoutStore()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.reloadFromStorage()
    expect(notified).toBe(0)

    localStorage.setItem('opencode-sidebar-show-child-sessions', 'all')
    store.reloadFromStorage()
    expect(notified).toBe(1)
  })
})
