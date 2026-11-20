import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HintTooltip, NativeTooltip, Tooltip } from './Tooltip'

/**
 * 触摸端不展示自绘提示(见 Tooltip.tsx 的 useTooltipsDisabledOnTouch)。
 *
 * 判定来自 matchMedia:能 hover 的设备照常显示;只有粗指针且不能 hover 的
 * 设备(preferTouchUi)才关闭。这里通过覆写 matchMedia 模拟两类设备。
 */
function stubMatchMedia(touch: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: touch ? !query.includes('hover') : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      }) as unknown as MediaQueryList,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tooltips vs touch devices', () => {
  it('shows the bubble on hover-capable devices', async () => {
    stubMatchMedia(false)
    render(
      <HintTooltip title="提示内容" open>
        <button>Go</button>
      </HintTooltip>,
    )
    expect(await screen.findByText('提示内容')).toBeTruthy()
  })

  it('renders no bubble on touch devices', () => {
    stubMatchMedia(true)
    render(
      <HintTooltip title="提示内容" open>
        <button>Go</button>
      </HintTooltip>,
    )
    expect(screen.queryByText('提示内容')).toBeNull()
  })

  it('NativeTooltip still strips the native title on touch', () => {
    stubMatchMedia(true)
    render(
      <NativeTooltip>
        <button title="原生提示">Go</button>
      </NativeTooltip>,
    )
    // 气泡没了,长按也不该再弹浏览器原生 title
    expect(screen.getByRole('button').getAttribute('title')).toBeNull()
  })

  it('Tooltip renders children without the trigger wrapper on touch', () => {
    stubMatchMedia(true)
    const { container } = render(
      <Tooltip content="提示内容">
        <button>Go</button>
      </Tooltip>,
    )
    expect(container.querySelector('button')?.getAttribute('data-state')).toBeNull()
  })
})
