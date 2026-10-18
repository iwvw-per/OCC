// ============================================
// PTY WebSocket 握手凭据
//
// 浏览器原生 WebSocket 不能自定义请求头，因此鉴权只能放进 URL。历史做法是把
// `base64(user:password)` 拼进 `auth_token` 查询参数；这会把**长期密码**写进：
//   - 服务器/网关访问日志
//   - 浏览器历史与书签
//   - 任何记录 URL 的错误上报
//
// 现在统一改成一次性短令牌：
//   - 远程网关（API Monitor）：`POST /stream-token` 换 `st`，30 秒有效且消费一次；
//   - 直连 opencode（Basic 认证）：`GET /api/server/token` 换 `st`，同样一次性；
//   - 本地无鉴权服务器：不带任何凭据。
//
// `auth_token` 与 URL userinfo 仅作为「服务端不支持短令牌」时的兜底保留，
// 由调用方显式开启（`allowPasswordFallback`），默认不启用。
// ============================================

/** URL 里是否残留了长期凭据（用于断言与回归检查）。 */
export function hasLongLivedCredentials(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('auth_token')) return true
    // userinfo（https://user:pass@host/...）同样是长期凭据
    return parsed.username !== '' || parsed.password !== ''
  } catch {
    return false
  }
}
