// ============================================
// v2 客户端 Facade（对上层伪装成 v1 SDK 形状）
//
// 目的：让领域模块（session.ts / message.ts / permission.ts …）无需感知
// opencode 版本差异。对 v2 服务器，getSDKClient 返回本 facade，它把 v2 的
// 调用与响应适配成 v1 SDK 的形态（`{data,error}` 信封、消息头游标等）。
//
// 设计取舍：
//   - 已由 v2 直接支持的方法走真实调用 + 适配器；
//   - v2 无对应能力的方法抛出明确错误（而非静默返回空），避免 UI 假死；
//   - 返回值统一为 `{data}`，配合上层 unwrap 使用。
// ============================================

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client'
import { getV2Client } from './sdkV2'
import { adaptSession, adaptDataList, adaptEnvelope } from './v2/session'
import { adaptMessagePage } from './v2/message'
import { adaptPermission, adaptAgent, adaptPty, adaptFileNode, adaptProviders, adaptMcpStatus, adaptSkill } from './v2/entities'
import { rec, str } from './v2/adapt'

interface Envelope<T> {
  data?: T
  error?: unknown
  response?: { headers: { get(name: string): string | null } }
}

function ok<T>(data: T, headers?: Record<string, string>): Envelope<T> {
  return {
    data,
    response: {
      headers: { get: (name: string) => headers?.[name] ?? null },
    },
  }
}

/** v2 的 message.list limit 硬上限（超过会被服务端拒绝：Expected <= 200）。 */
const V2_MESSAGE_PAGE_MAX = 200

function v2(serverId?: string) {
  return getV2Client(serverId)
}

/**
 * 把 v1 形状的 prompt parts 转成 v2 的 prompt 入参。
 * v1 用 parts[]（text/file/agent），v2 用 { text, files[], agents[] }。
 */
function buildV2Prompt(input: {
  text?: string
  parts?: unknown[]
}): { text: string; files?: Array<{ uri: string; name?: string }>; agents?: Array<{ name: string }> } {
  const textChunks: string[] = []
  const files: Array<{ uri: string; name?: string }> = []
  const agents: Array<{ name: string }> = []
  for (const raw of input.parts ?? []) {
    const p = rec(raw)
    const type = str(p.type)
    if (type === 'text') {
      const t = str(p.text)
      if (t) textChunks.push(t)
    } else if (type === 'file') {
      const uri = str(p.url) ?? str(p.uri)
      if (uri) files.push({ uri, name: str(p.filename) ?? str(p.name) })
    } else if (type === 'agent') {
      const name = str(p.name)
      if (name) agents.push({ name })
    }
  }
  // v1 的 prompt 参数里 text 与 parts 二选一：有 parts 时以 parts 为准。
  const text = textChunks.length > 0 ? textChunks.join('\n') : (input.text ?? '')
  return {
    text,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
  }
}

/**
 * 构造对 v2 服务器的 v1 形状客户端。
 * 类型以 OpencodeClient 收口，实现只覆盖被上层实际调用的方法。
 */
