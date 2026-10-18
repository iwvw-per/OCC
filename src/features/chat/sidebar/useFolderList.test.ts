import { describe, expect, it } from 'vitest'
import { reconcileExpandedProjectIds, toggleProjectId } from './useFolderList'

describe('reconcileExpandedProjectIds', () => {
  it('drops ids that no longer exist', () => {
    expect(reconcileExpandedProjectIds(['a', 'b'], [{ id: 'b' }])).toEqual(['b'])
  })

  it('keeps the same reference when nothing changed', () => {
    const prev = ['a', 'b']
    expect(reconcileExpandedProjectIds(prev, [{ id: 'a' }, { id: 'b' }])).toBe(prev)
  })

  it('does not auto-expand when every project is collapsed', () => {
    // 收起全部后 prev 为空，不能兜底展开第一个（否则收起操作永远失效）
    expect(reconcileExpandedProjectIds([], [{ id: 'a' }])).toEqual([])
  })
})

describe('toggleProjectId', () => {
  it('adds and removes ids', () => {
    expect(toggleProjectId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleProjectId(['a', 'b'], 'a')).toEqual(['b'])
  })
})
