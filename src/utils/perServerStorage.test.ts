import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('per-server storage change notification', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('notifies subscribers on serverStorage writes', async () => {
    const { serverStorage, subscribePerServerStorageVersion } = await import('./perServerStorage')

    const calls: number[] = []
    const unsubscribe = subscribePerServerStorageVersion(() => calls.push(1))

    serverStorage.set('opencode-saved-directories', '[]', 'aiagent:inst_1')
    expect(calls.length).toBe(1)

    serverStorage.setJSON('opencode-recent-projects', {}, 'aiagent:inst_1')
    expect(calls.length).toBe(2)

    unsubscribe()
    serverStorage.set('opencode-saved-directories', '[1]', 'aiagent:inst_1')
    expect(calls.length).toBe(2)
  })

  it('notifies subscribers on external (direct localStorage) writes', async () => {
    // 偏好同步引擎为了保留原始字符串直接写 localStorage，绕过 serverStorage。
    // 没有这条显式通知，React 状态不会重读，界面停在初始化快照上。
    const { subscribePerServerStorageVersion, notifyPerServerStorageChanged } = await import('./perServerStorage')

    let reads = 0
    const unsubscribe = subscribePerServerStorageVersion(() => {
      reads += 1
    })

    localStorage.setItem('srv:local:opencode-saved-directories', '[{"path":"/a"}]')
    expect(reads).toBe(0) // 直接写 localStorage 不触发

    notifyPerServerStorageChanged()
    expect(reads).toBe(1)

    unsubscribe()
    notifyPerServerStorageChanged()
    expect(reads).toBe(1)
  })

  it('exposes a monotonic version for useSyncExternalStore snapshots', async () => {
    const { getStorageVersion, serverStorage, notifyPerServerStorageChanged } = await import('./perServerStorage')

    const before = getStorageVersion()
    serverStorage.set('opencode-saved-directories', '[]', 'aiagent:inst_1')
    const afterWrite = getStorageVersion()
    expect(afterWrite).toBeGreaterThan(before)

    notifyPerServerStorageChanged()
    expect(getStorageVersion()).toBeGreaterThan(afterWrite)
  })

  it('keeps per-server keys isolated by serverId', async () => {
    const { serverStorage } = await import('./perServerStorage')

    serverStorage.setFor('opencode-saved-directories', '[{"path":"D:/work"}]', 'aiagent:inst_work')
    serverStorage.setFor('opencode-saved-directories', '[{"path":"E:/laptop"}]', 'aiagent:inst_laptop')

    expect(serverStorage.getFor('opencode-saved-directories', 'aiagent:inst_work')).toContain('D:/work')
    expect(serverStorage.getFor('opencode-saved-directories', 'aiagent:inst_laptop')).toContain('E:/laptop')
  })
})
