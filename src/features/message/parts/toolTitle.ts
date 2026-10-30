import type { ToolPart } from '../../../types/message'

/**
 * 工具行参数胶囊的文案。
 *
 * 历史：v1 的服务端在 `state.title` 里给了每个工具的关键参数（read/edit/write 是
 * 文件路径、grep/glob 是搜索词、webfetch 是 URL、bash 是命令），前端直接展示即可。
 * 迁移到 v2 后实测 `session_message` 里**所有工具都没有 title**（读、写、搜、shell
 * 全为空），于是工具行退化成只剩动作名 —— 「Read」「Edit」「Grep」三行一模一样，
 * 看不出作用在哪个文件上。
 *
 * 所以这里按「服务端 title → 显式 description → input 里的关键字段」兜底，
 * 字段优先级与 v1 的 title 语义保持一致（搜索类给搜索词而不是搜索根目录）。
 */

export interface ToolTitle {
  /** 展示文本。文件路径会转成相对会话目录的形式 */
  text: string
  /** 悬停提示用的完整文本（原绝对路径）。与 text 相同时省略 */
  full?: string
}

const EMPTY: ToolTitle = { text: '' }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 判断是否像文件/目录路径（含分隔符，或是盘符开头） */
function looksLikePath(text: string): boolean {
  return /[/\\]/.test(text) || /^[a-zA-Z]:/.test(text)
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 把绝对路径转成相对 `directory` 的展示路径；不在该目录下则原样返回。
 *
 * 只对「确实以目录开头」的路径做裁剪，不做 `..` 上溯 —— 工具行需要的是
 * 「哪个文件」，而 `../../x` 这种反而更难读。大小写不敏感只用于 Windows 盘符路径，
 * 避免在大小写敏感的 Linux 上把 `/opt/code/OCC` 和 `/opt/code/occ` 混为一谈。
 */
export function relativeToDirectory(path: string, directory?: string): string {
  const base = directory?.trim()
  if (!base) return path

  const normalizedPath = normalizeSlashes(path)
  const normalizedBase = normalizeSlashes(base).replace(/\/+$/, '')
  if (!normalizedBase) return path

  const prefix = `${normalizedBase}/`
  const isWindowsDrive = /^[a-zA-Z]:\//.test(normalizedPath)
  const matched = isWindowsDrive
    ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedPath.startsWith(prefix)
  if (!matched) return path

  const rest = normalizedPath.slice(prefix.length)
  // 用原路径的分隔符风格重建，Windows 路径仍显示反斜杠
  return path.includes('\\') ? rest.replace(/\//g, '\\') : rest
}

/** 从 input 里挑出最有信息量的那个参数（顺序即优先级） */
function pickInputTitle(input: Record<string, unknown>): string | undefined {
  return (
    nonEmptyString(input.description) ||
    // 搜索类：搜索词比搜索根目录更能说明「在找什么」
    nonEmptyString(input.pattern) ||
    nonEmptyString(input.url) ||
    // 文件类：v2 用 path，v1 用 filePath
    nonEmptyString(input.path) ||
    nonEmptyString(input.filePath) ||
    nonEmptyString(input.command)
  )
}

/**
 * 解析工具行的参数文案。
 *
 * @param directory 会话工作目录，用于把绝对路径裁成相对路径
 */
export function getToolTitle(part: ToolPart, directory?: string): ToolTitle {
  const { state } = part
  const raw = nonEmptyString(state.title) || pickInputTitle(asRecord(state.input) ?? {})
  if (!raw) return EMPTY

  if (!looksLikePath(raw)) return { text: raw }

  const text = relativeToDirectory(raw, directory)
  return text === raw ? { text } : { text, full: raw }
}
