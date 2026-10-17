// ============================================
// Directory Path Utilities
// 统一的目录路径处理工具
// ============================================
//
// 设计原则：
// 1. 前端内部存储：统一使用正斜杠 (URL友好，跨平台)
// 2. 后端 API 请求：根据 pathMode 决定用正斜杠还是反斜杠
// 3. 路径比较：统一规范化后比较（正斜杠 + 小写 + 无末尾斜杠）
//

import { serverStorage } from './perServerStorage'
import { serverStore } from '../store/serverStore'

// ============================================
// Path Mode Configuration
// ============================================

/**
 * 路径模式
 * - auto: 自动检测（根据后端响应判断）
 * - unix: 强制使用正斜杠 /
 * - windows: 强制使用反斜杠 \
 */
export type PathMode = 'auto' | 'unix' | 'windows'

/**
 * 检测到的实际路径风格
 */
export type DetectedPathStyle = 'unix' | 'windows'

const STORAGE_KEY_PATH_MODE = 'opencode-path-mode'
const STORAGE_KEY_DETECTED_STYLE = 'opencode-detected-path-style'

let _pathMode: PathMode | null = null
// 检测结果按服务器缓存（多服务器连不同操作系统时互不干扰）
const _detectedStyleByServer = new Map<string, DetectedPathStyle>()

/**
 * 重置路径模式缓存（服务器切换时调用）
 * 下次 getPathMode / getDetectedPathStyle 会从 serverStorage 重新读取
 */
export function resetPathModeCache(): void {
  _pathMode = null
  _detectedStyleByServer.clear()
}

// Path mode change listeners
type PathModeListener = (mode: PathMode, effectiveStyle: DetectedPathStyle) => void
const _listeners: Set<PathModeListener> = new Set()

/**
 * 订阅路径模式变化
 */
