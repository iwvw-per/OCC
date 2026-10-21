// ============================================
// Per-Server Keys —— 按服务器隔离的键登记表
// ============================================
//
// 历史上 `serverStorage.get/set/getJSON/setJSON/remove` 会隐式取「当前活动
// 服务器」拼前缀，导致：
//   - 读一个桶、写另一个桶（切换主机时的经典数据丢失）
//   - 调用方看不出这份数据属于哪台服务器
//
// 现在所有键必须在这里登记，读写一律显式传 serverId；`scope: 'global'` 的
// 键（如已读水位）不参与分桶。新增键必须显式登记，否则运行时抛错 ——
// 把「意外写错桶」从静默 bug 变成编译/运行期可见的错误。

export type KeyScope = 'server' | 'global'

interface KeySpec {
  scope: KeyScope
  /** 简短说明：这份数据是什么、为什么这么分桶 */
  note: string
}

/**
 * 键登记表。键名即实际存储键（server scope 会自动加 `srv:{serverId}:` 前缀）。
 */
export const PER_SERVER_KEYS = {
  // ---- 服务器 scope（每台主机一份） ----
  'opencode-saved-directories': { scope: 'server', note: '项目列表' },
  'opencode-recent-projects': { scope: 'server', note: '项目最近使用时间' },
  'opencode-hidden-projects': {
    scope: 'server',
    note: '用户主动隐藏的派生项目目录（服务器当前 worktree 自动置顶的那类，删不掉但可以隐藏）',
  },
  'opencode-pinned-sessions': { scope: 'server', note: '置顶会话' },
  'opencode-pinned-messages': { scope: 'server', note: '置顶消息' },
  'opencode-auto-approve-settings': { scope: 'server', note: '自动批准开关' },
  'ai-rename-model': { scope: 'server', note: 'AI 重命名偏好模型' },
  'model-usage-stats': { scope: 'server', note: '模型使用次数' },
  'model-variant-prefs': { scope: 'server', note: '模型 variant 偏好' },
  'session-model-selection': { scope: 'server', note: '会话级模型选择' },
  'model-pinned': { scope: 'server', note: '置顶模型' },
  'hidden-model-keys': { scope: 'server', note: '隐藏的模型' },
  'last-directory': { scope: 'server', note: '上次打开的目录' },
  'selected-model-key': { scope: 'server', note: '选中的模型' },
  'selected-agent': { scope: 'server', note: '选中的 agent（按 pane 后缀）' },
  'opencode-path-mode': { scope: 'server', note: '路径风格（auto/unix/windows）' },
  'opencode-detected-path-style': { scope: 'server', note: '探测到的路径风格' },
  'opencode-project-id': { scope: 'server', note: '上次选中的项目 id' },
  'opencode-scheduled-tasks': { scope: 'server', note: '定时任务' },
  'opencode-turn-outline': { scope: 'server', note: '回合大纲缓存' },
  'lightweight-support': { scope: 'server', note: '该服务器是否支持轻量投影' },

  // ---- global scope（跨服务器共享） ----
  'opencode-read-watermarks': { scope: 'global', note: '已读水位（同一后端多个前缀不能分叉）' },
  'opencode-project-last-used': { scope: 'global', note: '项目最后活跃时间' },
} as const satisfies Record<string, KeySpec>

export type RegisteredKey = keyof typeof PER_SERVER_KEYS

export function isRegisteredKey(key: string): key is RegisteredKey {
  return Object.prototype.hasOwnProperty.call(PER_SERVER_KEYS, key)
}

/** 实际存储键：server scope 加前缀，global 原样 */
export function storageKeyOf(key: string, serverId: string): string {
  const spec = (PER_SERVER_KEYS as Record<string, KeySpec>)[key]
  if (!spec) throw new Error(`未登记的 per-server 键：${key}（请在 PER_SERVER_KEYS 中声明）`)
  return spec.scope === 'global' ? key : `srv:${serverId}:${key}`
}
