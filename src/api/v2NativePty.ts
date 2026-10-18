// ============================================
// v2 原生 Pty 访问层
//
// 直接用 @opencode/client（v2 原生）调用 pty。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { adaptPty } from './v2/entities'
import type { Pty } from '../types/domain/pty'

/**
 * 原生列出 PTY 会话（v2 pty.list）。
 */
export async function nativeListPtySessions(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<Pty[]> {
  const client = getV2Client(serverId)
  const res = await client.pty.list({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptDataList(res).map(adaptPty)
}

/**
 * 原生创建 PTY 会话（v2 pty.create）。
 */
export async function nativeCreatePtySession(
  serverId: string | undefined,
  input: { directory?: string; command?: string; args?: string[]; cwd?: string; title?: string },
): Promise<Pty> {
  const client = getV2Client(serverId)
  const res = await client.pty.create({
    location: input.directory ? { directory: input.directory } : undefined,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    title: input.title,
  })
  return adaptPty(adaptEnvelope(res))
}

/**
 * 原生获取单个 PTY 会话（v2 pty.get）。
 *
 * 用于轮询命令退出状态：`status: 'exited'` + `exitCode` 是判断
 * 「git clone 是否成功」的唯一可靠信号（PTY 的 stdout 走 WebSocket，
 * 不适合只为拿退出码而建立终端会话）。
 */
export async function nativeGetPtySession(
  serverId: string | undefined,
  input: { ptyID: string; directory?: string },
): Promise<Pty> {
  const client = getV2Client(serverId)
  const res = await client.pty.get({
    ptyID: input.ptyID,
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptPty(adaptEnvelope(res))
}

/**
 * 原生更新 PTY 会话（v2 pty.update）。
 */
export async function nativeUpdatePtySession(
  serverId: string | undefined,
  input: { ptyID: string; title?: string; size?: unknown },
): Promise<Pty> {
  const client = getV2Client(serverId)
  const res = await client.pty.update({ ptyID: input.ptyID, title: input.title })
  return adaptPty(adaptEnvelope(res))
}

/**
 * 原生删除 PTY 会话（v2 pty.remove）。
 */
export async function nativeRemovePtySession(
  serverId: string | undefined,
  ptyID: string,
): Promise<boolean> {
  const client = getV2Client(serverId)
  await client.pty.remove({ ptyID })
  return true
}
