import { beforeEach, describe, expect, it } from 'vitest'
import { notificationStore, notificationServerId, useUnreadCompletedSessionIds } from './notificationStore'
import { readWatermarkStore } from './readWatermarkStore'

// 未读小点残留的回归保护。
// 数据源是 notificationStore 里的 completed 通知；标记已读必须能按 sessionId 清掉，
// 否则会话列表/项目行右侧的小点会一直在。

const SESSION = 'srv::ses_1'

function unreadIds(): Set<string> {
  return new Set(
    notificationStore
      .getSnapshot()
      .notifications.filter(n => n.type === 'completed' && !n.read)
      .map(n => n.sessionId),
  )
}

/** 清空已读水位（store 没有 reset()，直接清存储后 reload）。 */
function clearWatermarks(): void {
  localStorage.removeItem('opencode-read-watermarks')
  readWatermarkStore.reload()
}

describe('notificationStore 未读 completed 标记', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    // 每个用例从干净水位开始：push 现在参考水位决定 read，
    // 用例间残留水位会让「push 后应未读」的断言随执行顺序漂移。
    clearWatermarks()
  })

  it('push 后该 session 出现在未读集合中', () => {
    notificationStore.push('completed', 'Task done', 'Session completed', SESSION, '/repo')

    expect(unreadIds().has(SESSION)).toBe(true)
  })

  it('markSessionNotificationsRead 能清掉指定 session 的未读', () => {
    notificationStore.push('completed', 'Task done', 'Session completed', SESSION, '/repo')

    notificationStore.markSessionNotificationsRead(SESSION, 'completed')

    expect(unreadIds().has(SESSION)).toBe(false)
  })

  it('只清指定 session，不影响其它 session', () => {
    const other = 'srv::ses_2'
    notificationStore.push('completed', 'A', 'done', SESSION, '/repo')
    notificationStore.push('completed', 'B', 'done', other, '/repo')

    notificationStore.markSessionNotificationsRead(SESSION, 'completed')

    expect(unreadIds().has(SESSION)).toBe(false)
    expect(unreadIds().has(other)).toBe(true)
  })

  it('指定 type 时不清掉其它类型的未读', () => {
    notificationStore.push('permission', 'Perm', 'needs approval', SESSION, '/repo')
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')

    notificationStore.markSessionNotificationsRead(SESSION, 'completed')

    const remaining = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].type).toBe('permission')
  })

  it('重复标记不产生额外状态变更（幂等）', () => {
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    notificationStore.markSessionNotificationsRead(SESSION, 'completed')
    const snapshot = notificationStore.getSnapshot()

    notificationStore.markSessionNotificationsRead(SESSION, 'completed')

    expect(notificationStore.getSnapshot()).toBe(snapshot)
  })

  it('useUnreadCompletedSessionIds 的过滤口径与之一致', () => {
    // 前面的用例可能已抬高该会话水位（markRead 会写水位），这里重置，
    // 否则新通知按新语义一入队就会被判为已读。
    clearWatermarks()
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    // 该 hook 只是同一份数据的 selector 包装，这里直接验证底层过滤条件
    const ids = unreadIds()
    expect(ids.size).toBe(1)
    expect(typeof useUnreadCompletedSessionIds).toBe('function')
  })

  it('pushes a completed notification as already-read when the watermark is ahead', () => {
    // 跨端场景：另一台设备已展开该会话 → 水位抬高 → 本端后到的通知
    // 不应再亮未读点（那里对应的消息用户早已看过）。
    clearWatermarks()
    readWatermarkStore.raise('ses_1', Date.now() + 60_000)

    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')

    const entry = notificationStore.getSnapshot().notifications.find(n => n.sessionId === SESSION)
    expect(entry?.read).toBe(true)
    expect(unreadIds().has(SESSION)).toBe(false)

    clearWatermarks()
  })
})

