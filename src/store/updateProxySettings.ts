import { z } from 'zod'
import { createStore } from '../storage/createStore'

/**
 * 更新线路（下载加速代理）的持久化偏好。
 *
 * 为什么单独一个 store：和「自动更新开关」一样，这属于**应用**而不是某台服务器的
 * 设置（更新的是客户端本体），因此用 global scope，不随服务器切换变化。
 *
 * 背景：国内直连 `github.com` / `api.github.com` / `objects.githubusercontent.com`
 * 经常被墙或极慢，「检查更新」与「安装更新」就表现为一直转圈或莫名报错。这里允许
 * 用户指定一个 GitHub 加速代理，把 release 清单、安装包、APK、Release API 请求
 * 改写为经代理的地址；失败时自动回退到直连与内置镜像（见 updateRoutes.ts）。
 */

/** 内置的可选代理（与社区常用的 GitHub 反代一致，均为「前缀式」：`<代理>/<原始URL>`） */
export const BUILTIN_UPDATE_PROXIES = [
  { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
  { id: 'ghfast.top', prefix: 'https://ghfast.top/' },
] as const

export const UPDATE_PROXY_IDS = ['auto', 'none', ...BUILTIN_UPDATE_PROXIES.map(item => item.id), 'custom'] as const
export type UpdateProxyId = (typeof UPDATE_PROXY_IDS)[number]

const schema = z.object({
  /**
   * 线路选择：
   *   - 'auto'   ：首选直连，失败后依次尝试内置代理（见 updateRoutes.buildRouteChain）
   *   - 'none'   ：只用直连（不需要代理的用户，避免多余请求）
   *   - 内置 id  ：该代理优先，失败后回退直连
   *   - 'custom' ：使用 customPrefix
   */
  proxy: z.enum(UPDATE_PROXY_IDS).default('auto'),
  /**
   * 自定义代理前缀，例如 `https://gh-proxy.com/`。
   * 约定与内置代理一致：最终地址 = `<前缀>https://github.com/...`。
   */
  customPrefix: z.string().default(''),
})

export type UpdateProxySettings = z.infer<typeof schema>

export const updateProxySettingsStore = createStore({
  key: 'opencode-update-proxy-settings',
  scope: { kind: 'global' },
  schema,
  defaultValue: schema.parse({}),
})
