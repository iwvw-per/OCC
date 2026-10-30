import { describe, expect, it } from 'vitest'
import { buildFolderStatus } from './folderStatus'
import type { NotificationEntry } from '../../../store/notificationStore'
import type { ActiveSessionEntry } from '../../../store/activeSessionStore'

// 项目行状态汇总的回归保护。
//
// 关键约束：
// 1. 必须按 serverId 收窄，避免另一台服务器同名路径的状态/未读挂到本行
// 2. 状态优先级：permission > question > retry > working > unread
// 3. working 与会话行一致，UI 用旋转动画而不是圆点

const t = (key: string) => key

function busy(
  sessionId: string,
  directory: string,
  extra: Partial<Omit<ActiveSessionEntry, 'sessionId' | 'status'>> & { status?: ActiveSessionEntry['status'] } = {},
): ActiveSessionEntry {
  return { sessionId, directory, status: extra.status ?? { type: 'busy' }, source: 'server', ...extra }
}

function notif(sessionId: string, directory: string, overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: `n_${sessionId}`,
    type: 'completed',
    title: 'Done',
    body: 'Session completed',
    sessionId,
    directory,
    timestamp: 0,
    read: false,
    ...overrides,
  }
}

describe('buildFolderStatus', () => {
  it('无活跃会话且无未读时返回 null', () => {
    expect(
      buildFolderStatus({ serverId: 'local', directories: ['/repo'], busySessions: [], notifications: [], t }),
    ).toBeNull()
  })

  it('会话正在跑时返回 working（UI 用旋转动画）', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [busy('local::ses_1', '/repo')],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('working')
    expect(status?.count).toBe(1)
  })

  it('permission 优先于 working', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [
        busy('local::ses_1', '/repo'),
        busy('local::ses_2', '/repo', { pendingAction: { type: 'permission' } }),
      ],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('permission')
    expect(status?.count).toBe(2)
  })

  it('只有未回复请求、服务端已 idle 的会话不算运行中', () => {
    // 一个从没被点开的权限请求会让折叠目录一直转圈：它并不在跑。
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [busy('local::ses_1', '/repo', { source: 'pending' })],
      notifications: [],
      t,
    })
    expect(status).toBeNull()
  })

  it('pending 与真正运行中的会话并存时按运行中展示', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [
        busy('local::ses_1', '/repo', { source: 'server' }),
        busy('local::ses_2', '/repo', { source: 'pending' }),
      ],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('working')
  })

  it('question 优先于 retry 和 working，但低于 permission', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [
        busy('local::ses_1', '/repo', { status: { type: 'retry', attempt: 1, message: 'x', next: 0 } }),
        busy('local::ses_2', '/repo', { pendingAction: { type: 'question' } }),
      ],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('question')
  })

  it('retry 优先于 working', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [
        busy('local::ses_1', '/repo'),
        busy('local::ses_2', '/repo', { status: { type: 'retry', attempt: 2, message: 'rate limited', next: 5 } }),
      ],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('retry')
  })

  it('不把另一台服务器同路径的活跃会话算进来', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [busy('aiagent:inst_x::ses_1', '/repo')],
      notifications: [],
      t,
    })
    expect(status).toBeNull()
  })

  it('不把另一台服务器同路径的未读通知算进来', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [],
      notifications: [notif('aiagent:inst_x::ses_1', '/repo')],
      t,
    })
    expect(status).toBeNull()
  })

  it('未读 completed 返回 unread', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [],
      notifications: [notif('local::ses_1', '/repo')],
      t,
    })
    expect(status?.kind).toBe('unread')
  })

  it('已读通知不触发 unread', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [],
      notifications: [notif('local::ses_1', '/repo', { read: true })],
      t,
    })
    expect(status).toBeNull()
  })

  it('活跃会话优先于未读点', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [busy('local::ses_1', '/repo')],
      notifications: [notif('local::ses_2', '/repo')],
      t,
    })
    expect(status?.kind).toBe('working')
  })

  it('目录路径大小写与斜杠差异视为同一目录', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['e:/repo/project'],
      busySessions: [busy('local::ses_1', 'E:\\Repo\\Project\\')],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('working')
  })

  it('目录列表为空时返回 null', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: [],
      busySessions: [busy('local::ses_1', '/repo')],
      notifications: [notif('local::ses_2', '/repo')],
      t,
    })
    expect(status).toBeNull()
  })

  it('无 serverId 字段的旧通知从复合 key 反解归属', () => {
    const legacy = notif('local::ses_old', '/repo')
    delete legacy.serverId
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo'],
      busySessions: [],
      notifications: [legacy],
      t,
    })
    expect(status?.kind).toBe('unread')
  })
})

describe('busy 会话缺少 directory 时项目行识别不到（回归）', () => {
  /**
   * `/api/session/active` 只返回 `{type:'running'}`，不带目录；项目行靠
   * `entry.directory` 把 busy 会话归到项目。若 meta 还没写入（会话在应用启动前
   * 就在跑，或「先收到 busy、后收到 updated」），项目行就不转圈 ——
   * 表现为「侧栏收起了，看不到运行状态」。
   *
   * 修复点在写入侧（useGlobalEvents / useChatSession 补 directory），
   * 这里固住「有 directory 才能识别」这一事实，防止有人误以为可以放宽。
   */
  it('directory 缺失时返回 null（说明必须在写入侧补目录）', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo/BetterScene'],
      busySessions: [
        { sessionId: 'local::ses_x', directory: undefined, status: { type: 'busy' }, source: 'server' },
      ],
      notifications: [],
      t,
    })
    expect(status).toBeNull()
  })

  it('补上 directory 后能识别为运行中', () => {
    const status = buildFolderStatus({
      serverId: 'local',
      directories: ['/repo/BetterScene'],
      busySessions: [
        {
          sessionId: 'local::ses_x',
          directory: '/repo/BetterScene',
          status: { type: 'busy' },
          source: 'server',
        },
      ],
      notifications: [],
      t,
    })
    expect(status?.kind).toBe('working')
  })
})
