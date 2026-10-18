// ============================================
// v2 原生 Command / Skill 访问层
//
// 直接用 @opencode/client（v2 原生）调用 command/skill。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList } from './v2/session'
import { adaptSkill } from './v2/entities'
import type { SkillList } from '../types/api/skill'

export interface DomainCommandItem {
  name: string
  description?: string
}

/**
 * 原生列出命令（v2 command.list）。需要 location 才返回该工作区命令。
 */
export async function nativeListCommands(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<DomainCommandItem[]> {
  const client = getV2Client(serverId)
  const res = await client.command.list({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptDataList(res).map(raw => {
    const r = raw as { name?: string; description?: string }
    return { name: String(r.name ?? ''), description: r.description }
  })
}

/**
 * 原生列出 skill（v2 skill.list），适配回前端 SkillList 形状。
 */
export async function nativeListSkills(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<SkillList> {
  const client = getV2Client(serverId)
  const res = await client.skill.list({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptDataList(res).map(adaptSkill) as SkillList
}
