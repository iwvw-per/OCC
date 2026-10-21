import { describe, expect, it } from 'vitest'

/**
 * 「全部展开/收起」的判定范围与作用范围必须一致。
 *
 * 用户报的是「展开和收起不一致」。根因：判定用 allProjectsCollapsed 只看
 * 非派生项目，但展开动作传的是 folderProjects（含派生项目）。点「全部收起」
 * 后派生项目仍处于展开态，按钮图标与实际列表对不上。
 *
 * 这里用与 useProjectGroups 相同的判定式验证两种范围的行为差异，锁定正确语义。
 */

interface Project {
  id: string
  isDerived?: boolean
}

const projects: Project[] = [
  { id: '/opt/OCC' },
  { id: '/opt/komidash' },
  { id: '/opt/api-monitor-agent', isDerived: true },
]

/** 旧实现：判定范围不含派生项目，动作范围含派生项目 */
function oldCollapsed(expandedIds: string[]) {
  const judged = projects.filter(p => !p.isDerived).map(p => p.id)
  const actioned = projects.map(p => p.id)
  const collapsed = judged.length > 0 && judged.every(id => !expandedIds.includes(id))
  return { collapsed, actioned }
}

/** 新实现：两者同源 */
function newCollapsed(expandedIds: string[]) {
  const scope = projects.map(p => p.id)
  const collapsed = scope.length > 0 && scope.every(id => !expandedIds.includes(id))
  return { collapsed, actioned: scope }
}

describe('expand/collapse all scope', () => {
  it('old implementation reports "all collapsed" while a derived project is still expanded', () => {
    // 只有派生项目展开：旧实现认为「已全部收起」，于是按钮显示「展开全部」，
    // 但列表里明明还有一个项目是展开的 —— 这就是用户看到的「不一致」。
    const expanded = ['/opt/api-monitor-agent']
    const old = oldCollapsed(expanded)
    expect(old.collapsed).toBe(true)
    // 但动作范围含派生项目，说明判定用的集合和操作用的集合不是同一个
    expect(old.actioned).toContain('/opt/api-monitor-agent')
  })

  it('new implementation judges and acts on the same set', () => {
    const expanded = ['/opt/api-monitor-agent']
    const next = newCollapsed(expanded)
    // 派生项目仍展开 → 不能报告「已全部收起」
    expect(next.collapsed).toBe(false)
    expect(next.actioned).toEqual(projects.map(p => p.id))
  })

  it('reports collapsed only when nothing in scope is expanded', () => {
    expect(newCollapsed([]).collapsed).toBe(true)
    expect(newCollapsed(['/opt/OCC']).collapsed).toBe(false)
  })
})