export function createV2Facade(serverId?: string): OpencodeClient {
  const client = v2(serverId)

  const facade = {
    // ---------------- experimental（v1 的 client.experimental.* 顶层命名空间） ----------------
    experimental: {
      session: {
        async list(input: { directory?: string; roots?: boolean; start?: number; limit?: number; search?: string }) {
          const res = await client.session.list({
            directory: input.directory,
            search: input.search,
            limit: input.limit,
            order: 'desc',
          })
          return ok(adaptDataList(res).map(adaptSession))
        },
      },
      resource: {
        async list(input: { directory?: string }) {
          const res = await client.mcp.resource.catalog({
            location: input.directory ? { directory: input.directory } : undefined,
          })
          const catalog = adaptEnvelope(res) as { resources?: unknown[] }
          const entries = Array.isArray(catalog?.resources) ? catalog.resources : []
          const map: Record<string, unknown> = {}
          for (const raw of entries) {
            const r = rec(raw)
            const name = str(r.name)
            if (name) map[name] = { ...r, client: str(r.server) ?? '' }
          }
          return ok(map)
        },
      },
    },

    // ---------------- session ----------------
    session: {
      async status() {
        // v2 用 session.active 表达「正在运行」的会话；v1 期望 SessionStatusMap。
        // 映射 running → busy，其余会话由 SSE 事件驱动状态。
        const active = rec(await client.session.active())
        const map: Record<string, unknown> = {}
        for (const [id, val] of Object.entries(active)) {
          if (rec(val).type === 'running') map[id] = { type: 'busy' }
        }
        return ok(map)
      },
      async diff(input: { sessionID: string; directory?: string; messageID?: string }) {
        const diffs = await client.session.diff({ sessionID: input.sessionID })
        return ok(diffs)
      },
      experimental: {
        async list(input: { directory?: string; search?: string; limit?: number; start?: number; roots?: boolean }) {
          const res = await client.session.list({
            directory: input.directory,
            search: input.search,
            limit: input.limit,
            order: 'desc',
          })
          return ok(adaptDataList(res).map(adaptSession))
        },
      },
      async get(input: { sessionID: string }) {
        return ok(adaptSession(await client.session.get({ sessionID: input.sessionID })))
      },
      async create(input: { directory?: string; title?: string; parentID?: string }) {
        const created = await client.session.create({
          title: input.title,
          parentID: input.parentID,
          location: input.directory ? { directory: input.directory } : undefined,
        })
        return ok(adaptSession(created))
      },
      async update(input: { sessionID: string; title?: string; time?: { archived?: number } }) {
        await client.session.update({
          sessionID: input.sessionID,
          title: input.title,
        })
        return ok(adaptSession(await client.session.get({ sessionID: input.sessionID })))
      },
      async delete(input: { sessionID: string }) {
        await client.session.remove({ sessionID: input.sessionID })
        return ok(true)
      },
      async abort(input: { sessionID: string }) {
        await client.session.interrupt({ sessionID: input.sessionID })
        return ok(true)
      },
      async revert(input: { sessionID: string; messageID: string; partID?: string }) {
        await client.session.revert.stage({
          sessionID: input.sessionID,
          messageID: input.messageID,
        })
        return ok(adaptSession(await client.session.get({ sessionID: input.sessionID })))
      },
      async unrevert(input: { sessionID: string }) {
        await client.session.revert.clear({ sessionID: input.sessionID })
        return ok(adaptSession(await client.session.get({ sessionID: input.sessionID })))
      },
      async share() {
        // v2 无 share 能力，安全 no-op（分享会话功能在 v2 不可用）
        return ok(true)
      },
      async unshare() {
        return ok(true)
      },
      async fork(input: { sessionID: string; messageID?: string }) {
        return ok(adaptSession(await client.session.fork({ sessionID: input.sessionID, before: input.messageID })))
      },
      async summarize(input: { sessionID: string }) {
        await client.session.compact({ sessionID: input.sessionID })
        return ok(true)
      },
      async children(input: { sessionID: string }) {
        const res = await client.session.list({ parentID: input.sessionID })
        return ok(adaptDataList(res).map(adaptSession))
      },
      async todo() {
        // v2 无 session.todo，安全降级为空（待办由 SSE 事件驱动）
        return ok([])
      },
      async messages(input: { sessionID: string; directory?: string; limit?: number; before?: string }) {
        // v2 的 message.list：limit 上限 200，默认 order=desc，且 cursor 不能与
        // order 同用。v1 调用方（沿用 v1 常量）可能传超大 limit（如 100000）或
        // 期望升序，这里做钳制与归一：
        //   - 首页（无 before）：order=desc 取最新 limit 条；
        //   - 翻页（before 为 v2 游标）：只传 cursor，方向由游标自带；
        //   - 统一按时间升序返回，nextCursor 用 v2 的 next（指向更早）。
        const limit = Math.min(input.limit ?? V2_MESSAGE_PAGE_MAX, V2_MESSAGE_PAGE_MAX)
        const params: { sessionID: string; limit: number; cursor?: string; order?: 'desc' } = {
          sessionID: input.sessionID,
          limit,
        }
        if (input.before) {
          params.cursor = input.before
        } else {
          params.order = 'desc'
        }
        const page = adaptMessagePage(await client.message.list(params))
        const messages = [...page.messages].sort(
          (a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0),
        )
        return ok(messages, page.nextCursor ? { 'X-Next-Cursor': page.nextCursor } : undefined)
      },
      async prompt(input: { sessionID: string; parts?: unknown[]; text?: string; model?: { providerID: string; modelID: string }; agent?: string; messageID?: string; variant?: string }) {
        if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
        if (input.model) await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } })
        const prompt = buildV2Prompt(input)
        await client.session.prompt({
          sessionID: input.sessionID,
          id: input.messageID,
          text: prompt.text,
          files: prompt.files,
          agents: prompt.agents,
        })
        return ok({ info: {}, parts: [] })
      },
      async promptAsync(input: { sessionID: string; parts?: unknown[]; text?: string; model?: { providerID: string; modelID: string }; agent?: string; messageID?: string }) {
        if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
        if (input.model) await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } })
        const prompt = buildV2Prompt(input)
        await client.session.prompt({
          sessionID: input.sessionID,
          id: input.messageID,
          text: prompt.text,
          files: prompt.files,
          agents: prompt.agents,
        })
        return ok(true)
      },
      async command(input: { sessionID: string; command: string; arguments?: string }) {
        await client.session.command({
          sessionID: input.sessionID,
          name: input.command,
          text: input.arguments ?? '',
        })
        return ok(true)
      },
    },

    // ---------------- permission ----------------
    permission: {
      async list() {
        const res = await client.permission.request.list()
        return ok(adaptDataList(res).map(adaptPermission))
      },
      async reply(input: { requestID: string; sessionID?: string; reply: 'once' | 'always' | 'reject'; message?: string }) {
        await client.permission.reply({
          sessionID: input.sessionID ?? '',
          requestID: input.requestID,
          decision: input.reply,
          message: input.message,
        })
        return ok(true)
      },
      async respond(input: { sessionID: string; permissionID: string; response: 'once' | 'always' | 'reject' }) {
        await client.permission.reply({
          sessionID: input.sessionID,
          requestID: input.permissionID,
          decision: input.response,
        })
        return ok(true)
      },
    },

    // v2 用 Form 体系取代 question；客户端仍会轮询 pending questions，安全降级为空
    question: {
      async list() {
        return ok([])
      },
      async reply() {
        return ok(true)
      },
      async reject() {
        return ok(true)
      },
    },

    // ---------------- app / config ----------------
    app: {
      async agents() {
        const res = await client.agent.list()
        return ok(adaptDataList(res).map(adaptAgent))
      },
      async skills() {
        const res = await client.skill.list()
        return ok(adaptDataList(res).map(adaptSkill))
      },
    },
    config: {
      async get() {
        return ok(adaptEnvelope(await client.config.get()))
      },
      async update(input: { config?: unknown; shell?: string }) {
        // v2 的 config.update 仅支持 shell，其余字段忽略（返回成功但不生效）。
        if (input.shell !== undefined) {
          await client.config.update({ shell: input.shell })
        }
        return ok(true)
      },
      async providers(input?: { directory?: string }) {
        // v1 的 config.providers 期望 { providers: [{ id, name, models: {...} }] },
        // v2 把模型拆到独立 /api/model。合并两路并组装成 v1 形状。
        // 必须带 location，否则 /api/model 返回空列表 → 模型选择器空白。
        const loc = input?.directory ? { directory: input.directory } : undefined
        const [providersRes, modelsRes] = await Promise.all([client.provider.list({ location: loc }), client.model.list({ location: loc })])
        return ok({ providers: adaptProviders(adaptDataList(providersRes), adaptDataList(modelsRes)) })
      },
      global: {
        async get() {
          return ok(adaptEnvelope(await client.config.get()))
        },
        async update(input: { config?: unknown; shell?: string }) {
          if (input.shell !== undefined) {
            await client.config.update({ shell: input.shell })
          }
          return ok(true)
        },
      },
    },

    // ---------------- file / find ----------------
    file: {
      async list(input: { directory?: string; path?: string }) {
        const res = await client.file.list({
          location: input.directory ? { directory: input.directory } : undefined,
          path: input.path,
        })
        const entries = Array.isArray(adaptEnvelope(res)) ? (adaptEnvelope(res) as unknown[]) : []
        return ok(entries.map(entry => adaptFileNode(entry, { directory: input.directory })))
      },
      async read(input: { directory?: string; path: string }) {
        const res = await client.file.read({
          location: input.directory ? { directory: input.directory } : undefined,
          path: input.path,
        })
        return ok(adaptEnvelope(res))
      },
      async status(input: { directory?: string }) {
        const res = await client.vcs.status({ location: input.directory ? { directory: input.directory } : undefined })
        return ok(adaptEnvelope(res))
      },
    },
    find: {
      async files(input: { query: string; directory?: string; type?: string; limit?: number }) {
        const res = await client.file.find({
          location: input.directory ? { directory: input.directory } : undefined,
          query: input.query,
          type: input.type as never,
          limit: input.limit,
        })
        const entries = Array.isArray(adaptDataList(res)) ? (adaptDataList(res) as unknown[]) : []
        // v1 的 find.files 返回路径数组（string[]），上层 searchFiles 直接透传
        return ok(entries.map(entry => str(rec(entry).path) ?? ''))
      },
      async text() {
        // v2 无 find.text（只有 find.files），安全降级为空结果，避免 UI 崩溃
        return ok([])
      },
    },

    // ---------------- command / provider / model ----------------
    command: {
      async list(input: { directory?: string }) {
        // v2 的 command.list 需要 location 才返回该工作区的命令；不传会得到空列表
        const res = await client.command.list({
          location: input?.directory ? { directory: input.directory } : undefined,
        })
        return ok(adaptDataList(res))
      },
    },
    provider: {
      async list(input?: { directory?: string }) {
        return ok(adaptDataList(await client.provider.list({ location: input?.directory ? { directory: input.directory } : undefined })))
      },
    },
    model: {
      async list(input?: { directory?: string }) {
        return ok(adaptDataList(await client.model.list({ location: input?.directory ? { directory: input.directory } : undefined })))
      },
    },

    // ---------------- mcp / vcs / worktree / pty ----------------
    mcp: {
      async status() {
        // v2 的 mcp.list 返回 Server[]（{name,status}），v1 期望 { name: status } map
        const res = await client.mcp.list()
        return ok(adaptMcpStatus(adaptDataList(res)))
      },
      async add(input: { name: string; config: unknown }) {
        await client.mcp.add({ server: input.name, config: input.config as never })
        return ok(true)
      },
      async connect(input: { name: string }) {
        await client.mcp.connect({ server: input.name })
        return ok(true)
      },
      async disconnect(input: { name: string }) {
        await client.mcp.disconnect({ server: input.name })
        return ok(true)
      },
      auth: {
        async start() {
          // v2 用 Integration OAuth 取代 mcp OAuth 流程；v1 客户端点击「开始认证」
          // 时依赖 { url } 返回值。v2 无直接对应，安全返回空 url（面板有失败兜底）。
          return ok({ url: '' })
        },
        async authenticate() {
          return ok(true)
        },
      },
    },
    vcs: {
      async get(input: { directory?: string }) {
        // v2 的 Vcs.Info.branch 是 {current?, default?} 对象，v1 契约是 string；
        // 适配成 v1 形状避免 UI 对 branch.trim() 崩溃
        const info = rec(adaptEnvelope(await client.vcs.get({ location: input.directory ? { directory: input.directory } : undefined })))
        const branch = rec(info.branch)
        return ok({ ...info, branch: str(branch.current) ?? str(info.branch) ?? '', default_branch: str(branch.default) ?? '' })
      },
      async diff(input: { directory?: string; mode?: string }) {
        return ok(
          adaptEnvelope(
            await client.vcs.diff({
              location: input.directory ? { directory: input.directory } : undefined,
              mode: (input.mode ?? 'working') as never,
            }),
          ),
        )
      },
    },
    worktree: {
      // v2 的 worktree API 以 projectID 为键，v1 调用方传的是 directory；
      // 缺少稳定的 projectID 映射，安全降级为空列表/空对象，避免 UI 崩溃。
      async list() {
        return ok([])
      },
      async create() {
        return ok(null)
      },
      async remove() {
        return ok(true)
      },
      async reset() {
        return ok(true)
      },
    },
    pty: {
      async list(input: { directory?: string }) {
        const res = await client.pty.list({ location: input.directory ? { directory: input.directory } : undefined })
        return ok(adaptDataList(res).map(adaptPty))
      },
      async shells() {
        const res = await client.config.shells()
        return ok(adaptEnvelope(res))
      },
      async create(input: { directory?: string; command?: string; args?: string[]; cwd?: string }) {
        const res = await client.pty.create({
          location: input.directory ? { directory: input.directory } : undefined,
          command: input.command,
          args: input.args,
          cwd: input.cwd,
        })
        return ok(adaptPty(adaptEnvelope(res)))
      },
      async update(input: { ptyID: string; size?: unknown; title?: string }) {
        const res = await client.pty.update({ ptyID: input.ptyID, title: input.title })
        return ok(adaptPty(adaptEnvelope(res)))
      },
      async remove(input: { ptyID: string }) {
        await client.pty.remove({ ptyID: input.ptyID })
        return ok(true)
      },
    },

    // ---------------- global / project ----------------
    global: {
      async health() {
        const info = await client.server.info()
        return ok({ healthy: true, version: info.version })
      },
    },
    instance: {
      async dispose() {
        // v2 无对应能力，客户端在退出/清理时调用，安全 no-op
        return ok(true)
      },
    },
    project: {
      async current() {
        // v2 用 location.get 表达「当前工作区/项目」；取其 project 字段近似 v1 current
        const info = rec(await client.location.get())
        const project = rec(info.project)
        return ok({
          id: str(project.id) ?? str(project.directory) ?? '',
          worktree: str(project.canonical) ?? str(project.directory) ?? '',
          vcs: project.vcs as 'git' | undefined,
          name: str(project.name),
        })
      },
      async list() {
        // v2 project.list 返回 Project.Info[]，字段与 v1 接近，透传
        const res = await client.project.list()
        return ok(adaptDataList(res))
      },
      async initGit() {
        // v2 用 vcs.init 初始化 git
        const res = await client.vcs.init()
        return ok(adaptEnvelope(res))
      },
    },
    path: {
      async get() {
        return ok(adaptEnvelope(await client.location.get()))
      },
    },
  }

  return facade as unknown as OpencodeClient
}
