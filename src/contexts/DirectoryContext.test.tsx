import { act, render } from '@testing-library/react'
import { useContext, useEffect, type ContextType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryContext } from './DirectoryContext.shared'
import { DirectoryProvider } from './DirectoryContext'

const { serverChangeListeners, getActiveServerIdMock, setJSONForMock, setJSONMock } = vi.hoisted(() => ({
  serverChangeListeners: [] as Array<(id: string, reason: string) => void>,
  getActiveServerIdMock: vi.fn(() => 'aiagent:inst_work'),
  setJSONForMock: vi.fn(),
  setJSONMock: vi.fn(),
}))

vi.mock('../utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils')>()
  return {
    ...actual,
    serverStorage: {
      get: vi.fn(() => null),
      getJSON: vi.fn(() => null),
      set: vi.fn(),
      setJSON: setJSONMock,
      getFor: vi.fn(() => null),
      getJSONFor: vi.fn(() => null),
      setFor: vi.fn(),
      setJSONFor: setJSONForMock,
    },
  }
})

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: getActiveServerIdMock,
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
    serverChangeListeners.length = 0
    getActiveServerIdMock.mockReset().mockReturnValue('aiagent:inst_work')
    setJSONForMock.mockReset()
    setJSONMock.mockReset()
  })

  it('writes back to the server the list was read from, not the current active one', async () => {
    // 回归：写回曾用「当前活动服务器」，切换主机或同步引擎在别处触发重读时，
    // 会把 A 主机的列表写进 B 主机的桶 —— 表现为「新建的项目一同步就没了」。
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    // 切换活动服务器到 laptop（模拟用户在两端切主机 / 同步引擎触发）
    getActiveServerIdMock.mockReturnValue('aiagent:inst_laptop')
    await act(async () => {
      serverChangeListeners.forEach(fn => fn('aiagent:inst_laptop', 'server-switch'))
    })
    const callsBeforeSwitch = setJSONForMock.mock.calls.length

    // 切换后再触发一次写入：必须写回 laptop（新绑定），而不是仍写 work
    await act(async () => {
      latest?.addDirectory('D:/Code/AfterSwitch')
    })

    const afterSwitch = setJSONForMock.mock.calls.slice(callsBeforeSwitch)
    expect(afterSwitch.length).toBeGreaterThan(0)
    for (const call of afterSwitch) {
      expect(call[2]).toBe('aiagent:inst_laptop')
    }
    // 且不应再出现「写当前活动服务器」的旧路径
    expect(setJSONMock).not.toHaveBeenCalled()
  })

  it('adds a directory and persists it under the bound server', async () => {
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('D:/Code/NewProject')
    })

    const saved = latest?.savedDirectories.map(d => d.path) ?? []
    expect(saved).toContain('D:/Code/NewProject')

    const savedCalls = setJSONForMock.mock.calls.filter(call => String(call[0]).includes('saved-directories'))
    expect(savedCalls.length).toBeGreaterThan(0)
    expect(savedCalls[savedCalls.length - 1][2]).toBe('aiagent:inst_work')
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

  it('writes the new directory under the active server bucket', async () => {
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )

    await act(async () => {
      latest?.addDirectory('/opt/code/komidash')
    })

    const savedCalls = setJSONForMock.mock.calls.filter(call => String(call[0]).includes('saved-directories'))
    expect(savedCalls.length).toBeGreaterThan(0)
    // 必须写进「当前活动服务器」的桶；写进过期快照的桶会让项目切回主机后消失
    expect(savedCalls[savedCalls.length - 1][2]).toBe(getActiveServerIdMock())
  })
})
