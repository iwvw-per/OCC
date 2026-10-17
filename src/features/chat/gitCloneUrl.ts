// ============================================
// Git clone 输入解析（纯函数，便于单测）
// ============================================

/**
 * 从 git URL 推断默认的克隆目录名。
 *
 * 支持 `https://host/org/repo.git`、`git@host:org/repo.git`、末尾带斜杠等形式；
 * 推断失败返回空串，让用户自己填。
 */
export function inferRepoName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const lastSegment = trimmed.split(/[/:]/).filter(Boolean).pop() ?? ''
  return lastSegment.replace(/\.git$/i, '')
}

/** 校验 git URL：http(s)、ssh、git 协议或 scp 风格的 user@host:path。 */
export function isLikelyGitUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  if (/^(https?|git|ssh):\/\//i.test(value)) return true
  // scp 风格：git@github.com:org/repo.git
  return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value)
}
