// ============================================
// Command API - 命令列表和执行
// ============================================

import { getV2Client } from './sdkV2'
import { nativeListCommands, nativeListSkills } from './v2NativeCommand'
import { resolveSessionTarget } from '../utils/sessionKey'
import { directoryCacheKey } from '../utils/directoryUtils'
import { serverStore } from '../store/serverStore'
import i18n from '../i18n'

export interface Command {
  name: string
  description?: string
  keybind?: string
  source: 'frontend' | 'api'
}

type ApiCommand = Omit<Command, 'source'>

// Frontend-added slash commands that do not come from GET /command.
// These are executed locally or via dedicated session actions.
function getFrontendCommands(): Command[] {
  return [
    { name: 'new', description: i18n.t('commands:slashCommand.newSessionDesc'), source: 'frontend' },
    { name: 'compact', description: i18n.t('commands:slashCommand.compactDesc'), source: 'frontend' },
  ]
}

const COMMAND_CACHE_TTL_MS = 10_000

const commandCache = new Map<string, { data: Command[]; expiresAt: number }>()
const commandInflight = new Map<string, Promise<Command[]>>()

function getCommandCacheKey(directory?: string, serverId?: string): string {
  // 用与传输格式无关的目录键：pathMode 在 auto 检测期间可能切换，
  // 直接拼 formatPathForApi 会让同一目录算出两个 key，缓存与在途合并同时失效。
  return `${serverId ?? serverStore.getActiveServerId()}::${i18n.resolvedLanguage || i18n.language}::${directoryCacheKey(directory)}`
}

async function fetchCommands(directory?: string, serverId?: string): Promise<Command[]> {
  const apiCommands = await fetchApiCommands(directory, serverId)
  const frontendCommands = getFrontendCommands()
  const commandsFromApi: Command[] = apiCommands.map(command => ({ ...command, source: 'api' }))
  const apiNames = new Set(commandsFromApi.map(c => c.name))
  return [...commandsFromApi, ...frontendCommands.filter(c => !apiNames.has(c.name))]
}

async function fetchApiCommands(directory?: string, serverId?: string): Promise<ApiCommand[]> {
  let apiCommands: ApiCommand[] = []
  try {
    apiCommands = await nativeListCommands(serverId, { directory })
  } catch {
    // Backend unreachable — frontend commands still available
  }

  // v2 把 command 与 skill 拆开（/api/command 只返回纯命令）。这里额外合并
  // skill，使 slash 面板能继续通过 / 调出 skill。
  const existingNames = new Set(apiCommands.map(c => c.name))
  const skillCommands: ApiCommand[] = []
  try {
    const skills = await nativeListSkills(serverId, { directory })
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object') continue
      const name = (skill as { name?: string }).name
      if (!name || existingNames.has(name)) continue
      skillCommands.push({
        name,
        description: (skill as { description?: string }).description,
      })
      existingNames.add(name)
    }
  } catch {
    // Skill 拉取失败不阻塞命令面板，纯命令仍可用
  }
  return [...apiCommands, ...skillCommands]
}

export async function getCommands(directory?: string, serverId?: string): Promise<Command[]> {
  const key = getCommandCacheKey(directory, serverId)
  const now = Date.now()
  const cached = commandCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  const inflight = commandInflight.get(key)
  if (inflight) {
    return inflight
  }

  const request = fetchCommands(directory, serverId)
    .then(data => {
      commandCache.set(key, { data, expiresAt: Date.now() + COMMAND_CACHE_TTL_MS })
      return data
    })
    .finally(() => {
      commandInflight.delete(key)
    })

  commandInflight.set(key, request)
  return request
}

export async function prefetchCommands(directory?: string, serverId?: string): Promise<void> {
  await getCommands(directory, serverId)
}

export async function executeCommand(
  sessionId: string,
  command: string,
  args: string = '',
  _directory?: string,
  serverId?: string,
): Promise<unknown> {
  const target = resolveSessionTarget(sessionId, serverId)
  await getV2Client(target.serverId).session.command({
    sessionID: target.sessionId,
    name: command,
    text: args,
  })
  return undefined
}
