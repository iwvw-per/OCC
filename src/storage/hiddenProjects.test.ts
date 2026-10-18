import { beforeEach, describe, expect, it } from 'vitest'
import {
  hiddenProjectsStore,
  hideProject,
  rebindAppData,
  resetAppDataBindingForTests,
  unhideProject,
} from './appData'

/** 模拟「刷新页面」：重新绑定，强制从存储重读（不经过内存快照）。 */
function simulateReload() {
  rebindAppData('__reload__')
  rebindAppData('local')
}

const STORAGE_KEY = 'srv:local:opencode-hidden-projects'

describe('hidden projects', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAppDataBindingForTests()
  })

  it('hides a directory persistently (survives a reload)', () => {
    hideProject('/opt/api-monitor-agent')

    expect(hiddenProjectsStore.get()).toEqual(['/opt/api-monitor-agent'])
    // 真正写入存储，而不只是内存状态
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['/opt/api-monitor-agent'])

    simulateReload()
    expect(hiddenProjectsStore.get()).toEqual(['/opt/api-monitor-agent'])
  })

  it('is idempotent and normalizes separators', () => {
    hideProject('/opt/api-monitor-agent')
    hideProject('/opt/api-monitor-agent')
    hideProject('/opt\\api-monitor-agent')
    // 反斜杠归一成正斜杠后视为同一项
    expect(hiddenProjectsStore.get()).toEqual(['/opt/api-monitor-agent'])
  })

  it('unhides on demand and clears the storage entry when empty', () => {
    hideProject('/a')
    hideProject('/b')
    unhideProject('/a')

    expect(hiddenProjectsStore.get()).toEqual(['/b'])
    unhideProject('/b')
    expect(hiddenProjectsStore.get()).toEqual([])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([])
  })

  it('ignores empty input', () => {
    hideProject('')
    expect(hiddenProjectsStore.get()).toEqual([])
  })

  it('drops junk entries when reading persisted data', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['/ok', 42, null, '  ']))
    simulateReload()
    expect(hiddenProjectsStore.get()).toEqual(['/ok'])
  })
})
