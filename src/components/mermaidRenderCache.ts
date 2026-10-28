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
 * 为 C4 图自动补一条 `UpdateLayoutConfig`。
 *
 * ## 为什么需要
 *
 * Pele 的 C4 布局内部默认 `shapeInRow = 4`（见其 c4 实现），也就是**每行
 * 固定排 4 个元素**。元素一多（典型的容器图有 10+ 个），这个密度会把
 * 长链路硬压成 4 列，连线只能绕行、大量穿过无关节点 —— 实测 15 个节点的
 * 电商容器图有 8 条连线直接穿过节点框，整张图糊成一团。
 *
 * 实测同一张图的对比（连线穿过节点数）：
 *
 *   shapeInRow=4（默认）  1296×854    8 条穿过  ❌
 *   shapeInRow=3          1025×1052   0 条穿过  ✅
 *   shapeInRow=2           778×1650   0 条穿过  ✅（但过高）
 *   shapeInRow=5          1632×878   11 条穿过  ❌
 *
 * 所以按节点规模选列数：节点少时保持宽扁（好看），节点多时降列数换取
 * 连线清晰（能看）。这是「排版密度」的取舍，不是「越多越宽越好」。
 *
 * ## 为什么改源码而不是 render 选项
 *
 * Pele 只从**源码里的 `UpdateLayoutConfig(...)`** 读取这两个值；
 * `render(code, { config: { c4ShapeInRow } })` 实测无效（不报错，被忽略）。
 *
 * ## 边界
 *
 * - 只处理 C4 系（Context/Container/Component/Dynamic/Deployment），其他图不动
 * - 作者已写 `UpdateLayoutConfig` 时原样尊重，不覆盖
 * - 解析失败就原样返回，让 render 自己报错，不掩盖真实问题
 */
export function injectC4Layout(source: string): string {
  if (!/^\s*C4(?:Context|Container|Component|Dynamic|Deployment)\b/.test(source)) return source
  // 作者已显式指定布局 → 尊重
  if (/UpdateLayoutConfig\s*\(/i.test(source)) return source

  /**
   * 统计「元素」与「关系」规模。
   *
   * 元素关键字：Person / System / Container / Component / Node / Database
   * 及其 `_Ext` / `_Db` 等变体（C4 里都是这些前缀开头）。
   * 关系是 Rel / BiRel / Rel_Up / Rel_Back 等。
   */
  const elementCount = (
    source.match(/^\s*(?:Person|System|Container|Component|Node|Database|Enterprise|Boundary)\w*\s*\(/gm) || []
  ).length
  const relCount = (source.match(/^\s*(?:Bi)?Rel(?:_\w+)?\s*\(/gm) || []).length

  /**
   * 列数选择。
   *
   * 元素少（<=6）保持默认 4 列：宽扁的图更好看，且元素少时不会拥挤。
   * 元素多则降到 3 列：实测这是「连线不穿节点」与「不过分细长」的平衡点。
   * 关系特别密集（>20）再降到 2 列，用高度换清晰度。
   */
  let columns = 4
  if (elementCount > 6) columns = 3
  if (relCount > 20) columns = 2

  return `${source.replace(/\s*$/, '')}\n  UpdateLayoutConfig($c4ShapeInRow="${columns}", $c4BoundaryInRow="1")`
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
  const result: RenderResult = render(injectC4Layout(code), {
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
 * ⚠️ 必须含宽度：Pele 按 maxWidth 决定布局，同一份源码在不同宽度下产出
 * **不同的 SVG**。只按 code 缓存会让第一次渲染的布局永久生效
 * —— 实测先窄屏打开、再回到宽屏，图表一直是竖版。
 *
 * ## 为什么不是简单地「按像素」
 *
 * 每像素都进键会让拖拽窗口时疯狂重渲染。这里按**布局档**分：
 *
 *   - `narrow`    < 640px   竖排布局
 *   - `wide`      640..1199 常规横向
 *   - `full`      >= 1200   大屏 / 全屏
 *
 * `full` 单独成档是必要的：全屏时容器约 1500px，若与 `wide` 共用键，
 * 会直接命中内嵌那份按 640px 渲染的窄图 —— 表现为「全屏里图只占中间一小块，
 * 两边大片空白」（实测全屏 1600px 容器里图只有 863px 宽）。
 */
export function mermaidCacheKey(code: string, maxWidth?: number): string {
  const bucket =
    maxWidth == null || maxWidth <= 0
      ? 'auto'
      : maxWidth < 640
        ? 'narrow'
        : maxWidth < 1200
          ? 'wide'
          : 'full'
  return `${bucket}:${code}`
}
