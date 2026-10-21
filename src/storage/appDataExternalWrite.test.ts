import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回归：外部写入（偏好同步引擎直写 localStorage）后，项目列表 store 必须重读。
 *
 * 用户报告：「同步成功了，但项目列表不变，必须手动刷新页面」。
 * 根因：createStore 只在自己的 commit 或跨标签页 storage 事件时更新快照；
 * 同步引擎为了保留原始字符串绕过它直接写 localStorage，只发了一个版本通知，
 * 而没有任何 store 订阅那个通知。于是数据已落盘、快照仍是启动时那份。
 */

const SAVED_KEY = 'srv:aiagent:inst_demo:opencode-saved-directories'

/** 切到 aiagent 实例桶：serverStore 在构造时读这两项 */
function seedActiveServer() {
  localStorage.setItem(
    'opencode-servers',
    JSON.stringify([
      { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096', isDefault: true },
      { id: 'aiagent:inst_demo', name: 'Demo', url: 'https://example.com/api/aiagent/gw/inst_demo' },
    ]),
  )
  localStorage.setItem('opencode-active-server', 'aiagent:inst_demo')
  sessionStorage.setItem('opencode-active-server', 'aiagent:inst_demo')
}

/**
 * 每个用例都用 resetModules 拿一份全新的 serverStore / appData。
 * 注意顺序：先把存储种好，再 import，store 才会绑定到 aiagent 桶。
 */
async function freshModules() {
  vi.resetModules()
  seedActiveServer()
  return {
    ...(await import('./appData')),
    ...(await import('../utils/perServerStorage')),
  }
}

/** 种数据必须在 import 之前：createStore 在构造时就读取当前桶。 */
async function freshWithDirectories(items: { path: string }[]) {
  seedDirectories(items)
  return freshModules()
}

function seedDirectories(items: { path: string }[]) {
  localStorage.setItem(
    SAVED_KEY,
    JSON.stringify(items.map((item, index) => ({ ...item, name: item.path, addedAt: index + 1 }))),
  )
}

describe('appData store follows external writes', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('re-reads the project list when the sync engine notifies a storage change', async () => {
    const { savedDirectoriesStore, notifyPerServerStorageChanged } = await freshWithDirectories([{ path: '/only/local' }])

    expect(savedDirectoriesStore.get().map(d => d.path)).toEqual(['/only/local'])

    // 模拟同步引擎：直接写 localStorage（保留原始字符串），再发版本通知
    seedDirectories([{ path: '/only/local' }, { path: '/from/other-device' }])
    notifyPerServerStorageChanged()

    expect(savedDirectoriesStore.get().map(d => d.path)).toEqual(['/only/local', '/from/other-device'])
  })

  it('notifies subscribers so the sidebar re-renders without a page reload', async () => {
    const { savedDirectoriesStore, notifyPerServerStorageChanged } = await freshWithDirectories([{ path: '/a' }])

    const listener = vi.fn()
    savedDirectoriesStore.subscribe(listener)

    seedDirectories([{ path: '/a' }, { path: '/b' }])
    notifyPerServerStorageChanged()

    expect(listener).toHaveBeenCalled()
  })

  it('does not notify when the external value is unchanged', async () => {
    const { savedDirectoriesStore, notifyPerServerStorageChanged } = await freshWithDirectories([{ path: '/a' }])

    const listener = vi.fn()
    savedDirectoriesStore.subscribe(listener)

    // 轮询期间内容没变：不应产生无谓重渲染
    notifyPerServerStorageChanged()
    expect(listener).not.toHaveBeenCalled()
  })

  it('reload() re-reads the current bucket explicitly', async () => {
    const { savedDirectoriesStore } = await freshWithDirectories([{ path: '/a' }])

    // 不发版本通知，仅调用 reload：用于拉取链路里不依赖间接通知
    seedDirectories([{ path: '/a' }, { path: '/direct' }])
    savedDirectoriesStore.reload()

    expect(savedDirectoriesStore.get().map(d => d.path)).toEqual(['/a', '/direct'])
  })
})
