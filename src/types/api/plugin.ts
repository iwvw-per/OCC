// ============================================
// 插件运行时状态（v2 `plugin.list`）
// ============================================
//
// 注意区分两处「插件」：
//   - 设置页里的 `plugins` 段编辑的是 **配置声明**（opencode.json 的 plugin 字段），
//     不反映运行时是否加载成功；
//   - 这里的 `PluginStatus` 来自服务端 `plugin.list`，是**实际加载结果**，
//     失败的插件会带 error 与出错位置（ref）。
//
// 面板只关心后者：配置文件写得对不对，用户看面板一眼就知道。

/** 插件来源。builtin 是服务端内置插件，占绝大多数（本机实测 93 个里 90 个） */
export interface PluginSourceInfo {
  type: 'builtin' | 'package' | 'local' | 'sdk'
  /** type=package：包名 */
  target?: string
  /** type=package：已安装版本 */
  version?: string
  /** type=package：有新版本可更新 */
  outdated?: boolean
  /** type=package：正在更新 */
  updating?: boolean
  /** type=local：本地插件文件路径 */
  path?: string
}

export interface PluginFeaturesInfo {
  server?: boolean
  tui?: boolean
  rpc?: boolean
}

/**
 * 加载结果。
 *
 * `failed` 一定带 `error`；`ref` 是服务端给出的定位信息（多为插件文件路径），
 * 可直接当作悬停提示，比只显示「失败」有用得多。
 */
export type PluginStateInfo =
  | { status: 'active' }
  | { status: 'failed'; error: string; ref?: string }

export interface PluginStatus {
  /** 插件 id；服务端可能缺省（见 adaptPluginList 的兜底） */
  id: string
  source: PluginSourceInfo
  features: PluginFeaturesInfo
  state: PluginStateInfo
}
