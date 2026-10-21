import { describe, expect, it } from 'vitest'
import source from './Sidebar.tsx?raw'

/**
 * 网页端侧栏顶栏必须与桌面端共用同一套导航控件。
 *
 * 用户报的是「网页端左上角按钮样式和桌面端不一致」。根因是两端各写了一套：
 * 桌面端（Windows 全高侧栏）用 DesktopNavControls 的一排 IconButton，网页端
 * 用「折叠按钮 + Logo 文字」的独立 header，两边各自演进后分叉。
 *
 * SidePanelHeader.test 只能证明「传了 headerContent 时会替换默认 header」，
 * 证明不了「调用方真的传了」。这里补上调用侧的断言：docked 分支（网页端）
 * 必须把 DesktopNavControls 通过 headerContent 传给 SidePanel。
 */

/** 取最后一个 <SidePanel ... /> 块：docked 分支在文件末尾，移动端/overlay 在前 */
function lastSidePanelBlock(): string {
  const index = source.lastIndexOf('<SidePanel')
  expect(index).toBeGreaterThan(-1)
  const end = source.indexOf('/>', index)
  return source.slice(index, end)
}

describe('web sidebar top bar', () => {
  it('passes DesktopNavControls as headerContent on the docked (web) branch', () => {
    const block = lastSidePanelBlock()
    expect(block).toContain('headerContent=')
    expect(block).toContain('DesktopNavControls')
    // 侧栏开关必须绑定到同一个 handleToggle，展开态才正确
    expect(block).toContain('sidebarOpen={isOpen}')
  })

  it('does not render the nav controls twice on Windows full-height sidebar', () => {
    const block = lastSidePanelBlock()
    // Windows 全高侧栏已有独立工具栏：同一行控件不能出现两次
    expect(block).toContain('hideHeader={getDesktopPlatform()')
  })
})