describe('notificationStore 会话删除时清理通知', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    // 每个用例从干净水位开始：push 现在参考水位决定 read，
    // 用例间残留水位会让「push 后应未读」的断言随执行顺序漂移。
    clearWatermarks()
  })

  it('按复合 key 精确删除', () => {
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    notificationStore.removeSessionNotifications(SESSION)
    expect(unreadIds().has(SESSION)).toBe(false)
  })

  it('传裸 id 也能删掉复合 key 的通知', () => {
    // 删除入口拿到的通常是裸 id，而通知里存的是 serverId::sessionId
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    notificationStore.removeSessionNotifications('ses_1')
    expect(notificationStore.getSnapshot().notifications.length).toBe(0)
  })

  it('不影响其它 session 的通知', () => {
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    notificationStore.push('completed', 'Done', 'completed', 'srv::ses_2', '/repo')
    notificationStore.removeSessionNotifications('ses_1')
    const remaining = notificationStore.getSnapshot().notifications
    expect(remaining.length).toBe(1)
    expect(remaining[0].sessionId).toBe('srv::ses_2')
  })

  it('空 id 不做任何事', () => {
    notificationStore.push('completed', 'Done', 'completed', SESSION, '/repo')
    notificationStore.removeSessionNotifications('')
    expect(notificationStore.getSnapshot().notifications.length).toBe(1)
  })

  it('后缀匹配不会误伤前缀相同的 session', () => {
    // 'ses_1' 不应匹配到 'ses_10'
    notificationStore.push('completed', 'Done', 'completed', 'srv::ses_10', '/repo')
    notificationStore.removeSessionNotifications('ses_1')
    expect(notificationStore.getSnapshot().notifications.length).toBe(1)
  })
})

describe('notificationStore 跨前缀匹配（同一会话多条 SSE）', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    // 每个用例从干净水位开始：push 现在参考水位决定 read，
    // 用例间残留水位会让「push 后应未读」的断言随执行顺序漂移。
    clearWatermarks()
  })

  // 场景来源：两台已连接服务器指向同一后端时，同一个 session 会被两条 SSE
  // 各推一份通知，前缀不同（local:: 与 aiagent:inst_...::）。清理必须只按
  // 裸 sessionId 匹配，否则当前焦点前缀之外的那份永远清不掉。
  const REMOTE = 'aiagent:inst_x::ses_shared'
  const LOCAL = 'local::ses_shared'

  it('标记已读时按裸 id 匹配另一前缀的通知', () => {
    notificationStore.push('completed', 'Done', 'completed', REMOTE, '/repo')
    notificationStore.push('completed', 'Done', 'completed', LOCAL, '/repo')

    notificationStore.markSessionNotificationsRead(REMOTE, 'completed')

    // 两份都应被标为已读
    const unread = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(unread.length).toBe(0)
  })

  it('删除会话时两个前缀的通知都被清掉', () => {
    notificationStore.push('completed', 'Done', 'completed', REMOTE, '/repo')
    notificationStore.push('question', 'Q', 'question', LOCAL, '/repo')
    notificationStore.push('completed', 'Other', 'completed', 'local::ses_other', '/repo')

    notificationStore.removeSessionNotifications('ses_shared')

    const remaining = notificationStore.getSnapshot().notifications
    expect(remaining.length).toBe(1)
    expect(remaining[0].sessionId).toBe('local::ses_other')
  })

  it('不同 session 不会被误伤', () => {
    notificationStore.push('completed', 'Done', 'completed', 'local::ses_a', '/repo')
    notificationStore.push('completed', 'Done', 'completed', 'local::ses_b', '/repo')

    notificationStore.removeSessionNotifications('ses_a')

    const remaining = notificationStore.getSnapshot().notifications
    expect(remaining.length).toBe(1)
    expect(remaining[0].sessionId).toBe('local::ses_b')
  })
})

describe('notificationStore serverId 归属', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    // 每个用例从干净水位开始：push 现在参考水位决定 read，
    // 用例间残留水位会让「push 后应未读」的断言随执行顺序漂移。
    clearWatermarks()
  })

  it('push 时从复合 key 记录 serverId', () => {
    notificationStore.push('completed', 'Done', 'completed', 'aiagent:inst_x::ses_1', '/repo')
    const [entry] = notificationStore.getSnapshot().notifications
    expect(entry.serverId).toBe('aiagent:inst_x')
    expect(notificationServerId(entry)).toBe('aiagent:inst_x')
  })

  it('旧数据没有 serverId 字段时从复合 key 反解', () => {
    const entry = {
      id: 'legacy',
      type: 'completed' as const,
      title: 'Done',
      body: 'completed',
      sessionId: 'remote::ses_legacy',
      directory: '/repo',
      timestamp: 0,
      read: false,
    }
    expect(notificationServerId(entry)).toBe('remote')
  })
})

