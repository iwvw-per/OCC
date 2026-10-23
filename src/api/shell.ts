// ============================================
// Shell API - 命令执行与实时输出
// ============================================
//
// v2 的 bash 工具执行时会启动一个 shell 进程（`sh_xxx`），进程输出由服务端
// 按字节增量缓存。工具调用事件 `session.tool.progress` 会带上这个 `shellID`，
// 于是前端可以在命令还在跑的时候**持续读到新输出**。
//
// 这解决了长命令界面「静止」的问题：此前一个跑 30 秒的命令，界面上只有
// 「已调用」和「已完成」两个状态，中间 30 秒完全没有反馈，用户会以为卡死。
//
// ⚠️ 本文件前半段（`getShellOutput`）刻意用裸 fetch：它由实时输出轮询使用，
// 需要自己控制超时与取消。后半段的 shell 元信息查询走 SDK（`shell.list` /
// `shell.get`），因为那部分只是普通读取，不需要额外的手写超时。
//
// 关于「v2 没有查询后台任务的 HTTP 端点」的旧结论：**已经不成立**。
// `/openapi.json` 里有完整的 shell 资源，`shell.list` 只返回仍在运行的 shell，
// 因此可以拿它校正后台任务状态（见 useReconcileRunningShells）。

import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'
import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { num, rec, str } from './v2/adapt'
import type { BackgroundJobStatus } from '../features/workStatus/backgroundJobs'

export interface ShellOutputPage {
  output: string
  /** 本次返回内容在绝对字节轴上的结束位置 */
  cursor: number
  /** 服务端已捕获的总字节数；`cursor < size` 表示还有未读内容 */
  size: number
  /** 服务端是否因过长而截断了较早的输出 */
  truncated: boolean
}

/**
 * 读取 shell 的已捕获输出。
 *
 * 传 `cursor` 只取增量（`cursor` 之后的内容），避免长命令反复下载全部输出。
 */
