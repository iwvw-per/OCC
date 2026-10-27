import { render, screen, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessCollapseBlock } from './MessageRenderer'

/**
 * 回归：最新那条「正在进行的回复」展开后一直空白。
 *
 * 骨架投影把未定稿轮次的正文剥掉了（消息还在，只是没有过程内容）。
 * 而回拉逻辑此前只写在**点击**处理里 —— 进行中的轮次是自动展开的，
 * 从不经过点击，于是永远不会触发回拉，展开区一直是空的。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../hooks', () => ({
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
  useCompositorExpand: (open: boolean) => ({
    contentRef: () => undefined,
    layoutOpen: open,
    keepMounted: true,
    panelClassName: '',
  }),
}))

// 用真实实现：DisclosureRow / 折叠面板依赖这里的常量与类名工具，
// 手写 mock 很容易漏导出（MSG_EXPAND / chevronClass / expandGridClass…）。
// 只把「是否渲染内容」固定为 true，避免 Android 假高度分支干扰断言。
vi.mock('./messageExpandShared', async () => {
  const actual = await vi.importActual<typeof import('./messageExpandShared')>('./messageExpandShared')
  return { ...actual, useMessageExpandRender: () => true }
})

vi.mock('./messageExpand', () => ({
  MessageExpandPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

/** 让 useUiDisclosureState 每次用新 key，避免模块级缓存串用例 */
let keySeq = 0
function freshKey() {
  keySeq += 1
  return `process-test-${keySeq}`
}

describe('ProcessCollapseBlock 自动展开时回拉', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('进行中自动展开 + 需要回拉时，主动触发一次回拉', async () => {
    const onExpand = vi.fn(() => Promise.resolve())

    render(
      <ProcessCollapseBlock
        stateKey={freshKey()}
        isActive
        needsHydrate
        onExpand={onExpand}
      >
        <div>占位内容</div>
      </ProcessCollapseBlock>,
    )

    // 自动展开不经过点击，必须自己触发回拉
    await waitFor(() => {
      expect(onExpand).toHaveBeenCalled()
    })
  })

  it('不需要回拉时（内容已在内存）不发请求', async () => {
    const onExpand = vi.fn(() => Promise.resolve())

    render(
      <ProcessCollapseBlock stateKey={freshKey()} isActive needsHydrate={false} onExpand={onExpand}>
        <div>已有内容</div>
      </ProcessCollapseBlock>,
    )

    // 等过几帧确认没有触发
    await act(async () => {
      await new Promise(r => setTimeout(r, 80))
    })
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('折叠态不触发回拉（省一次网络往返）', async () => {
    const onExpand = vi.fn(() => Promise.resolve())

    render(
      <ProcessCollapseBlock
        stateKey={freshKey()}
        isActive={false}
        forceExpanded={false}
        needsHydrate
        onExpand={onExpand}
      >
        <div>占位内容</div>
      </ProcessCollapseBlock>,
    )

    await act(async () => {
      await new Promise(r => setTimeout(r, 80))
    })
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('回拉进行中不重复触发', async () => {
    let resolveFn: (() => void) | null = null
    const onExpand = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveFn = resolve
        }),
    )

    render(
      <ProcessCollapseBlock stateKey={freshKey()} isActive needsHydrate onExpand={onExpand}>
        <div>占位内容</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => expect(onExpand).toHaveBeenCalledTimes(1))

    // 重新渲染若干次，仍在 in-flight，不应再发
    await act(async () => {
      await new Promise(r => setTimeout(r, 100))
    })
    expect(onExpand).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFn?.()
      await new Promise(r => setTimeout(r, 50))
    })
  })

  it('回拉失败后显示失败提示与重试入口', async () => {
    const onExpand = vi.fn(() => Promise.reject(new Error('boom')))

    render(
      <ProcessCollapseBlock stateKey={freshKey()} isActive needsHydrate onExpand={onExpand}>
        <div>占位内容</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => {
      expect(screen.getByText('process.hydrateFailed')).toBeInTheDocument()
    })
    expect(screen.getByText('process.retry')).toBeInTheDocument()
  })
})
