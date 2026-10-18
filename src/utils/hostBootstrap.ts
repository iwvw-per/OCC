// ============================================
// 启动期注入的宿主上下文（首屏状态前置）
//
// 参考 OpenCode Desktop：主进程在创建窗口时就把「窗口 id / 首启标记」通过
// 启动参数注入，渲染进程第一帧就能读到，不必等 IPC 通道建立，也不用先渲染
// 再补一次状态（那会有一帧闪）。
//
// 浏览器里没有宿主进程，读取时退化为「无注入」，调用方按默认值走。
// ============================================

export interface HostBootstrap {
  /** 窗口/标签页标识；多窗口桌面端用它区分各自的快照 */
  windowId?: string
  /** 是否首次启动（首次启动时跳过恢复上次路由） */
  firstLaunch?: boolean
  /** 宿主平台标识，便于排查 */
  host?: 'tauri' | 'web'
}

/** 宿主注入用的全局变量名（由 Tauri 端在初始化脚本里写入）。 */
const BOOTSTRAP_GLOBAL = '__OCC_BOOTSTRAP__'

/** 读取宿主注入的启动上下文；没有注入时返回空对象。 */
export function readHostBootstrap(): HostBootstrap {
  if (typeof window === 'undefined') return {}
  const injected = (window as unknown as Record<string, unknown>)[BOOTSTRAP_GLOBAL]
  if (!injected || typeof injected !== 'object') return {}
  const raw = injected as Record<string, unknown>

  return {
    windowId: typeof raw.windowId === 'string' && raw.windowId ? raw.windowId : undefined,
    firstLaunch: raw.firstLaunch === true ? true : raw.firstLaunch === false ? false : undefined,
    host: raw.host === 'tauri' || raw.host === 'web' ? raw.host : undefined,
  }
}

/**
 * 当前窗口的持久化命名空间。
 *
 * 多窗口场景下「上次路由」「窗口尺寸」这类状态必须按窗口隔离，否则两个窗口
 * 会互相覆盖。浏览器里没有窗口概念，统一用 `main`。
 */
export function windowNamespace(): string {
  const { windowId } = readHostBootstrap()
  const raw = windowId ?? 'main'
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-')
}

/** 按窗口隔离的 localStorage 键。 */
export function windowScopedKey(name: string): string {
  return `occ.window.${windowNamespace()}.${name}`
}
