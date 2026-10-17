import { describe, expect, it } from 'vitest'
import type { GitWorkspaceMeta } from '../../../hooks'
import { getProjectGroupIdentity, sortProjects, mergeProjectLastUsed } from './projectGrouping'

const gitMeta: GitWorkspaceMeta = {
  isGit: true,
  rootDirectory: '/workspace/project-root',
  workspaces: ['/workspace/project-root', '/workspace/project-worktree'],
}

describe('getProjectGroupIdentity', () => {
  it('keeps a saved git subdirectory as its own project path', () => {
    expect(getProjectGroupIdentity('/workspace/project-root/subdir-a/subdir-b', gitMeta)).toEqual({
      projectId: '/workspace/project-root/subdir-a/subdir-b',
      workspaceDirectories: undefined,
    })
  })

  it('groups actual git workspace roots by git root', () => {
    expect(getProjectGroupIdentity('/workspace/project-worktree', gitMeta)).toEqual({
      projectId: '/workspace/project-root',
      workspaceDirectories: ['/workspace/project-root', '/workspace/project-worktree'],
    })
  })

  it('does not group into a git root that no longer exists on disk', () => {
    // 仓库整体迁移后，服务端仍返回旧 worktree（磁盘上已不存在），
    // 新目录只出现在 sandboxes 里。此时必须以新目录自身为身份，
    // 否则新项目会被挂进旧项目行、新建对话沿用旧目录。
    const movedMeta: GitWorkspaceMeta = {
      isGit: true,
      rootDirectory: '/opt/komidash',
      workspaces: ['/opt/komidash', '/opt/code/komidash'],
      rootExists: false,
    }
    expect(getProjectGroupIdentity('/opt/code/komidash', movedMeta)).toEqual({
      projectId: '/opt/code/komidash',
      workspaceDirectories: undefined,
    })
  })

  it('keeps grouping when the git root still exists', () => {
    const liveMeta: GitWorkspaceMeta = { ...gitMeta, rootExists: true }
    expect(getProjectGroupIdentity('/workspace/project-worktree', liveMeta)).toEqual({
      projectId: '/workspace/project-root',
      workspaceDirectories: ['/workspace/project-root', '/workspace/project-worktree'],
    })
  })
})

describe('sortProjects', () => {
  const projects = [
    { name: 'Beta', worktree: 'C:/beta', addedAt: 3 },
    { name: 'Alpha', worktree: 'C:/alpha', addedAt: 1 },
    { name: 'Gamma', worktree: 'C:/gamma', addedAt: 2 },
  ]

  it('sorts by last used time desc when field is updated', () => {
    const result = sortProjects(
      projects,
      'updated',
      { 'C:/alpha': 100, 'C:/beta': 300, 'C:/gamma': 200 },
      true,
    )
    expect(result.map(p => p.name)).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('sorts ascending when desc is false', () => {
    const result = sortProjects(
      projects,
      'updated',
      { 'C:/alpha': 100, 'C:/beta': 300, 'C:/gamma': 200 },
      false,
    )
    expect(result.map(p => p.name)).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('sorts by stable addedAt, ignoring last used, when field is created', () => {
    // last used 的顺序与 addedAt 相反，用来证明 created 不看活动时间
    const result = sortProjects(
      projects,
      'created',
      { 'C:/alpha': 999, 'C:/beta': 1, 'C:/gamma': 500 },
      true,
    )
    expect(result.map(p => p.name)).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('is stable under session activity when field is created', () => {
    const before = sortProjects(projects, 'created', {}, true)
    const after = sortProjects(projects, 'created', { 'C:/alpha': Date.now() }, true)
    expect(after.map(p => p.name)).toEqual(before.map(p => p.name))
  })

  it('falls back to name for equal timestamps', () => {
    const noTime = projects.map(p => ({ ...p, addedAt: 0 }))
    const result = sortProjects(noTime, 'created', {}, true)
    expect(result.map(p => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('does not mutate the input array', () => {
    const input = [...projects]
    sortProjects(input, 'updated', { 'C:/alpha': 100 }, true)
    expect(input.map(p => p.name)).toEqual(['Beta', 'Alpha', 'Gamma'])
  })
})

describe('mergeProjectLastUsed', () => {
  it('lets the activity anchor override the server time.updated', () => {
    // 服务端 time.updated 被 assistant 流式抬得比锚点高，但排序必须认锚点
    const merged = mergeProjectLastUsed(
      ['C:/alpha', 'C:/beta'],
      {},
      { 'C:/alpha': 999, 'C:/beta': 100 },
      worktree => (worktree === 'C:/alpha' ? 500 : 800),
    )
    expect(merged['C:/alpha']).toBe(500)
    expect(merged['C:/beta']).toBe(800)
  })

  it('falls back to the server time when no anchor exists', () => {
    const merged = mergeProjectLastUsed(['C:/alpha'], {}, { 'C:/alpha': 100 }, () => undefined)
    expect(merged['C:/alpha']).toBe(100)
  })

  it('keeps the anchor stable across streaming bumps of time.updated', () => {
    const pair = [
      { name: 'Alpha', worktree: 'C:/alpha' },
      { name: 'Beta', worktree: 'C:/beta' },
    ]
    const getAnchor = (worktree: string) => (worktree === 'C:/alpha' ? 500 : 400)
    const first = mergeProjectLastUsed(['C:/alpha', 'C:/beta'], {}, { 'C:/alpha': 600, 'C:/beta': 100 }, getAnchor)
    const second = mergeProjectLastUsed(['C:/alpha', 'C:/beta'], {}, { 'C:/alpha': 600, 'C:/beta': 900 }, getAnchor)
    // 即便 time.updated 来回超越，锚点稳定，项目顺序不变
    expect(sortProjects(pair, 'updated', first, true).map(p => p.name)).toEqual(
      sortProjects(pair, 'updated', second, true).map(p => p.name),
    )
  })
})
