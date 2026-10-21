import { describe, expect, it } from 'vitest'
import { resolveSavedProjectPaths } from './useProjectGroups'

describe('resolveSavedProjectPaths', () => {
  it('matches a saved directory through memberDirectories', () => {
    const project = {
      id: '/work/OCC',
      worktree: '/work/OCC',
      memberDirectories: ['/work/OCC', '/work/OCC/sub'],
    }
    expect(resolveSavedProjectPaths(project, ['/work/OCC/sub', '/work/OCC'])).toEqual(['/work/OCC/sub', '/work/OCC'])
  })

  it('resolves a derived project whose worktree is saved (the "cannot remove" case)', () => {
    // 服务器当前 worktree 推导出来的项目没有 memberDirectories，
    // 但它对应的目录其实已经在已保存列表里 —— 点移除必须能删掉
    const derived = { id: '/opt/api-monitor-agent', worktree: '/opt/api-monitor-agent', isDerived: true }
    expect(resolveSavedProjectPaths(derived, ['/opt/api-monitor-agent'])).toEqual(['/opt/api-monitor-agent'])
  })

  it('normalizes separators and trailing slashes', () => {
    const project = { id: '/opt/api-monitor-agent', worktree: '/opt/api-monitor-agent' }
    expect(resolveSavedProjectPaths(project, ['/opt/api-monitor-agent/'])).toEqual(['/opt/api-monitor-agent/'])
  })

  it('returns nothing when the project was never saved', () => {
    const derived = { id: '/tmp/unsaved', worktree: '/tmp/unsaved', isDerived: true }
    expect(resolveSavedProjectPaths(derived, ['/opt/api-monitor-agent'])).toEqual([])
  })

  it('does not treat a workspace directory as a saved match by accident', () => {
    const project = { id: '/work/a', worktree: '/work/a', workspaceDirectories: ['/work/a'] }
    expect(resolveSavedProjectPaths(project, ['/work/b'])).toEqual([])
  })
})
