import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMermaidRenderCache,
  getCachedMermaidSvg,
  getOrRenderMermaidSvg,
  mermaidCacheKey,
  renderMermaidToSvg,
} from './mermaidRenderCache'

const renderMock = vi.hoisted(() =>
  vi.fn((_source: string, _options?: Record<string, unknown>) => ({
    svg: '<svg class="pele"></svg>',
    width: 100,
    height: 50,
    type: 'flowchart',
  })),
)

vi.mock('pele', () => ({
  render: renderMock,
  PeleError: class PeleError extends Error {},
}))

describe('mermaidCacheKey', () => {
  /**
   * 宽度分档是必要的，不是优化。
   *
   * Pele 按 `maxWidth` 决定横/竖布局（跨越 directionBreakpoint=640 时改变），
   * 同一份源码在宽屏与窄屏下产出**不同的 SVG**。若缓存键只有 code，
   * 第一次渲染的布局会永久生效 —— 实测先窄屏打开、回到宽屏后图表仍是竖版。
   */
  it('宽屏与窄屏产出不同的键', () => {
    const code = 'flowchart LR\n  A --> B'
    expect(mermaidCacheKey(code, 1400)).not.toBe(mermaidCacheKey(code, 400))
  })

  it('同一档位内复用同一个键（避免每像素都重渲染）', () => {
    const code = 'flowchart LR\n  A --> B'
    expect(mermaidCacheKey(code, 1400)).toBe(mermaidCacheKey(code, 900))
    expect(mermaidCacheKey(code, 400)).toBe(mermaidCacheKey(code, 320))
  })

  it('未知宽度单独成档', () => {
    const code = 'flowchart LR\n  A --> B'
    const auto = mermaidCacheKey(code)
    expect(auto).toBe(mermaidCacheKey(code, 0))
    expect(auto).not.toBe(mermaidCacheKey(code, 1400))
    expect(auto).not.toBe(mermaidCacheKey(code, 400))
  })

  it('640px 是断点：恰好 640 归入宽屏', () => {
    const code = 'flowchart LR\n  A --> B'
    expect(mermaidCacheKey(code, 640)).toBe(mermaidCacheKey(code, 1400))
    expect(mermaidCacheKey(code, 639)).toBe(mermaidCacheKey(code, 400))
  })
})

describe('renderMermaidToSvg', () => {
  beforeEach(() => {
    renderMock.mockClear()
    clearMermaidRenderCache()
  })

  it('关闭链接与图片（图表源码来自模型，属于不可信内容）', async () => {
    await renderMermaidToSvg('flowchart LR\n  A --> B', 'p1')

    expect(renderMock).toHaveBeenCalledWith(
      'flowchart LR\n  A --> B',
      expect.objectContaining({ links: false, images: false, idPrefix: 'p1' }),
    )
  })

  it('传入有效宽度时启用方向自适应', async () => {
    await renderMermaidToSvg('flowchart LR\n  A --> B', 'p1', 400)

    expect(renderMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxWidth: 400, autoDirection: true, directionBreakpoint: 640 }),
    )
  })

  it('宽度为 0 或未提供时不传 maxWidth（传 0 会被当成极窄屏）', async () => {
    await renderMermaidToSvg('flowchart LR\n  A --> B', 'p1', 0)
    const opts = renderMock.mock.calls[0][1] as Record<string, unknown>
    expect(opts.maxWidth).toBeUndefined()
  })
})

describe('渲染缓存', () => {
  beforeEach(() => {
    renderMock.mockClear()
    clearMermaidRenderCache()
  })

  it('同键只渲染一次', async () => {
    const first = await getOrRenderMermaidSvg('k', async () => 'svg-1')
    const second = await getOrRenderMermaidSvg('k', async () => 'svg-2')

    expect(first).toBe('svg-1')
    expect(second).toBe('svg-1')
  })

  it('不同宽度分档各自渲染', async () => {
    const wide = mermaidCacheKey('code', 1400)
    const narrow = mermaidCacheKey('code', 400)

    await getOrRenderMermaidSvg(wide, async () => 'wide-svg')
    await getOrRenderMermaidSvg(narrow, async () => 'narrow-svg')

    expect(getCachedMermaidSvg(wide)).toBe('wide-svg')
    expect(getCachedMermaidSvg(narrow)).toBe('narrow-svg')
  })
})
