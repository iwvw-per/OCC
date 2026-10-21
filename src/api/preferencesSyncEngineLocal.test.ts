import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'opencode-aiagent-account'
const SYNC_ENABLED_KEY = 'opencode-preferences-sync-enabled'

describe('preferences sync engine (instant local change)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /**
   * 准备环境：登录 + 启用同步 + 活动服务器是 aiagent 实例。
   *
   * 必须是 aiagent 实例：saved-directories 的实际键是
   * srv:aiagent:inst_X:...，而 srv:local:* 按设计不在同步白名单内
   * （local 是各端本机后端，路径异构）。
   */
  async function seedAccountAndEnable() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        domain: 'https://panel.example.com',
        username: 'salen',
        token: 'tok-local',
        loginAt: Date.now(),
      }),
    )
    localStorage.setItem(SYNC_ENABLED_KEY, '1')
    const { serverStore } = await import('../store/serverStore')
    serverStore.addServerWithId('aiagent:inst_work', {
      name: 'work',
      url: 'https://panel.example.com/api/aiagent/gw/inst_work',
    })
    serverStore.setActiveServer('aiagent:inst_work')
  }

  function stubFetch() {
    const stream = new ReadableStream<Uint8Array>({ start() {} })
    let putCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        putCount += 1
        return new Response(JSON.stringify({ success: true, data: { written: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/aiagent/preferences/events')) {
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, putCount: () => putCount }
  }

  /** 轮询等待条件成立，避免固定 sleep 在满载并行下过紧导致偶发失败。 */
  async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('uploads a local change without waiting for the 15s poll', async () => {
    // 回归：引擎原先只靠 15 秒轮询发现本地改动，端到端延迟最大的一段就在这里。
    await seedAccountAndEnable()
    const sse = stubFetch()

    const { startPreferencesSync, stopPreferencesSync } = await import('./preferencesSyncEngine')
    const { serverStorage } = await import('../utils/perServerStorage')

    await startPreferencesSync()
    await new Promise(resolve => setTimeout(resolve, 50))
    const before = sse.putCount()

    // 模拟「新建项目」：写入当前实例的 per-server 存储（触发变更通知）
    serverStorage.setJSON('opencode-saved-directories', [{ path: 'D:/Code/New', name: 'New', addedAt: 1 }], 'aiagent:inst_1')

    // 只需等 debounce（500ms）后上传发生，远小于 15 秒轮询
    await waitFor(() => sse.putCount() > before)

    expect(sse.putCount()).toBeGreaterThan(before)
    stopPreferencesSync()
  })

  it('coalesces several rapid local writes into one upload', async () => {
    await seedAccountAndEnable()
    const sse = stubFetch()

    const { startPreferencesSync, stopPreferencesSync } = await import('./preferencesSyncEngine')
    const { serverStorage } = await import('../utils/perServerStorage')

    await startPreferencesSync()
    await new Promise(resolve => setTimeout(resolve, 50))
    const before = sse.putCount()

    // 连续三次写入（如删一项 + 重排 + 改名）
    serverStorage.setJSON('opencode-saved-directories', [{ path: 'D:/Code/A', name: 'A', addedAt: 1 }], 'aiagent:inst_1')
    serverStorage.setJSON('opencode-saved-directories', [{ path: 'D:/Code/B', name: 'B', addedAt: 2 }], 'aiagent:inst_1')
    serverStorage.setJSON('opencode-saved-directories', [{ path: 'D:/Code/C', name: 'C', addedAt: 3 }], 'aiagent:inst_1')

    await waitFor(() => sse.putCount() > before)
    // 再等一小段确认没有多余的第 2 次上传（debounce 生效）
    await new Promise(resolve => setTimeout(resolve, 600))

    // debounce 应把它们合并：相对基线只多出 1 次上传
    expect(sse.putCount() - before).toBe(1)
    stopPreferencesSync()
  })

  it('stops reacting to local changes after stop', async () => {
    await seedAccountAndEnable()
    const sse = stubFetch()

    const { startPreferencesSync, stopPreferencesSync } = await import('./preferencesSyncEngine')
    const { serverStorage } = await import('../utils/perServerStorage')

    await startPreferencesSync()
    await new Promise(resolve => setTimeout(resolve, 50))
    stopPreferencesSync()

    const before = sse.putCount()
    serverStorage.setJSON('opencode-saved-directories', [{ path: 'D:/Code/After', name: 'After', addedAt: 9 }], 'aiagent:inst_1')
    await new Promise(resolve => setTimeout(resolve, 1500))

    expect(sse.putCount()).toBe(before)
  })
})
