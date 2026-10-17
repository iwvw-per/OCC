// ============================================
// PTY 命令执行（带输出捕获）
// ============================================
//
// v2 没有「同步执行命令并拿到 stdout」的 HTTP 接口：
//   - pty 是异步的，stdout 只走 WebSocket；
//   - session.shell 会创建 AI 消息、污染会话。
//
// 这里把两者拼起来：创建 PTY → 连 WebSocket 累积输出 → 轮询 pty.get 等退出 →
// 删除 PTY。用于「新建项目时 git clone」这类一次性、需要看报错的命令。

import { createPtySession, getPtyConnectUrlAsync, getPtySession, removePtySession } from './pty'
import { parsePtyFrame } from '../utils/ptyProtocol'
import { isTauri } from '../utils/tauri'

export interface RunPtyCommandOptions {
  command: string
  args: string[]
  /** 命令工作目录（也是 PTY 的 location） */
  cwd: string
  /** 浏览/执行所属目录；缺省与 cwd 相同 */
  directory?: string
  serverId?: string
  timeoutMs?: number
  pollIntervalMs?: number
  /** 输出保留上限（字节数，按字符近似），超出后只保留末尾 */
  maxOutputChars?: number
  signal?: AbortSignal
}

export interface RunPtyCommandResult {
  exitCode: number
  /** 累积的命令输出（可能不完整：PTY 在 WebSocket 连上前就结束时为空） */
  output: string
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_MS = 400
const DEFAULT_MAX_OUTPUT = 8000

/**
 * 是否是「PTY 已不存在」的错误。
 *
 * 服务端在进程退出后会回收 PTY，此时 pty.get 抛 404。SDK 的错误对象形态不统一
 * （ClientError / 原生响应 / 带 status 的 Error），所以同时匹配状态码与消息文本。
 */
function isPtyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/PtyNotFoundError|PTY session not found/i.test(message)) return true
  const status =
    (error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null)
  const candidates = [status?.status, status?.statusCode, status?.response?.status]
  return candidates.some(value => value === 404)
}

/**
 * 在服务器上执行命令，等它退出并返回退出码 + 输出。
 *
 * 输出只用于展示报错，不保证完整；退出码才是成败依据。
 */
export async function runPtyCommand(options: RunPtyCommandOptions): Promise<RunPtyCommandResult> {
  const {
    command,
    args,
    cwd,
    directory = cwd,
    serverId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT,
    signal,
  } = options

  const pty = await createPtySession({ command, args, cwd }, directory, serverId)
  const ptyId = pty.id
  if (!ptyId) throw new Error('PTY session was not created')

  let output = ''
  let socket: WebSocket | null = null
  let closed = false

  const append = (chunk: string) => {
    output += chunk
    if (output.length > maxOutputChars) output = output.slice(-maxOutputChars)
  }

  // 连 WebSocket 收集输出。失败不影响主流程（仍可靠退出码判断成败）。
  if (!isTauri() && typeof WebSocket !== 'undefined') {
    try {
      const url = await getPtyConnectUrlAsync(ptyId, directory, { cursor: 0 }, serverId)
      socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.onmessage = event => {
        const frame = parsePtyFrame(event.data as string | ArrayBuffer)
        if (frame?.kind === 'data') append(frame.data)
      }
      socket.onerror = () => {}
    } catch {
      socket = null
    }
  }

  try {
    let current = pty
    const exitCode: number | undefined =
      pty.status === 'exited' ? (pty as { exitCode?: number }).exitCode : undefined
    const startedAt = Date.now()
    while (current.status !== 'exited') {
      if (signal?.aborted) throw new Error('Command aborted')
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      try {
        current = await getPtySession(ptyId, directory, serverId)
      } catch (err) {
        // 服务端在进程退出后可能立刻回收 PTY：pty.get 返回 404。
        // 此时进程已经结束，按「正常退出」处理——成败由命令本身决定，
        // 后续的目录检查（clone 出来的文件是否存在）才是最终判据。
        if (isPtyGoneError(err)) {
          await new Promise(resolve => setTimeout(resolve, 250))
          return { exitCode: exitCode ?? 0, output }
        }
        throw err
      }
    }

    // 退出后稍等片刻，让 WebSocket 把最后几帧（含报错）读完。
    await new Promise(resolve => setTimeout(resolve, 250))
    return { exitCode: (current as { exitCode?: number }).exitCode ?? 0, output }
  } finally {
    closed = true
    if (socket) {
      try {
        socket.close()
      } catch {
        // ignore
      }
    }
    void closed
    await removePtySession(ptyId, directory, serverId).catch(() => {})
  }
}
