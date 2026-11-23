import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { childSessionStore } from '../../store/childSessionStore'
import { workStatusStore } from '../../store/workStatusStore'
import { WorkStatusSubagentsSection } from './WorkStatusSections'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const PARENT = 'server-a::parent-1'

function makeChild(id: string, parentID: string, title = id) {
  return { id, parentID, title, time: { created: 1, updated: 1 } }
}

function register(id: string, status?: 'running' | 'idle' | 'error') {
  childSessionStore.registerChildSession(makeChild(id, 'parent-1') as never, 'server-a', status)
}

function renderSection() {
  return render(
    <WorkStatusSubagentsSection
      sessionId={PARENT}
      contextLimit={200_000}
      onScrollToMessage={() => {}}
      onCompact={() => {}}
    />,
  )
}

describe('WorkStatusSubagentsSection', () => {
  beforeEach(() => {
    childSessionStore.clearAll()
    localStorage.clear()
    workStatusStore.setSectionExpanded('subagents', true)
    workStatusStore.setSectionExpanded('subagents-completed', false)
  })

  it('renders nothing without child sessions', () => {
    const { container } = renderSection()
    expect(container).toBeEmptyDOMElement()
  })

  it('groups completed subagents into a collapsed group', () => {
    register('c1', 'running')
    register('c2', 'idle')
    register('c3', 'idle')

    renderSection()

    // 运行中的子代理直接平铺可见
    expect(screen.getByText('c1')).toBeInTheDocument()

    // 已完成组默认收起（收起的 section 保留子节点，故用 aria-expanded 判定）
    const groupToggle = screen.getByText('workStatus.subagent.completedGroup').closest('button')
    expect(groupToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('reveals completed subagents after expanding the group', () => {
    register('c1', 'running')
    register('c2', 'idle')

    renderSection()

    const groupToggle = screen.getByText('workStatus.subagent.completedGroup').closest('button')!
    expect(groupToggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(groupToggle)

    expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps failed subagents visible instead of folding them away', () => {
    register('c1', 'error')

    renderSection()

    expect(screen.getByText('c1')).toBeInTheDocument()
    expect(screen.queryByText('workStatus.subagent.completedGroup')).not.toBeInTheDocument()
  })

  it('moves a subagent into the completed group when it goes idle', () => {
    register('c1', 'running')

    renderSection()
    expect(screen.getByText('c1')).toBeInTheDocument()
    expect(screen.queryByText('workStatus.subagent.completedGroup')).not.toBeInTheDocument()

    act(() => {
      childSessionStore.markIdle('server-a::c1')
    })

    const groupToggle = screen.getByText('workStatus.subagent.completedGroup').closest('button')
    expect(groupToggle).toHaveAttribute('aria-expanded', 'false')
  })
  it('嵌套分组的滚动容器禁止横向滚动(分隔线负边距会横向外溢)', () => {
    register('c1', 'running')
    register('c2', 'idle')

    const { container } = renderSection()
    const scroller = container.querySelector('[class*="max-h-56"]')
    expect(scroller).not.toBeNull()
    // 只写 overflow-y-auto 时另一轴会被算成 auto,而嵌套板块的 before:inset-x-[-.625rem]
    // 会横向溢出 → 出现左右滚动条。这里锁住显式的 overflow-x-hidden。
    expect(scroller!.className).toContain('overflow-x-hidden')
  })

})