export async function getShellOutput(
  shellId: string,
  options?: { cursor?: number; limit?: number; directory?: string; serverId?: string; signal?: AbortSignal },
): Promise<ShellOutputPage> {
  if (!shellId) throw new Error('shell id is required')

  const serverId = options?.serverId ?? serverStore.getActiveServerId()
  const base = serverStore.getServerBaseUrl(serverId).replace(/\/$/, '')
  const url = new URL(`${base}/api/shell/${encodeURIComponent(shellId)}/output`)
  /**
   * v2 的 location 是**深层对象**，必须写成 `location[directory]=...`。
   *
   * 写成扁平的 `directory=...` 时服务端会忽略它、按默认位置查找 shell，
   * 于是每个请求都 404 —— 详情弹窗里永远显示「无法读取输出」。
   */
  if (options?.directory) url.searchParams.set('location[directory]', options.directory)
  if (options?.cursor !== undefined) url.searchParams.set('cursor', String(options.cursor))
  if (options?.limit !== undefined) url.searchParams.set('limit', String(options.limit))

  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()

  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(options?.signal?.reason)
  if (options?.signal?.aborted) abortFromExternal()
  else options?.signal?.addEventListener('abort', abortFromExternal, { once: true })
  // 轮询路径必须有超时：一次挂起的请求会让整条增量链停住。
  const timeoutId = setTimeout(() => controller.abort(new Error('shell output request timed out')), 10_000)

  try {
    const response = await fetchImpl(url.toString(), {
      headers: { ...buildHeaders(serverId), Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`shell output failed: HTTP ${response.status}`)
    const payload: unknown = await response.json()
    const data = (payload as { data?: unknown })?.data ?? payload
    const rec = (data ?? {}) as Record<string, unknown>
    return {
      output: typeof rec.output === 'string' ? rec.output : '',
      cursor: typeof rec.cursor === 'number' ? rec.cursor : 0,
      size: typeof rec.size === 'number' ? rec.size : 0,
      truncated: rec.truncated === true,
    }
  } finally {
    clearTimeout(timeoutId)
    options?.signal?.removeEventListener('abort', abortFromExternal)
  }
}

/**
 * `getShellOutput` 的容错版：失败时返回 null 而不是抛错。
 *
 * 详情弹窗用它可以区分「没有输出」与「读不到输出」（子代理任务、已被清理的
 * shell 都没有输出文件），而不必自己 try/catch。
 */
export async function tryGetShellOutput(
  shellId: string,
  options?: { cursor?: number; limit?: number; directory?: string; serverId?: string; signal?: AbortSignal },
): Promise<ShellOutputPage | null> {
  try {
    return await getShellOutput(shellId, options)
  } catch {
    return null
  }
}

// ============================================
// Shell 元信息（列表 / 单条）
// ============================================

/** shell 在协议层的状态（比后台任务的状态词更细） */
export type ShellStatus = 'running' | 'exited' | 'timeout' | 'killed'

export interface ShellInfo {
  id: string
  status: ShellStatus
  command: string
  cwd: string
  shell: string
  /** 输出落盘文件路径（协议层字段） */
  file: string
  pid?: number
  exit?: number
  signal?: string
  /** 发起它的会话 id（opencode 在 metadata 里写入） */
  sessionID?: string
  startedAt: number
  completedAt?: number
}

/** 把协议层的 shell 状态映射成后台任务的状态词 */
export function shellStatusToJobStatus(status: ShellStatus, exit?: number): BackgroundJobStatus {
  switch (status) {
    case 'running':
      return 'running'
    case 'exited':
      // exit 非 0 说明命令失败，不能一律算「已完成」
      return exit != null && exit !== 0 ? 'error' : 'completed'
    case 'timeout':
      return 'error'
    case 'killed':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function adaptShellInfo(raw: unknown): ShellInfo | null {
  const r = rec(raw)
  const id = str(r.id)
  if (!id) return null
  const time = rec(r.time)
  const metadata = rec(r.metadata)
  const status = str(r.status)
  const normalized: ShellStatus =
    status === 'running' || status === 'exited' || status === 'timeout' || status === 'killed'
      ? status
      : 'exited'
  return {
    id,
    status: normalized,
    command: str(r.command) ?? '',
    cwd: str(r.cwd) ?? '',
    shell: str(r.shell) ?? '',
    file: str(r.file) ?? '',
    pid: num(r.pid),
    exit: num(r.exit),
    signal: str(r.signal),
    sessionID: str(metadata.sessionID),
    startedAt: num(time.started) ?? 0,
    completedAt: num(time.completed),
  }
}

/**
 * 列出某个目录下**仍在运行**的 shell。
 *
 * 已结束的 shell 不在返回结果里，所以这份列表只能回答「现在有什么在跑」，
 * 不能当作全部任务清单 —— 这正是它能用来校正「运行中」的原因。
 */
export async function listRunningShells(directory?: string, serverId?: string): Promise<ShellInfo[]> {
  try {
    const client = getV2Client(serverId)
    const res = await client.shell.list({
      location: directory ? { directory } : undefined,
    })
    return adaptDataList(res)
      .map(adaptShellInfo)
      .filter((info): info is ShellInfo => info !== null)
  } catch {
    // shell 端点不可用（旧版服务端）时静默降级：面板回落到消息推导的状态
    return []
  }
}

/** 读取单个 shell 的信息（已结束的也能查到终态） */
export async function getShellInfo(
  id: string,
  directory?: string,
  serverId?: string,
): Promise<ShellInfo | null> {
  try {
    const client = getV2Client(serverId)
    const res = await client.shell.get({
      id,
      location: directory ? { directory } : undefined,
    })
    return adaptShellInfo(adaptEnvelope(res))
  } catch {
    // 不存在的 id（历史任务已被清理）返回 null，由调用方回落
    return null
  }
}
