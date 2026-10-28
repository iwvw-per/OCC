import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMermaidRenderCache,
  getCachedMermaidSvg,
  getOrRenderMermaidSvg,
  injectC4Layout,
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

describe('injectC4Layout', () => {
  /**
   * 实测回归：C4 容器图默认布局会把图糊成一团。
   *
   * Pele 的 C4 实现内部默认 `shapeInRow = 4`（每行固定 4 个元素）。
   * 典型容器图有 10+ 个元素，这个密度会把长链路硬压成 4 列，连线大量
   * 穿过无关节点 —— 实测 15 个节点的电商容器图有 8 条连线直接穿过节点框。
   *
   * 同一张图改 shapeInRow 后的对比（连线穿过节点数）：
   *   4（默认） 1296×854   8 条穿过  ❌
   *   3         1025×1052  0 条穿过  ✅
   *   2          778×1650  0 条穿过  ✅（过高）
   *   5         1632×878  11 条穿过  ❌
   *
   * 所以按规模选列数：小图保持 4（宽扁好看），大图降到 3（清晰优先）。
   */
  const bigC4 = `C4Container
  Person(user, "买家", "浏览")
  System_Ext(pay, "支付", "第三方")
  Container_Boundary(b, "平台") {
    Container(a, "A", "Spring", "描述")
    Container(c, "B", "Spring", "描述")
    Container(d, "C", "Spring", "描述")
    Container(e, "D", "Spring", "描述")
    Container(f, "E", "Spring", "描述")
  }
  Rel(user, a, "用")
  Rel(a, c, "调")
  Rel(c, d, "调")
  Rel(d, e, "调")
  Rel(e, f, "调")
  Rel(f, pay, "付")`

  it('大 C4 图降到 3 列', () => {
    const out = injectC4Layout(bigC4)
    expect(out).toContain('UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")')
  })

  it('关系特别密集时降到 2 列（用高度换清晰度）', () => {
    const dense = bigC4 + Array.from({ length: 20 }, (_, i) => `  Rel(a, c, "r${i}")`).join('\n')
    const out = injectC4Layout(dense)
    expect(out).toContain('$c4ShapeInRow="2"')
  })

  it('小图保持默认 4 列（宽扁更好看）', () => {
    const small = `C4Context
  Person(u, "用户", "使用")
  System(s, "系统", "核心")
  Rel(u, s, "访问")`
    const out = injectC4Layout(small)
    expect(out).toContain('$c4ShapeInRow="4"')
  })

  it('非 C4 图原样返回', () => {
    const flowchart = 'flowchart LR\n  A --> B'
    expect(injectC4Layout(flowchart)).toBe(flowchart)
    const seq = 'sequenceDiagram\n  A->>B: hi'
    expect(injectC4Layout(seq)).toBe(seq)
  })

  it('作者已写 UpdateLayoutConfig 时不覆盖', () => {
    const authored = bigC4 + '\n  UpdateLayoutConfig($c4ShapeInRow="2")'
    expect(injectC4Layout(authored)).toBe(authored)
  })

  it('覆盖全部 C4 类型（Context/Container/Component/Dynamic/Deployment）', () => {
    for (const kind of ['C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment']) {
      const src = `${kind}\n  Person(u, "用户", "使用")\n  Rel(u, u, "自")`
      expect(injectC4Layout(src), kind).toContain('UpdateLayoutConfig')
    }
  })
})
