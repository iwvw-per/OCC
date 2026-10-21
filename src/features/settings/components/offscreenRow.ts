// ============================================
// 列表行的渲染节流样式
// ============================================

/**
 * 长内容渲染节流：为离屏的列表/树节点声明「跳过渲染」。
 *
 * `content-visibility: auto` 让浏览器在元素离开视口后跳过布局与绘制；
 * `contain-intrinsic-size` 给出占位高度，避免滚动条跳动。列表项都是等高行，
 * 因此可以直接用行高估个值——它只影响未测量前的滚动条长度。
 */
export const offscreenRowStyle = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 32px',
} as const
