// 侧栏搜索输入框的防抖提交行为。
//
// search 存在顶层 SessionContext,Provider 包着整棵应用;若每次按键都 setSearch,
// 侧栏 23 个文件夹 section 会一起重渲染,输入明显卡顿。这里验证:
//   - 输入即时反映在受控值上(跟手)
//   - 只在停止输入后才提交到 context(触发一次列表过滤)
//   - 外部值变化会取消尚未提交的防抖(不让迟到的提交顶回外部值)
//   - 卸载时补交尚未提交的输入(收起侧栏不丢查询)

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { SidebarSearchInput } from './SidePanel'

function setup(initial = '') {
  const onCommit = vi.fn()
  const ref = createRef<HTMLInputElement>()
  const view = render(
    <SidebarSearchInput
      value={initial}
      onCommit={onCommit}
      isLoading={false}
      inputRef={ref}
      placeholder="Search chats..."
      searchingLabel="Searching"
      clearLabel="Clear search"
    />,
  )
  const input = screen.getByPlaceholderText('Search chats...') as HTMLInputElement
  const rerender = (value: string) =>
    view.rerender(
      <SidebarSearchInput
        value={value}
        onCommit={onCommit}
        isLoading={false}
        inputRef={ref}
        placeholder="Search chats..."
        searchingLabel="Searching"
        clearLabel="Clear search"
      />,
    )
  return { onCommit, input, rerender, unmount: view.unmount }
}

describe('SidebarSearchInput 防抖提交', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('输入即时可见,但防抖后才提交', () => {
    const { onCommit, input } = setup()

    fireEvent.change(input, { target: { value: 'abc' } })

    expect(input.value).toBe('abc')
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('abc')
  })

  it('连续快速输入只提交最后一次', () => {
    const { onCommit, input } = setup()

    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.change(input, { target: { value: 'abc' } })

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('abc')
  })

  it('点清空立即提交空串', () => {
    const { onCommit, input } = setup('abc')
    expect(input.value).toBe('abc')

    fireEvent.click(screen.getByLabelText('Clear search'))
    expect(onCommit).toHaveBeenCalledWith('')
    expect(input.value).toBe('')
  })

  it('外部 value 变化取消尚未提交的防抖,不让迟到的提交顶回外部值', () => {
    const { onCommit, input, rerender } = setup()

    fireEvent.change(input, { target: { value: 'draft' } })
    // 提交尚未发生,外部(另一处 setSearch)把值改了
    rerender('external')

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('external')
  })

  it('卸载时补交尚未提交的输入', () => {
    const { onCommit, input, unmount } = setup()

    fireEvent.change(input, { target: { value: 'pending' } })
    unmount()

    expect(onCommit).toHaveBeenCalledWith('pending')
  })

  it('没有待提交内容时卸载不产生多余提交', () => {
    const { onCommit, unmount } = setup()

    unmount()

    expect(onCommit).not.toHaveBeenCalled()
  })
})
