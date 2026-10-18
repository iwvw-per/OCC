import type { PermissionRequest, Agent } from '../../types'
import type { Pty } from '../../types/domain/pty'
import { rec, str, num } from './adapt'

/** v2 PermissionRequest → v1 PermissionRequest（action/resources/save → permission/patterns/always） */
export function adaptPermission(raw: unknown): PermissionRequest {
  const p = rec(raw)
  return {
    id: String(p.id ?? ''),
    sessionID: String(p.sessionID ?? ''),
    permission: str(p.action) ?? str(p.permission) ?? '',
    patterns: Array.isArray(p.resources) ? (p.resources as string[]) : (Array.isArray(p.patterns) ? (p.patterns as string[]) : []),
    metadata: rec(p.metadata),
    always: Array.isArray(p.save) ? (p.save as string[]) : (Array.isArray(p.always) ? (p.always as string[]) : []),
    // v2 的 tool 来源是 source: { type:'tool', messageID, id }，id 即工具调用 callID。
    // 映射成 v1 { messageID, callID }，内嵌提问/权限才能按 callID 匹配到对应工具。
    tool: adaptPermissionTool(p.source),
  } as PermissionRequest
}

/** v2 PermissionSource → v1 tool 引用（{ messageID, callID }）。 */
function adaptPermissionTool(source: unknown): PermissionRequest['tool'] {
  const s = rec(source)
  if (s.type !== 'tool') return undefined
  const callID = str(s.id) ?? ''
  const messageID = str(s.messageID) ?? ''
  if (!callID && !messageID) return undefined
  return { messageID, callID }
}

/** v2 Agent → v1 Agent（id→name，permissions→permission） */
export function adaptAgent(raw: unknown): Agent {
  const a = rec(raw)
  return {
    name: String(a.id ?? a.name ?? ''),
    description: str(a.description),
    mode: (str(a.mode) ?? 'all') as Agent['mode'],
    native: a.native as boolean | undefined,
    hidden: a.hidden as boolean | undefined,
    permission: (a.permissions ?? a.permission ?? []) as Agent['permission'],
    model: a.model as Agent['model'],
    prompt: str(a.prompt),
    options: (a.options ?? {}) as Agent['options'],
  } as Agent
}

/** v2 Pty → v1 Pty（v2 无 size，补默认值） */
export function adaptPty(raw: unknown): Pty {
  const p = rec(raw)
  const exitCode = num(p.exitCode)
  return {
    id: String(p.id ?? ''),
    title: str(p.title) ?? '',
    command: str(p.command) ?? '',
    args: Array.isArray(p.args) ? (p.args as string[]) : [],
    cwd: str(p.cwd) ?? '',
    status: (str(p.status) ?? 'running') as Pty['status'],
    pid: num(p.pid) ?? 0,
    size: { rows: 24, cols: 80 },
    // v2 在 exited 时回填退出码；SDK 的 Pty 类型未声明该字段，故显式补上。
    ...(exitCode !== undefined ? { exitCode } : {}),
  } as Pty
}

/**
 * v2 FileSystem.Entry → v1 FileNode。
 *
 * v1 的 /file/list 返回 {name, path, absolute, type, ignored}；v2 只给
 * {path, type}（path 为相对路径）。UI（ProjectDialog / useFileExplorer 等）
 * 依赖 name 做排序（localeCompare），缺 name 直接崩溃，必须在适配层补上
 * name/absolute/ignored。
 *
 * ⚠️ 跨平台：Windows 后端返回的 path 用反斜杠且目录带尾分隔符（如 `.agents\`），
 * Linux 用正斜杠（`.agents/`）。此前只按 '/' 切分，Windows 下 name 会变成整段
 * 带反斜杠的路径，于是子目录显示成「父目录名\子目录名」、目录名还挂着尾反斜杠。
 * 这里统一把 path 规范成前端内部约定的正斜杠相对路径（去尾分隔符），name 取最后
 * 一段，absolute 也用正斜杠拼接；两种系统下表现一致。
 */