describe('notificationStore 已读水位跨端同步', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    localStorage.removeItem('opencode-read-watermarks')
    readWatermarkStore.reload()
  })

  it('标记已读后写入水位（供其它端同步）', () => {
    notificationStore.push('completed', 'Done', 'completed', 'local::ses_w', '/repo')
    notificationStore.markSessionNotificationsRead('local::ses_w', 'completed')
    expect(readWatermarkStore.get('ses_w')).toBeGreaterThan(0)
  })

  it('外部水位更新后本端未读点消失（模拟另一端已读）', () => {
    notificationStore.push('completed', 'Done', 'completed', 'local::ses_w', '/repo')
    const entry = notificationStore.getSnapshot().notifications[0]
    // 模拟偏好同步 pull 到另一端的已读水位（高于该通知时间戳）
    localStorage.setItem('opencode-read-watermarks', JSON.stringify({ ses_w: entry.timestamp + 1 }))
    readWatermarkStore.reload()
    expect(unreadIds().has('local::ses_w')).toBe(false)
  })

  it('水位不高于通知时间戳时仍为未读', () => {
    notificationStore.push('completed', 'Done', 'completed', 'local::ses_w', '/repo')
    const entry = notificationStore.getSnapshot().notifications[0]
    localStorage.setItem('opencode-read-watermarks', JSON.stringify({ ses_w: entry.timestamp - 1 }))
    readWatermarkStore.reload()
    expect(unreadIds().has('local::ses_w')).toBe(true)
  })

  it('水位只治理 completed，不影响 permission 未读', () => {
    notificationStore.push('permission', 'Perm', 'needs approval', 'local::ses_w', '/repo')
    const entry = notificationStore.getSnapshot().notifications[0]
    localStorage.setItem('opencode-read-watermarks', JSON.stringify({ ses_w: entry.timestamp + 1 }))
    readWatermarkStore.reload()
    const unread = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(unread).toHaveLength(1)
    expect(unread[0].type).toBe('permission')
  })
})

describe('notificationStore 按目录批量已读', () => {
  beforeEach(() => {
    notificationStore.clearAll()
    // 每个用例从干净水位开始：push 现在参考水位决定 read，
    // 用例间残留水位会让「push 后应未读」的断言随执行顺序漂移。
    clearWatermarks()
  })

  it('清掉指定服务器 + 目录下的未读 completed', () => {
    notificationStore.push('completed', 'A', 'done', 'local::ses_a', '/repo')
    notificationStore.push('completed', 'B', 'done', 'local::ses_b', '/repo')

    notificationStore.markDirectoryNotificationsRead('local', ['/repo'], 'completed')

    const unread = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(unread).toHaveLength(0)
  })

  it('不误伤另一台服务器同路径的通知', () => {
    notificationStore.push('completed', 'A', 'done', 'local::ses_a', '/repo')
    notificationStore.push('completed', 'B', 'done', 'aiagent:inst_x::ses_b', '/repo')

    notificationStore.markDirectoryNotificationsRead('local', ['/repo'], 'completed')

    const unread = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(unread).toHaveLength(1)
    expect(unread[0].sessionId).toBe('aiagent:inst_x::ses_b')
  })

  it('目录路径大小写与斜杠差异视为同一目录', () => {
    notificationStore.push('completed', 'A', 'done', 'local::ses_a', 'E:\\Repo\\Project\\')

    notificationStore.markDirectoryNotificationsRead('local', ['e:/repo/project'], 'completed')

    expect(notificationStore.getSnapshot().notifications.filter(n => !n.read)).toHaveLength(0)
  })

  it('不误伤同服务器的其他目录', () => {
    notificationStore.push('completed', 'A', 'done', 'local::ses_a', '/repo-a')
    notificationStore.push('completed', 'B', 'done', 'local::ses_b', '/repo-b')

    notificationStore.markDirectoryNotificationsRead('local', ['/repo-a'], 'completed')

    const unread = notificationStore.getSnapshot().notifications.filter(n => !n.read)
    expect(unread).toHaveLength(1)
    expect(unread[0].directory).toBe('/repo-b')
  })

  it('目录列表为空时不做任何事', () => {
    notificationStore.push('completed', 'A', 'done', 'local::ses_a', '/repo')
    notificationStore.markDirectoryNotificationsRead('local', [], 'completed')
    expect(notificationStore.getSnapshot().notifications.filter(n => !n.read)).toHaveLength(1)
  })
})
