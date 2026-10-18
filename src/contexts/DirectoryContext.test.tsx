import { act, render } from '@testing-library/react'
import { useContext, useEffect, type ContextType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryContext } from './DirectoryContext.shared'
import { DirectoryProvider } from './DirectoryContext'
import { resetAppDataBindingForTests } from '../storage/appData'

const { serverChangeListeners, getActiveServerIdMock } = vi.hoisted(() => ({
  serverChangeListeners: [] as Array<(id: string, reason: string) => void>,
  getActiveServerIdMock: vi.fn(() => 'aiagent:inst_work'),
}))

/** 读取某个服务器桶里的项目列表 */
function buckets(serverId: string): string[] {
  const raw = localStorage.getItem(`srv:${serverId}:opencode-saved-directories`)
  return raw ? (JSON.parse(raw) as Array<{ path: string }>).map(item => item.path) : []
}

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: getActiveServerIdMock,
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
  multiServerStore: { getFocusedServerId: () => 'aiagent:inst_work' },
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

describe('DirectoryContext per-server binding', () => {
  let latest: ContextType<typeof DirectoryContext> = null

  // 用 ref 承接 context 值：在 render 期间给外部变量赋值会被 react-hooks/refs 判为
  // 副作用（与组件纯度规则冲突），这里通过 effect 落地。
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
    serverChangeListeners.length = 0
    getActiveServerIdMock.mockReset().mockReturnValue('aiagent:inst_work')
  })

  it('writes into the bucket of the server that is active at write time', async () => {
    // 回归：写回曾用「读时绑定的 serverId」，切换主机后会把新列表写进旧桶 ——
    // 表现为「新建的项目切回主机后消失」。现在 rebind 与写入同源，永远一致。
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('/opt/code/OnWork')
    })
    expect(buckets('aiagent:inst_work')).toEqual(['/opt/code/OnWork'])

    // 切到 laptop 后再添加：必须写进 laptop 的桶，且不污染 work 的桶
    getActiveServerIdMock.mockReturnValue('aiagent:inst_laptop')
    await act(async () => {
      serverChangeListeners.forEach(fn => fn('aiagent:inst_laptop', 'server-switch'))
    })
    await act(async () => {
      latest?.addDirectory('/opt/code/OnLaptop')
    })

    expect(buckets('aiagent:inst_laptop')).toEqual(['/opt/code/OnLaptop'])
    expect(buckets('aiagent:inst_work')).toEqual(['/opt/code/OnWork'])
  })

  it('adds a directory and persists it under the bound server', async () => {
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('/opt/code/NewProject')
    })

    expect(latest?.savedDirectories.map(d => d.path)).toContain('/opt/code/NewProject')
    expect(buckets('aiagent:inst_work')).toContain('/opt/code/NewProject')
  })

  it('adds a directory only once when the same click fires twice', async () => {
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    // 同一点击触发两次 addDirectory（双击 / 事件重复派发）：闭包里的
    // savedDirectories 两次都读到「不存在」，必须在 updater 内以 prev 去重。
    await act(async () => {
      latest?.addDirectory('/opt/code/opencode-bg')
      latest?.addDirectory('/opt/code/opencode-bg/')
    })

    const saved = latest?.savedDirectories.map(d => d.path) ?? []
    expect(saved.filter(p => p === '/opt/code/opencode-bg')).toHaveLength(1)
  })

})
