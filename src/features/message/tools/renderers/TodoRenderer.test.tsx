import { render, screen, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoList } from './TodoRenderer'

// 展开/折叠状态是模块级缓存：每个用例用不同的 stateKey，避免互相污染
let keySeq = 0
function freshKey() {
  keySeq += 1
  return `todo-test-${keySeq}`
}

const TODOS = [
  { id: 't1', content: '第一步', status: 'completed', priority: 'high' },
  { id: 't2', content: '第二步', status: 'in_progress', priority: 'medium' },
]

/**
 * 折叠用的是 max-height 动画，收起后条目仍在 DOM 里（只是高度为 0）。
 * 因此判断「是否展开」要读 DisclosureRow 的 aria-expanded，而不是看文本存在与否。
 */
function headerExpanded(): boolean {
  const btn = screen.getByText('Tasks').closest('[aria-expanded]')
  return btn?.getAttribute('aria-expanded') === 'true'
}

describe('TodoList 默认折叠', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('展开时显示每一条待办', () => {
    render(<TodoList todos={TODOS} stateKey={freshKey()} />)

    expect(screen.getByText('第一步')).toBeInTheDocument()
    expect(screen.getByText('第二步')).toBeInTheDocument()
    expect(headerExpanded()).toBe(true)
  })

  it('defaultCollapsed 时只留标题与进度（条目不再展开）', () => {
    /**
     * 对话结尾的待办属于历史记录：常驻展开会占掉一大块，
     * 把真正的回复推远。收起后标题行仍带「完成数 / 总数 + 百分比」。
     */
    render(<TodoList todos={TODOS} stateKey={freshKey()} defaultCollapsed />)

    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(headerExpanded()).toBe(false)
  })

  it('autoCollapse 会跟随 defaultCollapsed 变化（本轮结束 → 收起）', () => {
    const key = freshKey()
    const { rerender } = render(<TodoList todos={TODOS} stateKey={key} defaultCollapsed={false} autoCollapse />)

    // 进行中：展开
    expect(headerExpanded()).toBe(true)

    // 本轮结束：自动收起
    rerender(<TodoList todos={TODOS} stateKey={key} defaultCollapsed autoCollapse />)
    expect(headerExpanded()).toBe(false)
  })

  it('用户手动操作过的卡片不会被自动收起覆盖', () => {
    /**
     * 关键约束：`touched` 为真后，自动收起必须让位。
     * 否则每帧同步都会把用户刚点开的列表又收回去。
     */
    const key = freshKey()
    const { rerender } = render(<TodoList todos={TODOS} stateKey={key} defaultCollapsed={false} autoCollapse />)
    expect(headerExpanded()).toBe(true)

    // 用户手动收起 → 再展开，即「有手势意图」
    act(() => {
      screen.getByText('Tasks').click()
    })
    expect(headerExpanded()).toBe(false)

    act(() => {
      screen.getByText('Tasks').click()
    })
    expect(headerExpanded()).toBe(true)

    // 此后即使 autoCollapse 要求收起，也应保持用户的选择
    rerender(<TodoList todos={TODOS} stateKey={key} defaultCollapsed autoCollapse />)
    expect(headerExpanded()).toBe(true)
  })

  it('没有 autoCollapse 时不监听 defaultCollapsed 变化', () => {
    const key = freshKey()
    const { rerender } = render(<TodoList todos={TODOS} stateKey={key} defaultCollapsed={false} />)
    expect(headerExpanded()).toBe(true)

    rerender(<TodoList todos={TODOS} stateKey={key} defaultCollapsed />)
    // 没有 autoCollapse：保持初值，仍展开
    expect(headerExpanded()).toBe(true)
  })
})
