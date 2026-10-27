import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import { i18nReady } from './i18n'
import { initOverlayScrollbars } from './lib/overlayScrollbar'
import App from './App.tsx'
import { TooltipProvider } from './components/ui/Tooltip'
import { DirectoryProvider, FullscreenProvider, SessionProvider } from './contexts'
import { themeStore } from './store/themeStore'
import { serverStore } from './store/serverStore'
import { autoApproveStore } from './store/autoApproveStore'
import { serviceStore } from './store/serviceStore'
import { reconnectSSE, ensureServerSSE } from './api/events'
import { startPreferencesSync } from './api/preferencesSyncEngine'
import { startScheduledTaskScheduler } from './store/scheduledTaskScheduler'
import { abortInFlightApiRequests, getTauriFetch } from './api/sdk'
import { isTauri as isTauriEnv } from './utils/tauri'
import { resetPathModeCache } from './utils/directoryUtils'
import { isTauri, isTauriMobile } from './utils/tauri'
import { apiErrorHandler, globalErrorHandler } from './utils/errorHandling'
import { applyLocalServiceUrl } from './utils/localServiceUrl'
import { preventPageZoom } from './utils/preventPageZoom'

// Polyfill: randomUUID 在非 HTTPS 环境可能缺失（如局域网 HTTP）
// 统一补齐，避免业务层 scattered fallback。
function ensureRandomUUID() {
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return
  if (typeof cryptoObj.randomUUID === 'function') return

  cryptoObj.randomUUID = () => {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    // RFC 4122 v4
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }
}

ensureRandomUUID()

// 禁用浏览器的 scroll restoration（刷新时不恢复旧 scrollTop），
// 由 ChatArea 自行控制定位
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

// 初始化主题系统（在 React 渲染前注入 CSS 变量，避免闪烁）
themeStore.init()

// 全局 overlay 滚动条 — 等 DOM 就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOverlayScrollbars)
} else {
  // DOM 已就绪（defer script 或者 module）
  requestAnimationFrame(initOverlayScrollbars)
}

// 注册 active server 入口变化 → 重建目标服务器的 SDK + 刷新 per-server 配置 + 重连 SSE
serverStore.onServerChange((serverId, reason) => {
  // 只有「端点地址真的变了」才需要取消在途请求。
  //
  // server-switch 只是切换当前查看的主机：多主机模式下每台服务器各有独立 client
  // （getV2Client 显式按 serverId 构造 baseUrl），切换不会让任何在途请求失效。
  // 以前这里对 server-switch 也无条件取消，导致「刚点发送就切主机」时，那条
  // 正在飞往旧主机的 prompt 被 abort —— 用户看到的就是「旧主机没发出去」。
  if (reason === 'local-runtime-url') {
    abortInFlightApiRequests('Server endpoint changed')
  }
  if (isTauriEnv()) {
    void getTauriFetch().catch(err => apiErrorHandler('reinitialize sdk client after server endpoint change', err))
  }

  // 多服务器模式：messageStore / childSessionStore / todoStore 的数据按 `serverId::sessionId`
  // 分片存储，切换 active server 不应清空其他 pane 正在使用的服务器数据，因此不再 clearAll。

  // 重置路径模式缓存（不同服务器可能是不同操作系统）
  resetPathModeCache()

  // 重新加载 auto-approve 开关状态（从新服务器的 storage key 读取）
  autoApproveStore.reloadFromStorage()

  // 重连/建连策略按 reason 分流：
  // - server-switch：只是改「活动服务器」。多服务器模式下每台服务器本来就各有一条常驻
  //   SSE，目标服务器的连接一直是活的，强制重连会让它走 disconnected→connecting→connected，
  //   状态点肉眼可见地闪黄，还会白白广播一次 onReconnected。这里只做幂等 ensure。
  // - local-runtime-url：本地运行时地址真的变了，必须重连才能连到新 endpoint。
  if (reason === 'local-runtime-url') {
    reconnectSSE()
  } else {
    ensureServerSSE(serverId)
  }
})

const isNativeTauri = isTauri()
const isNativeTauriMobile = isNativeTauri && isTauriMobile()

interface StartOpencodeServiceResult {
  started: boolean
  startedByUs: boolean
  url?: string | null
}

