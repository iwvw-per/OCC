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

describe('ProcessCollapseBlock 回拉不应反复重试（闪烁）', () => {
  /**
   * 回归：骨架条不停闪烁。
   *
   * 成因：自动回拉的 effect 依赖里含 runHydrate，而 runHydrate 依赖
   * onExpand（调用方传内联箭头函数，每次渲染都是新引用）。于是每次渲染
   * effect 都重跑 → 失败 → setState → 再渲染 → 再重跑，请求连发、
   * 占位条一闪一闪。
   */
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('回拉失败后不再自动重试（只尝试一次）', async () => {
    const onExpand = vi.fn(() => Promise.reject(new Error('boom')))

    render(
      <ProcessCollapseBlock stateKey={`flash-${Date.now()}`} isActive needsHydrate onExpand={onExpand}>
        <div>占位</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => {
      expect(screen.getByText('process.hydrateFailed')).toBeInTheDocument()
    })

    // 再等一段时间，确认没有继续发请求
    await act(async () => {
      await new Promise(r => setTimeout(r, 300))
    })

    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('父组件重渲染（onExpand 换成新函数）也不会引发再次回拉', async () => {
    const onExpand1 = vi.fn(() => Promise.reject(new Error('boom')))

    const { rerender } = render(
      <ProcessCollapseBlock stateKey={`flash2-${Date.now()}`} isActive needsHydrate onExpand={onExpand1}>
        <div>占位</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => expect(onExpand1).toHaveBeenCalledTimes(1))

    // 模拟父组件重渲染：传入全新的函数引用（内联箭头函数的常态）
    const onExpand2 = vi.fn(() => Promise.reject(new Error('boom')))
    for (let i = 0; i < 3; i++) {
      rerender(
        <ProcessCollapseBlock stateKey={`flash2-${Date.now()}`} isActive needsHydrate onExpand={onExpand2}>
          <div>占位</div>
        </ProcessCollapseBlock>,
      )
      await act(async () => {
        await new Promise(r => setTimeout(r, 80))
      })
    }

    // 关键：换引用不触发重试
    expect(onExpand1).toHaveBeenCalledTimes(1)
    expect(onExpand2).not.toHaveBeenCalled()
  })

  it('用户点「重试」后才会再拉一次', async () => {
    let shouldFail = true
    const onExpand = vi.fn(() =>
      shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve(),
    )

    render(
      <ProcessCollapseBlock stateKey={`retry-${Date.now()}`} isActive needsHydrate onExpand={onExpand}>
        <div>占位</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => expect(screen.getByText('process.retry')).toBeInTheDocument())
    expect(onExpand).toHaveBeenCalledTimes(1)

    shouldFail = false
    await act(async () => {
      screen.getByText('process.retry').click()
      await new Promise(r => setTimeout(r, 100))
    })

    expect(onExpand).toHaveBeenCalledTimes(2)
    // 成功后失败提示消失
    await waitFor(() => {
      expect(screen.queryByText('process.hydrateFailed')).not.toBeInTheDocument()
    })
  })
})

describe('折叠块反复挂载卸载不应重复回拉（闪烁）', () => {
  /**
   * 虚拟列表 + 展开态缓存淘汰会带来「反复挂载」：
   *
   *   - 折叠块滚出视口被卸载 → 组件内 ref 归零
   *   - `useUiDisclosureState` 缓存 2000 条上限，长会话里旧 key 被淘汰 →
   *     expanded 重置成初始值（进行中的轮次 = 展开）
   *
   * 两者叠加：每次重挂都当成「第一次」→ 再拉一次 → 又失败 → 再卸载 →
   * 骨架条持续闪烁、请求连发。
   *
   * 修法：用模块级 Set 按 stateKey 记「已尝试过」，与组件生命周期解耦。
   */
  const KEY = 'remount-flash-key'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('同一轮次卸载后重新挂载，不再发起第二次回拉', async () => {
    const onExpand = vi.fn(() => Promise.reject(new Error('boom')))

    const first = render(
      <ProcessCollapseBlock stateKey={KEY} isActive needsHydrate onExpand={onExpand}>
        <div>占位</div>
      </ProcessCollapseBlock>,
    )

    await waitFor(() => expect(onExpand).toHaveBeenCalledTimes(1))
    first.unmount()

    // 模拟滚动回来重新挂载
    render(
      <ProcessCollapseBlock stateKey={KEY} isActive needsHydrate onExpand={onExpand}>
        <div>占位</div>
      </ProcessCollapseBlock>,
    )

    await act(async () => {
      await new Promise(r => setTimeout(r, 200))
    })

    // 关键：重挂不重拉
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
