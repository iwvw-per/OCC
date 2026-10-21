import { act, render } from '@testing-library/react'
import { useContext, useEffect, type ContextType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryContext } from './DirectoryContext.shared'
import { DirectoryProvider } from './DirectoryContext'
import { resetAppDataBindingForTests } from '../storage/appData'

const { buckets, serverChangeListeners, serverState, notifyListeners } = vi.hoisted(() => ({
  buckets: new Map<string, string>(),
  serverChangeListeners: [] as Array<(id: string, reason: string) => void>,
  serverState: { activeServerId: 'aiagent:inst_work' },
  notifyListeners: [] as Array<() => void>,
}))

function makeKey(key: string, serverId?: string) {
  return `srv:${serverId ?? serverState.activeServerId}:${key}`
}

vi.mock('../utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils')>()
  return {
    ...actual,
    serverStorage: {
      get: (key: string) => buckets.get(makeKey(key)) ?? null,
      getJSON: <T,>(key: string) => {
        const raw = buckets.get(makeKey(key))
        return raw ? (JSON.parse(raw) as T) : null
      },
      set: (key: string, value: string) => buckets.set(makeKey(key), value),
      setJSON: (key: string, value: unknown) => buckets.set(makeKey(key), JSON.stringify(value)),
      getFor: (key: string, serverId: string) => buckets.get(makeKey(key, serverId)) ?? null,
      getJSONFor: <T,>(key: string, serverId: string) => {
        const raw = buckets.get(makeKey(key, serverId))
        return raw ? (JSON.parse(raw) as T) : null
      },
      setFor: (key: string, value: string, serverId: string) => buckets.set(makeKey(key, serverId), value),
      setJSONFor: (key: string, value: unknown, serverId: string) =>
        buckets.set(makeKey(key, serverId), JSON.stringify(value)),
    },
    subscribePerServerStorageVersion: (fn: () => void) => {
      notifyListeners.push(fn)
      return () => {
        const i = notifyListeners.indexOf(fn)
        if (i >= 0) notifyListeners.splice(i, 1)
      }
    },
  }
})

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => serverState.activeServerId,
    getServerBaseUrl: () => 'http://127.0.0.1:4096',
    getActiveBaseUrl: () => 'http://127.0.0.1:4096',
    getServerAuth: () => undefined,
    getActiveAuth: () => undefined,
    getApiVersion: () => 'v2',
    onServerChange: (fn: (id: string, reason: string) => void) => {
      serverChangeListeners.push(fn)
      return () => {
        const i = serverChangeListeners.indexOf(fn)
        if (i >= 0) serverChangeListeners.splice(i, 1)
      }
    },
  },
  LOCAL_SERVER_ID: 'local',
}))

vi.mock('../store/layoutStore', () => ({
  layoutStore: {
    setSidebarExpanded: vi.fn(),
    subscribe: () => () => {},
    getState: () => ({ sidebarProjectSortField: 'updated', sidebarProjectSortDesc: true }),
  },
  useLayoutStore: () => ({ sidebarExpanded: true }),
}))

vi.mock('../store/multiServerStore', () => ({
  multiServerStore: { getFocusedServerId: () => serverState.activeServerId },
  useMultiServerStore: () => ({}),
}))

vi.mock('../hooks/useRouter', () => ({
  useRouter: () => ({
    directory: undefined,
    setDirectory: vi.fn(),
    navigateToSession: vi.fn(),
    replaceSession: vi.fn(),
  }),
}))

vi.mock('../utils/tauri', () => ({ isTauri: () => false }))

describe('rapid successive adds (stale closure / external write)', () => {
  let latest: ContextType<typeof DirectoryContext> = null

  function Probe() {
    const value = useContext(DirectoryContext)
    useEffect(() => {
      latest = value
    }, [value])
    return null
  }

  beforeEach(() => {
    localStorage.clear()
    resetAppDataBindingForTests()
    buckets.clear()
    serverChangeListeners.length = 0
    notifyListeners.length = 0
    serverState.activeServerId = 'aiagent:inst_work'
  })

  it('keeps both projects when added back-to-back in the same tick', async () => {
    // 连续两次新建（或一次操作触发多次写入）：若第二次基于过期的 savedDirectories
    // 计算，就会把第一次的结果覆盖掉。
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('D:/Code/First')
      latest?.addDirectory('D:/Code/Second')
    })

    expect(latest?.savedDirectories.map(d => d.path).sort()).toEqual(['D:/Code/First', 'D:/Code/Second'])
  })

  it('does not lose a local add when a storage notification arrives right after', async () => {
    // 本地刚写入 → 引擎/其它组件触发存储通知 → 若通知重读用了尚未落盘的状态，
    // 会把刚加的项目冲掉。
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('D:/Code/JustAdded')
    })
    expect(latest?.savedDirectories.map(d => d.path)).toContain('D:/Code/JustAdded')

    await act(async () => {
      notifyListeners.forEach(fn => fn())
    })

    expect(latest?.savedDirectories.map(d => d.path)).toContain('D:/Code/JustAdded')
  })

  it('survives a notification that fires while the add effect has not flushed yet', async () => {
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    // 同一 tick 内：先 add，再立刻通知（模拟同步引擎的即时上传链路）
    await act(async () => {
      latest?.addDirectory('D:/Code/RaceAdd')
      notifyListeners.forEach(fn => fn())
    })

    expect(latest?.savedDirectories.map(d => d.path)).toContain('D:/Code/RaceAdd')
    const raw =
      localStorage.getItem('srv:aiagent:inst_work:opencode-saved-directories') ??
      buckets.get('srv:aiagent:inst_work:opencode-saved-directories')
    expect(JSON.parse(raw || '[]').map((d: { path: string }) => d.path)).toContain('D:/Code/RaceAdd')
  })
})
