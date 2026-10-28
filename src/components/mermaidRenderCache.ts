// ============================================
// Mermaid 语法渲染（Pele）
//
// 用 Pele 渲染 Mermaid 语法为 SVG。相比原先的 mermaid.js：
//   - 零依赖、体积小（gzip 267KB vs 全量约 880KB，省掉 cytoscape 424KB）
//   - 主题用 CSS 变量：切换暗色/亮色**不重渲染**，只换 CSS 变量值
//   - 窄屏自适应：maxWidth + autoDirection，flowchart 会自动从 LR 转 TB
//
// ⚠️ Pele 用自己的布局引擎，节点位置/间距/连线路径与 mermaid.js 不同。
// 这是有意接受的视觉变化 —— 换来的是体积、性能和移动端可读性。
//
// ⚠️ 不支持 ZenUML 等外部插件；HTML 标签不支持（仅 SVG text，支持换行/粗斜体）。
// ============================================

import type { RenderResult } from 'pele'

/**
 * 渲染缓存。
 *
 * 键含宽度分档（见 `mermaidCacheKey`），因为同一份源码在宽/窄屏下产出不同布局。
 * 主题**不进键**：Pele 用 CSS 变量着色，同一份 SVG 在亮/暗色下都成立。
 */
const MERMAID_CACHE_MAX = 64
const svgCache = new Map<string, string>()
const pendingRenders = new Map<string, Promise<string>>()
/**
 * 渲染串行队列。
 *
 * Pele 的 render() 是同步的，但首次调用要初始化各图表类型的解析器；
 * 连续渲染多个图时串行化能避免重复初始化，也让缓存写入顺序稳定。
 */
let renderQueue: Promise<void> = Promise.resolve()

export function getCachedMermaidSvg(key: string) {
  return svgCache.get(key)
}

export async function getOrRenderMermaidSvg(key: string, render: () => Promise<string>) {
  const cached = svgCache.get(key)
  if (cached !== undefined) return cached

  const pending = pendingRenders.get(key)
  if (pending) return pending

  const promise = renderQueue.then(render, render).then(svg => {
    if (svgCache.size >= MERMAID_CACHE_MAX) {
      const firstKey = svgCache.keys().next().value
      if (firstKey !== undefined) svgCache.delete(firstKey)
    }
    svgCache.set(key, svg)
    return svg
  })
  renderQueue = promise.then(
    () => undefined,
    () => undefined,
  )

  pendingRenders.set(key, promise)
  try {
    return await promise
  } finally {
    pendingRenders.delete(key)
  }
}

export function clearMermaidRenderCache() {
  svgCache.clear()
  pendingRenders.clear()
}

/**
 * 渲染 Mermaid 语法为 SVG 字符串。
 *
 * @param code Mermaid 源码
 * @param idPrefix 每个图表的唯一前缀，避免同页多图共享 SVG id（渐变、箭头 marker 等）
 * @param maxWidth 容器可用宽度，用于窄屏自适应布局；缺省不做自适应
 */
export async function renderMermaidToSvg(
  code: string,
  idPrefix: string,
  maxWidth?: number,
): Promise<string> {
  const { render } = await import('pele')
  const result: RenderResult = render(code, {
    idPrefix,
    /**
     * 宽度自适应。
     *
     * Pele 在 `maxWidth < directionBreakpoint` 时会把支持的图（如 flowchart）
     * 从横向转成竖向 —— 窄屏下比「整体等比缩小」可读性好得多。
     *
     * ⚠️ 必须用**实际可用宽度**，不能传 0 或很小的值：那会被当成极窄屏，
     * 宽屏下也渲染成竖版（实测容器 640px 却渲染成 194×513）。
     */
    ...(maxWidth != null && maxWidth > 0
      ? { maxWidth, autoDirection: true, directionBreakpoint: 640 }
      : {}),
    /**
     * 安全：不允许图表触发网络请求。
     *
     * 图表源码来自模型输出，属于不可信内容。图片会发起真实请求（可被用作
     * 探测/跟踪），链接则可能诱导点击。OCC 的图表只用于表达结构，两者都不需要。
     */
    links: false,
    images: false,
  })
  return result.svg
}

/**
 * 渲染缓存键。
 *
 * ⚠️ 必须含宽度分档：Pele 按 maxWidth 决定横/竖布局，同一份源码在宽屏和
 * 窄屏下产出**不同的 SVG**。只按 code 缓存会让第一次渲染的布局永久生效
 * —— 实测先窄屏打开、再回到宽屏，图表一直是竖版。
 *
 * 按方向分档而不是按像素：布局只在跨越 directionBreakpoint 时改变，
 * 同一档内复用可以显著提高命中率。
 */
export function mermaidCacheKey(code: string, maxWidth?: number): string {
  const bucket = maxWidth == null || maxWidth <= 0 ? 'auto' : maxWidth < 640 ? 'narrow' : 'wide'
  return `${bucket}:${code}`
}
