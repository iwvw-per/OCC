import { writeFile } from '@tauri-apps/plugin-fs'

/**
 * 把改写后的 updater 清单写成一个本地文件，返回可交给 Rust 的地址。
 *
 * 为什么需要这一步：tauri-plugin-updater 只接受**远程 URL**（它内部用 reqwest
 * 去取清单）。而我们要交给它的是一份**改写过 asset 地址**的清单（安装包走代理），
 * 原文在 github 上，所以只能把改写结果落到本地再以 `file://` 交给 Rust。
 *
 * 沙箱限制：Tauri v2 的 fs 插件默认不允许写入任意路径。这里写到
 * `$APPLOCALDATA/updater-manifest-<ts>.json`（应用自己的数据目录），并在
 * capabilities 里为 desktop 放开该目录的写权限。
 */
export async function stageRewrittenManifest(content: Record<string, unknown>): Promise<string> {
  const { appLocalDataDir, join } = await import('@tauri-apps/api/path')
  const dir = await appLocalDataDir()
  const path = await join(dir, `updater-manifest-${Date.now()}.json`)
  await writeFile(path, new TextEncoder().encode(JSON.stringify(content)))
  return toFileUrl(path)
}

/** 把绝对路径转成 file:// URL（Windows 盘符需要额外斜杠） */
function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash)}`
}