export function adaptFileNode(
  raw: unknown,
  options: { directory?: string },
): { name: string; path: string; absolute: string; type: 'file' | 'directory'; ignored: boolean } {
  const e = rec(raw)
  const isDir = e.type === 'directory'
  const relPath = (str(e.path) ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const name = relPath.split('/').filter(Boolean).pop() ?? relPath
  const directory = (options.directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = relPath === '' ? directory : directory ? `${directory}/${relPath}` : relPath
  return {
    name,
    path: relPath,
    absolute,
    type: isDir ? 'directory' : 'file',
    ignored: false,
  }
}

/**
 * v2 Model.Info → v1 Provider.models[modelID]。v2 模型用独立 /api/model，
 * v1 客户端期望嵌套在 provider.models 下且带 status/limit/capabilities。
 */
export function adaptModelToProviderEntry(raw: unknown): Record<string, unknown> {
  const m = rec(raw)
  const capabilities = rec(m.capabilities)
  const inputList: string[] = Array.isArray(capabilities.input) ? (capabilities.input as string[]) : []
  const variantsRaw = Array.isArray(m.variants) ? (m.variants as unknown[]) : []
  const variants: Record<string, unknown> = {}
  for (const v of variantsRaw) {
    const id = str(rec(v).id)
    if (id) variants[id] = v
  }
  return {
    id: String(m.id ?? m.modelID ?? ''),
    providerID: str(m.providerID) ?? '',
    name: str(m.name) ?? str(m.modelID) ?? '',
    status: str(m.status) ?? 'active',
    limit: {
      context: num(rec(m.limit).context) ?? 0,
      output: num(rec(m.limit).output) ?? 0,
    },
    capabilities: {
      reasoning: inputList.includes('reasoning'),
      attachment: inputList.includes('image') || inputList.includes('pdf') || inputList.includes('audio') || inputList.includes('video'),
      toolcall: capabilities.tools === true,
      input: {
        text: inputList.includes('text'),
        audio: inputList.includes('audio'),
        image: inputList.includes('image'),
        video: inputList.includes('video'),
        pdf: inputList.includes('pdf'),
      },
    },
    variants,
  }
}

/**
 * 组装 v1 形状的 config.providers 响应：把 provider.list + model.list 合并成
 * { providers: [{ id, name, models: { modelId: {...} } }] }，供 getActiveModels 消费。
 */
export function adaptProviders(providersRaw: unknown, modelsRaw: unknown): Array<Record<string, unknown>> {
  const providers = Array.isArray(providersRaw) ? providersRaw : []
  const models = Array.isArray(modelsRaw) ? modelsRaw : []
  const modelsByProvider = new Map<string, Array<Record<string, unknown>>>()
  for (const raw of models) {
    const m = rec(raw)
    const providerID = str(m.providerID)
    if (!providerID) continue
    const list = modelsByProvider.get(providerID) ?? []
    list.push(adaptModelToProviderEntry(raw))
    modelsByProvider.set(providerID, list)
  }
  return providers.map(p => {
    const provider = rec(p)
    const pid = str(provider.id) ?? ''
    const modelsMap: Record<string, unknown> = {}
    for (const entry of modelsByProvider.get(pid) ?? []) {
      const key = String(entry.id ?? '')
      if (key) modelsMap[key] = entry
    }
    return {
      id: str(provider.id) ?? '',
      name: str(provider.name) ?? str(provider.id) ?? '',
      models: modelsMap,
    }
  })
}

/**
 * v2 Skill.Info → v1 AppSkills 条目。v2 用 path 字段，v1 UI 依赖 location 展示。
 */
export function adaptSkill(raw: unknown): Record<string, unknown> {
  const s = rec(raw)
  return {
    name: str(s.name) ?? '',
    description: str(s.description),
    slash: s.slash === true,
    location: str(s.path) ?? str(s.location) ?? '',
    content: str(s.content) ?? '',
  }
}

/**
 * v2 mcp.list（{name,status}[]）→ v1 mcp.status（{ name: status } map）。
 * v2 用 status 字段名，v1 用 MCPStatus 联合类型；pending 映射为 connected 近似。
 */
export function adaptMcpStatus(serversRaw: unknown): Record<string, unknown> {
  const servers = Array.isArray(serversRaw) ? serversRaw : []
  const map: Record<string, unknown> = {}
  for (const raw of servers) {
    const s = rec(raw)
    const name = str(s.name)
    if (!name) continue
    const status = str(rec(s.status).status)
    const error = str(rec(s.status).error)
    if (status === 'failed') {
      map[name] = { status: 'failed', error: error ?? '' }
    } else if (status === 'needs_auth') {
      map[name] = { status: 'needs_auth' }
    } else {
      map[name] = { status: status === 'disabled' ? 'disabled' : 'connected' }
    }
  }
  return map
}


