import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DropdownMenu } from './DropdownMenu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import {
  LAYER_CONTEXT_MENU,
  LAYER_DIALOG,
  LAYER_DRAG,
  LAYER_PANEL,
  LAYER_POPUP,
  LAYER_TOOLTIP,
} from '../../constants/layers'

/**
 * 浮层层级回归。
 *
 * 现场:设置对话框里的「更新线路」下拉框被对话框盖住 —— 菜单显示在下一段内容
 * 的后面。原因是 Select/Popover 用 z-200,而 Dialog 用 z-300;这些弹层都 portal 到
 * document.body,层级只由 z-index 决定,所以对话框内的下拉必然被盖住。
 *
 * 这里固住全局顺序,并确认弹层组件确实用了「高于对话框」的那一档 ——
 * 否则任何对话框里的下拉都会重演该 bug。
 */

describe('浮层层级', () => {
  it('顺序为 面板 < 对话框 < 弹层 < 提示 < 上下文菜单 < 拖拽层', () => {
    expect(LAYER_PANEL).toBeLessThan(LAYER_DIALOG)
    expect(LAYER_DIALOG).toBeLessThan(LAYER_POPUP)
    expect(LAYER_POPUP).toBeLessThan(LAYER_TOOLTIP)
    expect(LAYER_TOOLTIP).toBeLessThan(LAYER_CONTEXT_MENU)
    expect(LAYER_CONTEXT_MENU).toBeLessThan(LAYER_DRAG)
  })

  it('DropdownMenu 默认层级高于对话框(否则对话框内的菜单被盖住)', () => {
    const trigger = { current: document.createElement('button') }
    render(
      <DropdownMenu triggerRef={trigger} isOpen>
        <div>item</div>
      </DropdownMenu>,
    )

    const menu = document.querySelector(`[data-overlay-state]`) as HTMLElement | null
    expect(menu).not.toBeNull()
    expect(Number(menu!.style.zIndex)).toBeGreaterThan(LAYER_DIALOG)
  })

  it('Select 下拉层级高于对话框', () => {
    render(
      <Select open value="a">
        <SelectTrigger aria-label="选择">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    )

    const content = screen.getByRole('listbox')
    expect(Number((content as HTMLElement).style.zIndex)).toBeGreaterThan(LAYER_DIALOG)
  })

  it('Popover 浮层层级高于对话框', () => {
    render(
      <Popover open>
        <PopoverTrigger aria-label="打开">trigger</PopoverTrigger>
        <PopoverContent>body</PopoverContent>
      </Popover>,
    )

    const content = document.querySelector('[data-radix-popper-content-wrapper] > *') as HTMLElement | null
    expect(content).not.toBeNull()
    expect(Number(content!.style.zIndex)).toBeGreaterThan(LAYER_DIALOG)
  })
})
