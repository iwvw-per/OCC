import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { childSessionStore } from '../../store/childSessionStore'
import { workStatusStore } from '../../store/workStatusStore'
import { WorkStatusSubagentsSection } from './WorkStatusSections'

/**
 * 组件用 `useTranslation(['chat', 'common'])` 并带命名空间前缀调用
 * （`chat:workStatus...`）。mock 必须保持 key 原样，否则断言找不到文本。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const getSessionMessagesMock = vi.fn()
vi.mock('../../api/message', () => ({
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
}))

const navigateToSessionMock = vi.fn()
const openSessionInSplitMock = vi.fn()
vi.mock('../../contexts/SessionNavigationContext', () => ({
  useSessionNavigation: () => ({
    navigateToSession: navigateToSessionMock,
    openSessionInSplit: openSessionInSplitMock,
  }),
}))

const PARENT = 'server-a::parent-1'

function register(id: string, status?: 'running' | 'idle' | 'error', title = id, agent?: string) {
  childSessionStore.registerChildSession(
    { id, parentID: 'parent-1', title, agent, time: { created: 1_700_000_000_000, updated: 1 } } as never,
    'server-a',
    status,
  )
}

/** 子会话消息：一条用户提问 + 一条助手结论 */
function childMessages(prompt: string, reply: string) {
  return [
    { info: { id: 'u1', role: 'user', text: prompt }, parts: [{ type: 'text', text: prompt }] },
    { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: reply }] },
  ]
}

function renderSection(onScrollToMessage = vi.fn()) {
  return render(
    <WorkStatusSubagentsSection
      sessionId={PARENT}
      directory="/workspace/demo"
      serverId="server-a"
      contextLimit={200_000}
      onScrollToMessage={onScrollToMessage}
    />,
  )
}

describe('WorkStatusSubagentsSection 详情弹窗', () => {
  beforeEach(() => {
    childSessionStore.clearAll()
    localStorage.clear()
    vi.clearAllMocks()
    workStatusStore.setSectionExpanded('subagents', true)
    workStatusStore.setSectionExpanded('subagents-completed', true)
    getSessionMessagesMock.mockResolvedValue([])
    openSessionInSplitMock.mockReturnValue(true)
  })

  it('点击子代理打开详情弹窗', async () => {
    register('c1', 'running', '调研登录接口')
    renderSection()

    // 弹窗未打开时没有关闭按钮
    expect(screen.queryByLabelText('common:close')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(screen.getByLabelText('common:close')).toBeInTheDocument()
    })
  })

  it('弹窗里显示子代理的任务与结论', async () => {
    register('c1', 'idle', '调研登录接口')
    getSessionMessagesMock.mockResolvedValue(childMessages('看看登录怎么做的', '登录用 session cookie，见 /api/auth'))

    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(screen.getByText('看看登录怎么做的')).toBeInTheDocument()
    })
    expect(screen.getByText('登录用 session cookie，见 /api/auth')).toBeInTheDocument()
  })

  it('按子会话自己的消息拉取，且不剥正文（project: false）', async () => {
    register('c1', 'idle')
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(getSessionMessagesMock).toHaveBeenCalled()
    })
    const [sessionId, , directory, serverId, options] = getSessionMessagesMock.mock.calls[0]
    // store 里的 child.id 是带 serverId 前缀的复合 key；getSessionMessagePage 内部
    // 用 resolveSessionTarget 拆出裸 id，因此这里原样透传即可
    expect(sessionId).toBe('server-a::c1')
    expect(directory).toBe('/workspace/demo')
    expect(serverId).toBe('server-a')
    // 轻量投影会剥掉正文，这里必须关掉
    expect(options).toMatchObject({ project: false })
  })

  it('子代理还没有正文时给出说明而不是空白', async () => {
    register('c1', 'running')
    getSessionMessagesMock.mockResolvedValue([])
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(screen.getByText('chat:workStatus.subagent.detailNoReply')).toBeInTheDocument()
    })
  })

  it('读取失败时提示，并保留「打开会话」入口', async () => {
    register('c1', 'idle')
    getSessionMessagesMock.mockRejectedValue(new Error('boom'))
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(screen.getByText('chat:workStatus.subagent.detailLoadFailed')).toBeInTheDocument()
    })
    expect(screen.getByText('chat:workStatus.subagent.openSession')).toBeInTheDocument()
  })

  it('「打开会话」优先走分屏', async () => {
    register('c1', 'idle')
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    fireEvent.click(screen.getByText('chat:workStatus.subagent.openSession'))

    // child.id 是带 serverId 前缀的复合 key，navigateToSession 内部会拆
    expect(openSessionInSplitMock).toHaveBeenCalledWith('server-a::c1', '/workspace/demo')
    expect(navigateToSessionMock).not.toHaveBeenCalled()
  })

  it('分屏不可用时退回主区域跳转', async () => {
    register('c1', 'idle')
    openSessionInSplitMock.mockReturnValue(false)
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    fireEvent.click(screen.getByText('chat:workStatus.subagent.openSession'))

    expect(navigateToSessionMock).toHaveBeenCalledWith('server-a::c1', '/workspace/demo')
  })

  it('子代理结束后弹窗里的状态跟着更新', async () => {
    register('c1', 'running')
    renderSection()
    fireEvent.click(screen.getByLabelText('workStatus.subagent.openDetail'))

    await waitFor(() => {
      expect(screen.getByText('chat:workStatus.subagent.working')).toBeInTheDocument()
    })

    act(() => {
      childSessionStore.markIdle('server-a::c1')
    })

    // 弹窗没关，状态应变成「已完成」
    await waitFor(() => {
      expect(screen.getByLabelText('common:close')).toBeInTheDocument()
    })
    expect(screen.queryByText('chat:workStatus.subagent.working')).not.toBeInTheDocument()
  })
})
