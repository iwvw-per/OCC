// ============================================
// 凭据注入的可行性边界（对照 OpenCode Desktop 的做法）
//
// 桌面版的通信安全模型：渲染进程只知道服务地址，**永远拿不到密码**；
// 主进程在给 sidecar 的请求上补 Authorization —— 好处是 GET 保持
// CORS-simple，连预检都不需要。
//
// OCC 现状与边界：
//   - 桌面端（Tauri）：请求经 `plugin-http` 从 Rust 侧发出，鉴权头由
//     `buildHeaders()` 在**渲染进程**拼好后传入。也就是说，密码仍然存在于
//     webview 内存里（serverStore 持有），只是不会出现在页面 XSS 可直接读取的
//     DOM/存储明文之外 —— 但 serverStore 本身属于渲染进程，XSS 能读到。
//   - 浏览器端：必须由前端带 Authorization，无法省掉预检。
//
// 要做到「凭据不进渲染进程」，需要把「按 origin 注入鉴权头」下移到 Rust：
//   1. Rust 侧保存服务器凭据（keyring / 加密文件），前端只拿 serverId；
//   2. 自定义一个 protocol handler（如 `occ-net://<serverId>/...`）或在
//      plugin-http 的请求拦截里补头；
//   3. 前端不再调用 buildHeaders，不再从 serverStore 读 password。
//
// 这是一次跨 Web/桌面/Android 的鉴权归属迁移（所有 code path 都要改），
// 影响面与回归成本都高于本轮其它优化，因此单独排期。
// ============================================

export interface CredentialModel {
  /** 凭据在哪个进程里可读 */
  holder: 'renderer' | 'host'
  /** 是否能让 GET 保持 CORS-simple（不带 Authorization） */
  keepsRequestsSimple: boolean
}

/** 当前实现：凭据在渲染进程，每个带鉴权的请求都会触发预检。 */
export const CURRENT_CREDENTIAL_MODEL: CredentialModel = {
  holder: 'renderer',
  keepsRequestsSimple: false,
}

/** 目标实现：凭据由宿主代持，请求不带鉴权头（桌面端）。 */
export const HOST_CREDENTIAL_MODEL: CredentialModel = {
  holder: 'host',
  keepsRequestsSimple: true,
}

/**
 * 当前环境是否具备「凭据不进渲染进程」的条件。
 *
 * 浏览器没有宿主进程，恒为 false；桌面/移动端在完成迁移前同样为 false。
 */
export function supportsHostCredentialInjection(_host: 'tauri' | 'web' | undefined): boolean {
  // 迁移未落地前一律 false，避免调用方提前按「无凭据」处理而拿到 401
  return false
}