export function subscribePathMode(listener: PathModeListener): () => void {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

/**
 * 通知所有监听器
 */
function notifyListeners(): void {
  const mode = getPathMode()
  const style = getEffectivePathStyle()
  _listeners.forEach(listener => listener(mode, style))
}

/**
 * 获取当前路径模式设置
 */
export function getPathMode(): PathMode {
  if (_pathMode === null) {
    try {
      const saved = serverStorage.get(STORAGE_KEY_PATH_MODE)
      if (saved === 'unix' || saved === 'windows') {
        _pathMode = saved
      } else {
        _pathMode = 'auto' // 默认自动检测
      }
    } catch {
      _pathMode = 'auto'
    }
  }
  return _pathMode
}

/**
 * 设置路径模式
 */
export function setPathMode(mode: PathMode): void {
  _pathMode = mode
  try {
    serverStorage.set(STORAGE_KEY_PATH_MODE, mode)
  } catch {
    // ignore
  }
  notifyListeners()
}

/**
 * 获取检测到的路径风格（按服务器）
 * @param serverId 指定服务器（缺省用活动服务器）
 */
export function getDetectedPathStyle(serverId?: string): DetectedPathStyle {
  const sid = serverId ?? serverStore.getActiveServerId()
  const cached = _detectedStyleByServer.get(sid)
  if (cached) return cached
  try {
    // serverStorage 按服务器隔离（srv:{serverId}:{key}）
    const saved = serverStorage.getFor(STORAGE_KEY_DETECTED_STYLE, sid)
    const style = saved === 'windows' ? ('windows' as const) : ('unix' as const)
    _detectedStyleByServer.set(sid, style)
    return style
  } catch {
    _detectedStyleByServer.set(sid, 'unix')
    return 'unix'
  }
}

/**
 * 设置检测到的路径风格（由自动检测逻辑调用，按服务器记录）
 */
export function setDetectedPathStyle(style: DetectedPathStyle, serverId?: string): void {
  const sid = serverId ?? serverStore.getActiveServerId()
  const previousStyle = _detectedStyleByServer.get(sid)
  _detectedStyleByServer.set(sid, style)
  try {
    serverStorage.setFor(STORAGE_KEY_DETECTED_STYLE, style, sid)
  } catch {
    // ignore
  }
  // 只在 auto 模式且风格变化时通知（活动服务器视角）
  if (getPathMode() === 'auto' && previousStyle !== style) {
    notifyListeners()
  }
}

/**
 * 获取实际生效的路径风格（按服务器）
 * - auto：按该服务器各自检测的结果（本地 Windows + 远程 Linux 混用时不冲突）
 * - 显式指定 unix / windows：尊重用户选择
 *
 * 注意：现在始终连接多台服务器，跨服务器风格差异是常态。用户显式指定时仍按
 * 指定值走（那是明确的偏好），auto 时才按每台服务器各自的检测结果。
 */
export function getEffectivePathStyle(serverId?: string): DetectedPathStyle {
  const mode = getPathMode()
  if (mode === 'auto') {
    return getDetectedPathStyle(serverId)
  }
  return mode
}

/**
 * 是否为 Windows 路径模式（实际生效的，按服务器）
 */
export function isWindowsPathMode(serverId?: string): boolean {
  return getEffectivePathStyle(serverId) === 'windows'
}

/**
 * 根据当前模式格式化路径用于 API 请求（按服务器）
 * - unix 模式: 转正斜杠
 * - windows 模式: 转反斜杠
 * @param serverId 目标服务器（缺省用活动服务器）；多服务器连不同操作系统时必须传，
 *                否则按本地探测的全局风格转换导致远端服务器收到错误斜杠的路径
 */
export function formatPathForApi(dir: string | undefined | null, serverId?: string): string | undefined {
  if (!dir) return undefined

  let trimmed = dir.replace(/[/\\]+$/, '') // 移除末尾斜杠

  // 根路径保护：/ → ""，C:/ → "C:"，需要恢复斜杠
  if (!trimmed) {
    trimmed = '/'
  } else if (/^[a-zA-Z]:$/.test(trimmed)) {
    trimmed = trimmed + '/'
  }

  // Unix 绝对路径永远不能被转成反斜杠：\opt\code\OCC 不是合法路径，
  // 后端会报 LocationNotFoundError。这通常发生在多服务器场景下「风格判定
  // 走到了另一台 Windows 主机」时，这里兜底保住原样。
  if (trimmed.startsWith('/')) return trimmed

  const style = getEffectivePathStyle(serverId)
  if (style === 'windows') {
    // 已是 Windows 反斜杠形式时原样返回，避免「规范化→再反斜杠」的无谓往返，
    // 也保证同一输入多次调用的输出稳定。
    if (trimmed.includes('\\') && !trimmed.includes('/')) return trimmed
    return trimmed.replace(/\//g, '\\')
  }
  // unix：已是正斜杠形式时原样返回
  if (!trimmed.includes('\\')) return trimmed
  return trimmed.replace(/\\/g, '/')
}

/**
 * 生成「与线上传输格式无关」的目录缓存键。
 *
 * formatPathForApi 的结果取决于 pathMode，而 auto 模式下检测结果可能在请求
 * 过程中发生变化（首个响应带反斜杠就会把风格切成 windows）。若直接把它的
 * 输出拼进缓存/去重 key，同一目录会在切换前后算出两个 key，导致缓存全部失配、
 * 同一请求被并发发两次（实测 /command、/file 各发 2 次，首屏合计多出数百 ms）。
 *
 * 这里统一用正斜杠 + 去末尾斜杠，并保留大小写（大小写敏感后端上不能合并）。
 * 仅用于 key，不要用于请求参数。
 */
export function directoryCacheKey(dir: string | undefined | null): string {
  return normalizeToForwardSlash(dir)
}

/**
 * 从后端响应中检测路径风格
 * 分析路径字符串，判断后端使用的是哪种斜杠风格
 */
export function detectPathStyleFromResponse(path: string | undefined | null): DetectedPathStyle | null {
  if (!path) return null

  const backslashCount = (path.match(/\\/g) || []).length
  const forwardSlashCount = (path.match(/\//g) || []).length

  // 如果有反斜杠且多于正斜杠，判定为 Windows 风格
  if (backslashCount > 0 && backslashCount >= forwardSlashCount) {
    return 'windows'
  }
  // 如果有正斜杠，判定为 Unix 风格
  if (forwardSlashCount > 0) {
    return 'unix'
  }

  return null
}

/**
 * 自动检测并更新路径风格（按服务器记录检测结果）
 * 调用此函数时传入后端返回的路径，会自动更新检测结果
 */
export function autoDetectPathStyle(path: string | undefined | null, serverId?: string): void {
  const detected = detectPathStyleFromResponse(path)
  if (detected) {
    setDetectedPathStyle(detected, serverId)
  }
}

// ============================================
// Path Normalization (Internal Use)
// ============================================

/**
 * 规范化目录路径为正斜杠格式
 * 用于前端内部存储和 URL
 *
 * @example
 * normalizeToForwardSlash('E:\\dev\\project') // 'E:/dev/project'
 * normalizeToForwardSlash('E:/dev/project/') // 'E:/dev/project'
 */
export function normalizeToForwardSlash(dir: string | undefined | null): string {
  if (!dir) return ''
  return dir
    .replace(/\\/g, '/') // 反斜杠 → 正斜杠
    .replace(/\/+$/, '') // 移除末尾斜杠
}

/**
 * 判断路径是否为绝对路径。
 *
 * 后端（尤其 opencode v2）只接受绝对路径作为 location/项目目录，相对路径
 * （如 `../code/OCC`）会在请求时被拒绝。这里统一按两种平台判断：
 * - Unix：以 `/` 开头
 * - Windows：`C:/` 或 `C:\` 开头（也接受 `\\server` UNC 的等价正斜杠形式）
 */
export function isAbsoluteDirectory(dir: string | undefined | null): boolean {
  if (!dir) return false
  if (dir.startsWith('/')) return true
  return /^[a-zA-Z]:[\\/]/.test(dir)
}

/**
 * 把 `..`、`.` 段折叠掉的纯字符串路径归一化（不访问文件系统）。
 * 用于用户手输路径时展示/落库前消除 `..`，避免把相对路径原样存成项目。
 *
 * - Unix：`/a/../b` → `/b`；已到根时忽略多余 `..`
 * - Windows：`C:/a/../b` → `C:/b`
 */
export function collapseDotSegments(dir: string | undefined | null): string {
  if (!dir) return ''
  const normalized = dir.replace(/\\/g, '/')
  const hasRoot = normalized.startsWith('/')
  const driveMatch = normalized.match(/^([a-zA-Z]:)/)
  const drive = driveMatch ? driveMatch[1] : ''
  const rest = drive ? normalized.slice(drive.length) : normalized
  const parts = rest.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!hasRoot && !drive) stack.push('..')
      continue
    }
    stack.push(part)
  }
  const joined = stack.join('/')
  if (drive) return joined ? `${drive}/${joined}` : `${drive}/`
  if (hasRoot) return joined ? `/${joined}` : '/'
  return joined
}

/**
 * 规范化目录路径用于比较
 * - 统一使用正斜杠
 * - 移除末尾斜杠
 * - 转小写（Windows 路径不区分大小写）
 *
 * @example
 * normalizeForComparison('E:\\Dev\\Project') // 'e:/dev/project'
 */
export function normalizeForComparison(dir: string | undefined | null): string {
  if (!dir) return ''
  return dir
    .replace(/\\/g, '/') // 反斜杠 → 正斜杠
    .replace(/\/+$/, '') // 移除末尾斜杠
    .toLowerCase() // Windows 路径不区分大小写
}

/**
 * 比较两个目录路径是否相同
 * 处理斜杠、大小写差异
 *
 * @example
 * isSameDirectory('E:\\dev\\project', 'E:/dev/project') // true
 * isSameDirectory('E:/Dev/Project', 'e:/dev/project') // true
 */
export function isSameDirectory(dir1: string | undefined | null, dir2: string | undefined | null): boolean {
  return normalizeForComparison(dir1) === normalizeForComparison(dir2)
}

/**
 * 从路径中提取目录名（最后一个部分）
 *
 * @example
 * getDirectoryName('E:/dev/my-project') // 'my-project'
 * getDirectoryName('E:\\dev\\my-project\\') // 'my-project'
 */
export function getDirectoryName(dir: string | undefined | null): string {
  if (!dir) return ''
  const normalized = normalizeToForwardSlash(dir)
  const parts = normalized.split('/').filter(Boolean)
  const name = parts[parts.length - 1] || normalized
  // 解码 URL 编码的中文等字符
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * 检查路径是否是 Windows 绝对路径
 *
 * @example
 * isWindowsAbsolutePath('E:/dev') // true
 * isWindowsAbsolutePath('/home/user') // false
 */
export function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path)
}

// ============================================
// Re-export from stringUtils for compatibility
// ============================================

// 保持向后兼容，逐步废弃 stringUtils 中的目录函数
export { normalizeForComparison as normalizeDirectoryPath }
