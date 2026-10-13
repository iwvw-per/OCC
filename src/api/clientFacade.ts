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
import { adaptPermission, adaptAgent, adaptPty } from './v2/entities'

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

function unsupported(method: string): never {
  throw new Error(`opencode v2 暂不支持 ${method}`)
}

function v2(serverId?: string) {
  return getV2Client(serverId)
}

/**
 * 构造对 v2 服务器的 v1 形状客户端。
 * 类型以 OpencodeClient 收口，实现只覆盖被上层实际调用的方法。
 */
export function createV2Facade(serverId?: string): OpencodeClient {
  const client = v2(serverId)

  const facade = {
    // ---------------- session ----------------
    session: {
      async status() {
        unsupported('session.status')
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
        unsupported('session.share')
      },
      async unshare() {
        unsupported('session.unshare')
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
        unsupported('session.todo')
      },
      async messages(input: { sessionID: string; directory?: string; limit?: number; before?: string }) {
        const res = await client.message.list({
          sessionID: input.sessionID,
          limit: input.limit,
          cursor: input.before,
        })
        const page = adaptMessagePage(res)
        return ok(page.messages, page.nextCursor ? { 'X-Next-Cursor': page.nextCursor } : undefined)
      },
      async prompt(input: { sessionID: string; parts?: unknown[]; text?: string; model?: { providerID: string; modelID: string }; agent?: string; messageID?: string; variant?: string }) {
        if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
        if (input.model) await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } })
        await client.session.prompt({
          sessionID: input.sessionID,
          text: input.text ?? '',
          id: input.messageID,
        })
        return ok({ info: {}, parts: [] })
      },
      async promptAsync(input: { sessionID: string; parts?: unknown[]; text?: string; model?: { providerID: string; modelID: string }; agent?: string; messageID?: string }) {
        if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
        if (input.model) await client.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } })
        await client.session.prompt({
          sessionID: input.sessionID,
          text: input.text ?? '',
          id: input.messageID,
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

    // v2 用 Form 体系取代 question，语义不同，暂不映射。
    question: {
      async list() {
        unsupported('question.list')
      },
      async reply() {
        unsupported('question.reply')
      },
      async reject() {
        unsupported('question.reject')
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
        return ok(adaptDataList(res))
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
      async providers() {
        const res = await client.provider.list()
        return ok({ providers: adaptDataList(res) })
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
        return ok(adaptEnvelope(res))
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
        return ok(adaptDataList(res))
      },
      async text() {
        unsupported('find.text')
      },
    },

    // ---------------- command / provider / model ----------------
    command: {
      async list() {
        const res = await client.command.list()
        return ok(adaptDataList(res))
      },
    },
    provider: {
      async list() {
        return ok(adaptDataList(await client.provider.list()))
      },
    },
    model: {
      async list() {
        return ok(adaptDataList(await client.model.list()))
      },
    },

    // ---------------- mcp / vcs / worktree / pty ----------------
    mcp: {
      async status() {
        const res = await client.mcp.list()
        return ok(adaptEnvelope(res))
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
          unsupported('mcp.auth.start')
        },
        async authenticate() {
          unsupported('mcp.auth.authenticate')
        },
      },
    },
    vcs: {
      async get(input: { directory?: string }) {
        return ok(adaptEnvelope(await client.vcs.get({ location: input.directory ? { directory: input.directory } : undefined })))
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
      // v2 的 worktree API 以 projectID 为键，而 v1 调用方传的是 directory；
      // 缺少稳定的 projectID 映射，暂不支持。
      async list() {
        unsupported('worktree.list')
      },
      async create() {
        unsupported('worktree.create')
      },
      async remove() {
        unsupported('worktree.remove')
      },
      async reset() {
        unsupported('worktree.reset')
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
        unsupported('instance.dispose')
      },
    },
    project: {
      async current() {
        unsupported('project.current')
      },
      async list() {
        unsupported('project.list')
      },
      async initGit() {
        unsupported('project.initGit')
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
