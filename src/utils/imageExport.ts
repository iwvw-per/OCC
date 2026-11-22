// ============================================
// imageExport — DOM 节点导出为 PNG
// ============================================
//
// 用 html-to-image 把消息 DOM 渲染成 PNG，便于分享截图。
// 导出前对克隆节点做净化：隐藏操作栏、悬停态等交互元素，避免把按钮
// 也画进图片；并把背景色补上，否则透明背景在浅色/深色环境下看不清。

import { saveData } from './downloadUtils'

/** 导出时从克隆节点移除的元素选择器 */
const STRIP_SELECTORS = [
  '[data-export-hidden]',
  '[data-message-actions]',
  'button[data-compact]',
]

export interface ExportNodeImageOptions {
  fileName: string
  /** 背景色（通常取当前主题背景），缺省用白色 */
  backgroundColor?: string
  /** 设备像素比，默认 2 保证清晰度 */
  pixelRatio?: number
}

function resolveBackground(node: HTMLElement): string {
  const style = getComputedStyle(node)
  const computed = style.backgroundColor
  if (computed && computed !== 'transparent' && computed !== 'rgba(0, 0, 0, 0)') return computed
  // --bg-000 是 HSL 三元组（如 "150 10% 99%"），必须包成 hsl() 才是合法颜色；
  // 直接传给 canvas 的 fillStyle 会被忽略并保持默认黑色，导致导出 PNG 变黑底。
  const raw = style.getPropertyValue('--bg-000').trim()
  return raw ? `hsl(${raw})` : '#ffffff'
}

/** 把节点导出为 PNG 并触发保存 */
export async function exportNodeAsImage(node: HTMLElement, options: ExportNodeImageOptions): Promise<void> {
  const backgroundColor = options.backgroundColor ?? resolveBackground(node)

  // html-to-image 只在「导出为图片」这一用户动作里用得到(约 34KB 源码),
  // 静态导入会让它随消息渲染器进入首屏包。改为动作发生时再按需拉取。
  const { toPng } = await import('html-to-image')
  const dataUrl = await toPng(node, {
    pixelRatio: options.pixelRatio ?? 2,
    backgroundColor,
    cacheBust: true,
    filter: element => {
      if (!(element instanceof HTMLElement)) return true
      return !STRIP_SELECTORS.some(selector => element.matches(selector))
    },
  })

  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const fileName = options.fileName.endsWith('.png') ? options.fileName : `${options.fileName}.png`
  saveData(bytes, fileName, 'image/png')
}