function configureNativeShell() {
  if (!isNativeTauri) return

  // 添加 CSS class 用于 safe-area 适配
  document.documentElement.classList.add('tauri-app')

  // 确保 viewport meta 包含 viewport-fit=cover（用于状态栏沉浸式）
  const viewportMeta = document.querySelector('meta[name="viewport"]')
  if (!viewportMeta) return

  const content = viewportMeta.getAttribute('content') || ''
  if (!content.includes('viewport-fit=cover')) {
    viewportMeta.setAttribute('content', content + ', viewport-fit=cover')
  }
}

async function initializeNativeDesktopService() {
  if (!isNativeTauri || isNativeTauriMobile || !serviceStore.autoStart) return

  // 已登录 AI Agent 账号时不再自行拉起本地 opencode：
  // 此时 opencode 由面板 Agent 统一托管（生命周期 + 端口由网关管理），
  // 本应用再拉起一个会在同一端口区间内与其互相抢占/被清理。改为只经网关连接。
  try {
    const { readAccount } = await import('./api/aiagent')
    if (readAccount()) {
      console.info('[Service] AI Agent account detected; skipping local opencode auto-start (gateway-managed)')
      return
    }
  } catch {
    // 账号模块不可用时按原有行为继续
  }

  const serverUrl = serverStore.getLocalServerUrl()
  serviceStore.setStarting(true)

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    try {
      const path = await invoke<string | null>('detect_opencode_binary', { envVars: serviceStore.envVarsRecord })
      serviceStore.setDetectedBinaryPath(path)
    } catch {
      // Starting with PATH fallback is still useful if detection fails.
    }

    const result = await invoke<StartOpencodeServiceResult>('start_opencode_service', {
      url: serverUrl,
      binaryPath: serviceStore.effectiveBinaryPath,
      envVars: serviceStore.envVarsRecord,
    })

    applyLocalServiceUrl(result.url)
    serviceStore.setStartedByUs(result.startedByUs)
    serviceStore.setRunning(true)
    if (result.started) {
      console.info('[Service] opencode serve started by app')
    } else {
      console.info('[Service] opencode serve already running')
    }
  } catch (err) {
    apiErrorHandler('auto-start opencode serve', err)
  } finally {
    serviceStore.setStarting(false)
  }
}

configureNativeShell()

// 全局错误处理 - 防止未捕获错误导致页面刷新
window.addEventListener('error', event => {
  globalErrorHandler('uncaught error', event.error)
  event.preventDefault()
})

window.addEventListener('unhandledrejection', event => {
  globalErrorHandler('unhandled promise rejection', event.reason)
  event.preventDefault()
})

/**
 * i18n 资源现在是按语言懒加载的：en 之外的语言在初始化后才补齐。
 * 必须等资源就绪再挂载 React，否则首帧会把翻译 key 直接渲染出来。
 */
async function bootstrap() {
  await i18nReady.catch(err => globalErrorHandler('initialize i18n', err))
  /**
   * 禁止页面级双指缩放。
   *
   * viewport meta 已经写了 `maximum-scale=1, user-scalable=no`，但 iOS Safari
   * 从 iOS 10 起忽略它，双指仍能放大整个页面（放大后聊天界面错位、
   * 输入框被推出视口）。这里补上事件拦截，见 utils/preventPageZoom。
   */
  preventPageZoom()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <TooltipProvider delayDuration={300}>
          <DirectoryProvider>
            <SessionProvider>
              <FullscreenProvider>
                <App />
              </FullscreenProvider>
            </SessionProvider>
          </DirectoryProvider>
        </TooltipProvider>
      </Suspense>
    </StrictMode>,
  )
}

function startApp() {
  // bootstrap 内部先等 i18n，再渲染；后续启动步骤无需阻塞在语言资源上。
  void bootstrap().catch(err => globalErrorHandler('bootstrap app', err))

  void initializeNativeDesktopService()

  if (isNativeTauri) {
    void getTauriFetch().catch(err => apiErrorHandler('initialize sdk client', err))
  }

  // 多端设置同步：仅在已启用且已登录时启动；未登录时由设置页登录成功后触发。
  void startPreferencesSync().catch(err => apiErrorHandler('start preferences sync', err))

  // 定时任务调度：应用打开期间轮询触发（opencode 无服务端调度接口）
  startScheduledTaskScheduler()
}

startApp()
