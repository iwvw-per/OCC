// ============================================
// useRemoteAttachmentImage - 跨端回读附件图片
//
// 背景（多端同步，`aiagent:inst_xxx` 多主机）：
//   A 主机上产生的图片附件，消息里的 url 只有两种形态：
//     1. `file:///A主机路径/xxx.png`  —— B 端浏览器禁止页面读 file://
//     2. `data:image/png;base64,...`  —— Markdown 渲染层会拦截 data:，
//        且内联字节本来就只存在于 A 主机的会话里
//   两者在 B 端都不可加载，于是「某台主机的图片在其它端看不到」。
//
// 解决：附件折叠时已记下来源（`attachment.serverId / sessionId`，见
// utils/messageConversion 的 AttachmentOrigin），这里用
// `getFileContent(path, directory, serverId)` 从**原主机**回读字节，
// 再转成 data URL 交给 `<img>`。
//
// 边界：
//   - 只在 url 不可直接加载（file:// 或缺协议）且能解析出主机路径时才回读；
//     https/data 等原样使用，不额外发起请求。
//   - 回读失败、超时、超过体积上限都返回 null，由调用方降级为文件 chip。
//   - 同 (serverId, path, directory) 的结果做内存缓存，滚动回看不重复请求。
// ============================================

import { useEffect, useState } from 'react'
import { getFileContent } from '../api/file'
import { activeSessionStore } from '../store/activeSessionStore'
import { buildDataUrl, buildTextDataUrl, isBinaryContent } from '../utils/mimeUtils'

/** 单张图片回读允许的最大字节数：超过就直接降级，避免把大图塞进内存/渲染。 */
export const REMOTE_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024

/** 回读请求超时（经网关跨机时可能较慢，给足余量）。 */
export const REMOTE_ATTACHMENT_TIMEOUT_MS = 20_000

/** SVG 是文本型媒体，data URL 需要按文本编码而不是 base64。 */
const TEXTUAL_IMAGE_MIMES = new Set(['image/svg+xml'])

const imageCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

/** data URL / http(s) 这类本身就能被浏览器直接加载的 url 不需要回读。 */
export function isDirectlyLoadableUrl(url: string | undefined): boolean {
  if (!url) return false
  return /^(data:|https?:|blob:)/i.test(url.trim())
}

/**
 * 从附件的 url / relativePath 解析出主机上的文件路径。
 *
 * 支持：
 *   - `file:///abs/path`、`file://host/abs/path`、Windows `file:///C:/x`
 *   - 协议相对的绝对路径 `/abs/path`、`C:\path`
 * 返回 null 表示无法解析（例如只有文件名、或 url 是 http/data）。
 */
export function resolveAttachmentHostPath(url: string | undefined, relativePath?: string): string | null {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  const candidate = url?.trim() || relativePath?.trim()
  if (!candidate) return null
  if (isDirectlyLoadableUrl(candidate)) return null

  if (/^file:\/\//i.test(candidate)) {
    const rest = candidate.replace(/^file:\/\//i, '')
    // `file:///abs` → rest 以 `/` 开头；`file://host/abs` 第一个 `/` 前是主机名
    const slash = rest.indexOf('/')
    const withoutHost = rest.startsWith('/') ? rest : slash === -1 ? '' : rest.slice(slash)
    return decode(withoutHost) || null
  }

  // Windows 盘符 (`C:\` / `C:/`) 与 POSIX 绝对路径
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('/')) {
    return decode(candidate)
  }

  return null
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

const EXTENSION_MIME: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('attachment image timeout')), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function fetchRemoteImage(
  serverId: string,
  path: string,
  mime: string | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  // 目录取该会话的工作区根目录；拿不到就让服务端按默认目录解析（location 省略）。
  const directory = sessionId
    ? activeSessionStore.getSessionMeta(`${serverId}::${sessionId}`)?.directory
    : undefined
  const content = await withTimeout(
    getFileContent(path, directory, serverId),
    REMOTE_ATTACHMENT_TIMEOUT_MS,
  )
  const base64 = content?.content ?? ''
  if (!base64) return null

  const resolvedMime = content.mimeType || mime || EXTENSION_MIME[extensionOf(path)] || 'image/png'
  // base64 长度 → 原始字节的粗略估算（4 字符对应 3 字节）
  if (isBinaryContent(content.encoding) && (base64.length * 3) / 4 > REMOTE_ATTACHMENT_MAX_BYTES) return null

  if (TEXTUAL_IMAGE_MIMES.has(resolvedMime)) {
    const text = isBinaryContent(content.encoding) ? atob(base64) : base64
    return buildTextDataUrl(resolvedMime, text)
  }
  return isBinaryContent(content.encoding) ? buildDataUrl(resolvedMime, base64) : buildTextDataUrl(resolvedMime, base64)
}

export interface RemoteAttachmentImageInput {
  url?: string
  relativePath?: string
  mime?: string
  serverId?: string
  sessionId?: string
}

/**
 * 返回可直接用于 `<img src>` 的地址；不需要或尚未回读完成时返回 null。
 *
 * 回读只在以下条件同时满足时发起：url 不可直接加载、能从 url/path 解析出
 * 主机路径、且附件带有 serverId（知道该问哪台主机要）。
 */
export function useRemoteAttachmentImage(input: RemoteAttachmentImageInput): string | null {
  const { url, relativePath, mime, serverId, sessionId } = input
  const directlyLoadable = isDirectlyLoadableUrl(url)
  const hostPath = directlyLoadable ? null : resolveAttachmentHostPath(url, relativePath)
  const canFetch = !!serverId && !!hostPath

  const cacheKey = canFetch ? `${serverId}::${sessionId ?? ''}::${hostPath}` : ''

  const [resolved, setResolved] = useState<string | null>(() =>
    cacheKey ? (imageCache.get(cacheKey) ?? null) : null,
  )

  useEffect(() => {
    if (!canFetch || !cacheKey || !serverId || !hostPath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 条件变化时重置
      setResolved(null)
      return
    }
    const cached = imageCache.get(cacheKey)
    if (cached) {
      setResolved(cached)
      return
    }

    let disposed = false
    let request = inflight.get(cacheKey)
    if (!request) {
      request = fetchRemoteImage(serverId, hostPath, mime, sessionId).catch(() => null)
      inflight.set(cacheKey, request)
      request.finally(() => inflight.delete(cacheKey))
    }
    void request.then(dataUrl => {
      if (dataUrl) imageCache.set(cacheKey, dataUrl)
      if (!disposed) setResolved(dataUrl)
    })

    return () => {
      disposed = true
    }
  }, [canFetch, cacheKey, serverId, hostPath, mime, sessionId])

  if (directlyLoadable) return url ?? null
  return resolved
}

/** 仅供测试：清空模块级缓存。 */
export function clearRemoteAttachmentImageCache(): void {
  imageCache.clear()
  inflight.clear()
}
