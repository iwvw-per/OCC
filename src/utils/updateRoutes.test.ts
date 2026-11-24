import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 更新线路（GitHub 加速代理）的回归保护。
 *
 * 用户反馈「更新总出错」：国内直连 github.com / api.github.com 常被墙。
 * 这里固住三件事：
 * 1. 线路链的顺序符合设置语义（auto = 直连优先；指定代理 = 代理优先）；
 * 2. 地址改写的正确性（前缀式拼接、非 GitHub 地址不动）；
 * 3. **清单里的 asset 地址同步改写** —— 只改清单地址会导致「检查能过、下载必失败」。
 */

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

const { updateProxySettingsStore } = await import('../store/updateProxySettings')
const { buildRouteChain, applyRoute, rewriteManifestUrls, DIRECT_ROUTE, getRouteChain } = await import('./updateRoutes')

const GH = 'https://github.com/iwvw-per/OCC/releases/download/v2.2.17/latest.json'

describe('updateRoutes', () => {
  beforeEach(() => {
    storage.clear()
    updateProxySettingsStore.commit(prev => ({ ...prev, proxy: 'auto', customPrefix: '' }))
  })

  it('auto 模式直连优先，内置代理作为兜底', () => {
    const chain = buildRouteChain({ proxy: 'auto', customPrefix: '' })
    expect(chain[0]).toEqual(DIRECT_ROUTE)
    expect(chain.length).toBeGreaterThan(1)
    // 兜底顺序固定，便于用户按截图里的顺序理解
    expect(chain.slice(1).map(route => route.id)).toEqual(['gh-proxy.com', 'gh-proxy.org', 'ghfast.top'])
  })

  it('none 模式只有直连（不需要代理的用户不产生额外请求）', () => {
    expect(buildRouteChain({ proxy: 'none', customPrefix: '' })).toEqual([DIRECT_ROUTE])
  })

  it('显式代理优先，失败后回退直连', () => {
    const chain = buildRouteChain({ proxy: 'ghfast.top', customPrefix: '' })
    expect(chain[0].id).toBe('ghfast.top')
    expect(chain[1]).toEqual(DIRECT_ROUTE)
  })

  it('自定义前缀会被规范化（补协议与尾斜杠）', () => {
    const chain = buildRouteChain({ proxy: 'custom', customPrefix: 'https://mirror.example.com' })
    expect(chain[0]).toEqual({ id: 'custom', prefix: 'https://mirror.example.com/' })
  })

  it('空的自定义前缀不会产生无效线路', () => {
    const chain = buildRouteChain({ proxy: 'custom', customPrefix: '   ' })
    expect(chain[0]).toEqual(DIRECT_ROUTE)
  })

  it('applyRoute 走直连时原样返回', () => {
    expect(applyRoute(GH, DIRECT_ROUTE)).toBe(GH)
  })

  it('applyRoute 把 GitHub 地址拼到代理前缀后', () => {
    expect(applyRoute(GH, { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' })).toBe(`https://gh-proxy.com/${GH}`)
  })

  it('applyRoute 不改写非 GitHub 地址', () => {
    const url = 'https://example.com/latest.json'
    expect(applyRoute(url, { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' })).toBe(url)
  })

  it('rewriteManifestUrls 同步改写 asset 地址（检查能过但下载失败的关键）', () => {
    const manifest = {
      version: '2.2.17',
      platforms: {
        'windows-x86_64': {
          url: 'https://github.com/iwvw-per/OCC/releases/download/v2.2.17/OCC_2.2.17_x64-setup.exe',
          signature: 'sig-a',
        },
        'darwin-aarch64': {
          url: 'https://github.com/iwvw-per/OCC/releases/download/v2.2.17/OCC_aarch64.app.tar.gz',
          signature: 'sig-b',
        },
      },
    }
    const rewritten = rewriteManifestUrls(manifest, { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' })
    const platforms = rewritten.platforms as Record<string, { url: string; signature: string }>

    expect(platforms['windows-x86_64'].url).toBe(
      'https://gh-proxy.com/https://github.com/iwvw-per/OCC/releases/download/v2.2.17/OCC_2.2.17_x64-setup.exe',
    )
    expect(platforms['darwin-aarch64'].url.startsWith('https://gh-proxy.com/https://github.com/')).toBe(true)
    // 签名针对安装包内容，与地址无关，必须原样保留
    expect(platforms['windows-x86_64'].signature).toBe('sig-a')
  })

  it('rewriteManifestUrls 在直连时原样返回', () => {
    const manifest = { version: '1', platforms: { a: { url: GH } } }
    expect(rewriteManifestUrls(manifest, DIRECT_ROUTE)).toBe(manifest)
  })

  it('getRouteChain 读取用户当前的设置', () => {
    updateProxySettingsStore.commit(prev => ({ ...prev, proxy: 'none' }))
    expect(getRouteChain()).toEqual([DIRECT_ROUTE])
  })
})
