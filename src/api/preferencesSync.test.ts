import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const TOMBSTONES_KEY = 'opencode-preferences-sync-tombstones'


describe('preferences sync', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function seedAccount() {
    const { login } = await import('./aiagent')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/aiagent/auth/login')) {
        return new Response(JSON.stringify({ success: true, data: { token: 'tok-sync' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return login('panel.example.com', 'salen', 'secret-pass-1')
  }

  function stubPreferencesFetch(
    items: unknown,
    onPut?: (url: string, body: Record<string, unknown>) => void,
  ) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        onPut?.(url, body)
        return new Response(JSON.stringify({ success: true, data: { written: Object.keys(body.values ?? {}) } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/aiagent/preferences')) {
        return new Response(JSON.stringify({ success: true, data: items }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends If-None-Match and skips merge on 304', async () => {
    const account = await seedAccount()
    localStorage.setItem('theme-preset', '0.5')
    // 首次拉取：服务端返回内容并下发 ETag。
    const ETAG = '"abc123"'
    let getCalls = 0
    let sawIfNoneMatch: string | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ success: true, data: { written: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/aiagent/preferences')) {
        getCalls += 1
        const headers = new Headers(init?.headers)
        sawIfNoneMatch = headers.get('If-None-Match')
        if (sawIfNoneMatch === ETAG) {
          // 304：无响应体。
          return new Response(null, { status: 304, headers: { ETag: ETAG } })
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ key: 'theme-preset', value: '0.1', updatedAt: '2030-01-01T00:00:00.000Z' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ETag: ETAG } },
        )
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { pullPreferences } = await import('./preferencesSync')

    // 第一次：无 If-None-Match，拿到数据并记住 ETag。
    const first = await pullPreferences(account)
    expect(sawIfNoneMatch).toBeNull()
    expect(first).toBe(1)
    expect(localStorage.getItem('theme-preset')).toBe('0.1')

    // 第二次：带上 ETag，服务端回 304，不产生任何写入。
    const second = await pullPreferences(account)
    expect(sawIfNoneMatch).toBe(ETAG)
    expect(second).toBe(0)
    expect(getCalls).toBe(2)
  })

  it('admits exactly the cross-device data families', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    // 项目列表（按服务器分桶）
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-saved-directories')).toBe(true)
    // 置顶：per-server 分桶；裸键形态保留兼容
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-pinned-sessions')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-pinned-messages')).toBe(true)
    expect(isSyncableKey('opencode-pinned-sessions')).toBe(true)
    expect(isSyncableKey('opencode-pinned-messages')).toBe(true)
    // 模型可见性 / 置顶模型：一端隐藏了模型，另一端还列出来会被当成 bug
    expect(isSyncableKey('srv:aiagent:inst_1:hidden-model-keys')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:model-pinned')).toBe(true)
    // 单调计数（逐键取 max，天然无冲突）
    expect(isSyncableKey('opencode-read-watermarks')).toBe(true)
    expect(isSyncableKey('opencode-project-last-used')).toBe(true)
    // 主题
    expect(isSyncableKey('theme-preset')).toBe(true)
    expect(isSyncableKey('theme-mode')).toBe(true)
  })

  it('no longer syncs personalization settings', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    // 外观 / 布局 / 字号：不再跨端同步（见文件头「个性化设置不同步」）
    for (const key of [
      'chat-content-width',
      'code-word-wrap',
      'collapse-user-messages',
      'descriptive-tool-steps',
      'diff-style',
      'font-scale',
      'glass-effect',
      'i18nextLng',
      'reasoning-display-mode',
      'sidebar-width',
      'theme-custom-css',
    ]) {
      expect(isSyncableKey(key), key).toBe(false)
    }

    // 音效 / 通知 / 设备相关
    for (const key of [
      'opencode:sound-settings',
      'opencode:toast-enabled',
      'opencode:update-check',
      'opencode:haptic-settings',
      'opencode:large-text-paste',
      'opencode-keybindings',
      'opencode-sidebar-project-sort',
      'opencode-right-panel-width',
    ]) {
      expect(isSyncableKey(key), key).toBe(false)
    }
  })

  it('rejects UI open/collapse state so panels do not fight across devices', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    // 侧栏、面板、工作状态板块的开合是当前这一屏的浏览状态，不是偏好：
    // 同步会让一端展开后另一端被同步折叠，反复拉锯。
    expect(isSyncableKey('opencode-sidebar-expanded')).toBe(false)
    expect(isSyncableKey('opencode-sidebar-expanded-projects')).toBe(false)
    expect(isSyncableKey('opencode-panel-layout')).toBe(false)
    expect(isSyncableKey('opencode-work-status-enabled')).toBe(false)
    expect(isSyncableKey('opencode-work-status-expanded')).toBe(false)

    // 项目列表本身仍是偏好，继续同步
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-saved-directories')).toBe(true)
  })

  it('rejects per-server settings other than the project list', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    // 只有 saved-directories 一个 srv 键参与同步，其余 per-server 设置不下发
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-saved-directories')).toBe(true)
    for (const key of [
      'srv:aiagent:inst_1:model-variant-prefs',
      'srv:aiagent:inst_1:opencode-detected-path-style',
      'srv:aiagent:inst_1:selected-model-key',
      'srv:aiagent:inst_1:session-model-selection',
      'srv:aiagent:inst_1:last-directory',
      'srv:aiagent:inst_1:model-usage-stats',
      'srv:aiagent:inst_1:opencode-recent-projects',
    ]) {
      expect(isSyncableKey(key), key).toBe(false)
    }
  })

  it('rejects credentials, machine-local keys and other srv buckets', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    expect(isSyncableKey('webRcloneAuth')).toBe(false)
    expect(isSyncableKey('tileboard_cache_x')).toBe(false)
    expect(isSyncableKey('ai-draw-nexus-chat-storage')).toBe(false)
    expect(isSyncableKey('dashboard_api_stats_cache_v1')).toBe(false)
    expect(isSyncableKey('debug-err')).toBe(false)
    expect(isSyncableKey('unrelated-key')).toBe(false)

    expect(isSyncableKey('opencode-aiagent-account')).toBe(false)
    expect(isSyncableKey('opencode-preferences-sync-meta')).toBe(false)
    expect(isSyncableKey('opencode-preferences-sync-stamps')).toBe(false)
    expect(isSyncableKey('opencode-preferences-sync-tombstones')).toBe(false)

    expect(isSyncableKey('opencode-servers')).toBe(false)
    expect(isSyncableKey('opencode-active-server')).toBe(false)
    expect(isSyncableKey('opencode-binary-path')).toBe(false)
    expect(isSyncableKey('opencode-auto-start-service')).toBe(false)
    expect(isSyncableKey('opencode-service-env-vars')).toBe(false)
    expect(isSyncableKey('opencode-terminal-layout')).toBe(false)
    // 通知历史含逐条已读标志，属本机运行时状态：同步会让已读被旧未读覆盖
    expect(isSyncableKey('opencode:notifications')).toBe(false)

    expect(isSyncableKey('srv:local:opencode-hidden-directories')).toBe(false)
    expect(isSyncableKey('srv:server-1:opencode-pinned-sessions')).toBe(false)
    expect(isSyncableKey('last-directory')).toBe(false)
    expect(isSyncableKey('selected-project-id')).toBe(false)
    expect(isSyncableKey('model-usage-stats')).toBe(false)
  })

  it('collects only whitelisted keys from localStorage', async () => {
    localStorage.setItem('theme-preset', '0.1')
    localStorage.setItem('theme-preset', '"eucalyptus"')
    localStorage.setItem('i18nextLng', 'zh-CN')
    localStorage.setItem('opencode:notifications', '{"enabled":true}')
    localStorage.setItem('opencode:sound-settings', '{"enabled":true}')
    localStorage.setItem('opencode-keybindings', '{}')
    localStorage.setItem('srv:aiagent:inst_1:selected-agent:pane-1', '"build"')
    localStorage.setItem('opencode-servers', '[{"url":"http://localhost"}]')
    localStorage.setItem('opencode-active-server', 'aiagent:inst_1')
    localStorage.setItem('opencode-aiagent-account', '{"token":"should-not-sync"}')
    localStorage.setItem('srv:aiagent:inst_1:last-directory', 'D:/work')
    localStorage.setItem('srv:local:opencode-hidden-directories', '["/secret"]')
    localStorage.setItem('webRcloneAuth', 'Basic c2FsZW46c3NsbjUwMTQu')
    localStorage.setItem('unrelated-key', 'nope')

    const { collectLocalPreferences } = await import('./preferencesSync')
    const entries = collectLocalPreferences()

    expect(entries['theme-preset']).toBe('"eucalyptus"')
    // 个性化设置与 per-server 其它设置已不再同步
    expect(entries['i18nextLng']).toBeUndefined()
    expect(entries['opencode:sound-settings']).toBeUndefined()
    expect(entries['opencode-keybindings']).toBeUndefined()
    expect(entries['srv:aiagent:inst_1:selected-agent:pane-1']).toBeUndefined()

    expect(entries['opencode:notifications']).toBeUndefined()
    expect(entries['opencode-servers']).toBeUndefined()
    expect(entries['opencode-active-server']).toBeUndefined()
    expect(entries['opencode-aiagent-account']).toBeUndefined()
    expect(entries['srv:aiagent:inst_1:last-directory']).toBeUndefined()
    expect(entries['srv:local:opencode-hidden-directories']).toBeUndefined()
    expect(entries['webRcloneAuth']).toBeUndefined()
    expect(entries['unrelated-key']).toBeUndefined()
  })

  it('pushes with lastWriteWins and per-key timestamps', async () => {
    await seedAccount()
    localStorage.setItem('theme-mode', '"markers"')
    localStorage.setItem('theme-preset', '"sakura"')

    let putUrl = ''
    let sentBody: Record<string, unknown> | null = null
    const fetchMock = stubPreferencesFetch([], (url, body) => {
      putUrl = url
      sentBody = body
    })

    const { pushPreferences } = await import('./preferencesSync')
    const written = await pushPreferences()
    expect(written).toBe(2)
    expect(putUrl).toContain('lastWriteWins=1')

    const values = sentBody as unknown as { values: Record<string, unknown> }
    const updatedAt = sentBody as unknown as { updatedAt: Record<string, string> }
    expect(values.values['theme-mode']).toEqual('markers')
    expect(values.values['theme-preset']).toBe('sakura')
    expect(values.values['opencode-aiagent-account']).toBeUndefined()
    expect(Object.keys(updatedAt.updatedAt).sort()).toEqual(['theme-mode', 'theme-preset'])

    const firstDiffStamp = updatedAt.updatedAt['theme-mode']

    const callsBefore = fetchMock.mock.calls.length
    localStorage.setItem('theme-preset', '"ocean"')
    const second = await pushPreferences()
    // 增量推送：只有改动的 theme-preset 会上传，theme-mode 与基线一致被跳过
    expect(second).toBe(1)
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1)

    const secondBody = sentBody as unknown as {
      values: Record<string, unknown>
      updatedAt: Record<string, string>
    }
    expect(Object.keys(secondBody.values)).toEqual(['theme-preset'])
    expect(secondBody.updatedAt['theme-mode']).toBeUndefined()
    expect(secondBody.updatedAt['theme-preset']).not.toBe(firstDiffStamp)

    const afterChange = fetchMock.mock.calls.length
    const third = await pushPreferences()
    expect(third).toBe(0)
    expect(fetchMock.mock.calls.length).toBe(afterChange)
  })

  it('uses the current time for every key on the first sync', async () => {
    await seedAccount()
    localStorage.setItem('theme-preset', '0.2')

    let sentBody: Record<string, unknown> | null = null
    stubPreferencesFetch([], (_url, body) => {
      sentBody = body
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences()

    const stamps = (sentBody as unknown as { updatedAt: Record<string, string> }).updatedAt
    expect(stamps['theme-preset']).toBeTruthy()
    expect(Number.isNaN(Date.parse(stamps['theme-preset']))).toBe(false)
  })

  it('does not overwrite a newer local value with an older server value', async () => {
    const account = await seedAccount()
    localStorage.setItem('theme-preset', '"local-newer"')
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({ stamps: { 'theme-preset': '2030-01-01T00:00:00.000Z' }, known: {} }),
    )

    stubPreferencesFetch([{ key: 'theme-preset', value: '"server-older"', updatedAt: '2020-01-01T00:00:00.000Z' }])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)
    // 服务端值更旧：本地保留
    expect(localStorage.getItem('theme-preset')).toBe('"local-newer"')
  })

  it('does not let a pull clobber a local edit made since the last push', async () => {
    // 竞态：syncPreferences 先 pull 再 push。用户在两次同步之间改了本地值，
    // 本地戳还停在上一轮同步时间，服务端值的时间戳与之相等或更晚，pull 就会把
    // 用户的改动覆盖掉，表现为「改了没反应」。这里用 sidebar-width 代表所有
    // 仍在同步的标量偏好。
    const account = await seedAccount()
    const STAMP = '2026-09-22T10:00:00.000Z'
    // 基线里记录上一轮同步后的值（260），本地此刻已被用户改成 300
    localStorage.setItem('sidebar-width', '300')
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { 'sidebar-width': STAMP },
        known: { 'sidebar-width': '260' },
      }),
    )

    stubPreferencesFetch([{ key: 'sidebar-width', value: '260', updatedAt: STAMP }])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    // 本地未推送的改动必须保住，不能被服务端的旧值盖回
    expect(localStorage.getItem('sidebar-width')).toBe('300')
  })

  it('pulls server preferences into localStorage', async () => {
    const account = await seedAccount()
    const localToken = JSON.parse(localStorage.getItem('opencode-aiagent-account') || '{}').token

    stubPreferencesFetch([
      { key: 'theme-preset', value: '"eucalyptus"', updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'theme-mode', value: '"dark"', updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'opencode-aiagent-account', value: { token: 'must-be-ignored' }, updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'opencode-servers', value: [{ url: 'http://evil' }], updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'srv:local:opencode-hidden-directories', value: ['/other'], updatedAt: '2030-01-01T00:00:00Z' },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    const written = await pullPreferences(account)
    expect(written).toBe(2)

    expect(localStorage.getItem('theme-preset')).toBe('"eucalyptus"')
    expect(localStorage.getItem('theme-mode')).toBe('"dark"')
    expect(JSON.parse(localStorage.getItem('opencode-aiagent-account') || '{}').token).toBe(localToken)
    expect(localStorage.getItem('opencode-servers')).toBeNull()
    expect(localStorage.getItem('srv:local:opencode-hidden-directories')).toBeNull()
  })

  it('merges pinned sessions as a deduplicated union', async () => {
    const account = await seedAccount()
    localStorage.setItem(
      'opencode-pinned-sessions',
      JSON.stringify([{ sessionId: 'local-1', directory: '/local', title: 'Local' }]),
    )

    stubPreferencesFetch([
      {
        key: 'opencode-pinned-sessions',
        value: [
          { sessionId: 'server-1', directory: '/server', title: 'Server' },
          { sessionId: 'local-1', directory: '/server', title: 'Server copy' },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem('opencode-pinned-sessions') || '[]')
    expect(merged.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['local-1', 'server-1'])
    // 同 id 重复时保留本地那条（本地顺序优先），不被服务端的旧副本覆盖标题。
    expect(merged[0].title).toBe('Local')
  })

  it('merges read watermarks by taking the max per session', async () => {
    const account = await seedAccount()
    // 本地：ses_a 水位 1000，ses_local 仅本地有
    localStorage.setItem(
      'opencode-read-watermarks',
      JSON.stringify({ ses_a: 1000, ses_local: 500 }),
    )

    stubPreferencesFetch([
      {
        key: 'opencode-read-watermarks',
        // 服务端：ses_a 更高（另一端读得更晚）、ses_server 仅服务端有
        value: { ses_a: 2000, ses_server: 3000 },
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem('opencode-read-watermarks') || '{}')
    // 逐键取最大：ses_a 取 2000；并集保留 ses_local / ses_server
    expect(merged.ses_a).toBe(2000)
    expect(merged.ses_local).toBe(500)
    expect(merged.ses_server).toBe(3000)
  })

  it('merges project last-used watermarks by taking the max per directory', async () => {
    const account = await seedAccount()
    // 本地：/a 记录 1000，/local-only 仅本地有
    localStorage.setItem(
      'opencode-project-last-used',
      JSON.stringify({ '/a': 1000, '/local-only': 500 }),
    )

    stubPreferencesFetch([
      {
        key: 'opencode-project-last-used',
        // 服务端：/a 更高（另一端更晚活动）、/server-only 仅服务端有
        value: { '/a': 2000, '/server-only': 3000 },
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem('opencode-project-last-used') || '{}')
    expect(merged['/a']).toBe(2000)
    expect(merged['/local-only']).toBe(500)
    expect(merged['/server-only']).toBe(3000)
  })

  it('merges per-server saved directories as a union', async () => {
    // per-server 只有项目列表参与同步（其它 srv 键已下线，见白名单）。
    const account = await seedAccount()
    localStorage.setItem(
      'srv:aiagent:inst_1:opencode-saved-directories',
      JSON.stringify([{ path: '/a', name: 'A', addedAt: 1 }]),
    )

    stubPreferencesFetch([
      {
        key: 'srv:aiagent:inst_1:opencode-saved-directories',
        value: [
          { path: '/a', name: 'A server', addedAt: 5 },
          { path: '/b', name: 'B', addedAt: 2 },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const saved = JSON.parse(localStorage.getItem('srv:aiagent:inst_1:opencode-saved-directories') || '[]')
    expect(saved.map((entry: { path: string }) => entry.path)).toEqual(['/a', '/b'])
    // 同 path 重复时保留本地那条（本地顺序优先），不被服务端的旧副本覆盖名称。
    expect(saved[0].name).toBe('A')
  })

  it('adopts the newer side order for saved directories when local is unchanged', async () => {
    // 本地相对基线没变、服务端更新 → 顺序跟随服务端（拖拽重排可跨端生效）。
    const account = await seedAccount()
    const key = 'srv:aiagent:inst_1:opencode-saved-directories'
    const base = [
      { path: '/a', name: 'A', addedAt: 1 },
      { path: '/b', name: 'B', addedAt: 2 },
    ]
    localStorage.setItem(key, JSON.stringify(base))
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { [key]: '2020-01-01T00:00:00.000Z' },
        known: { __snapshot__: JSON.stringify({ [key]: JSON.stringify(base) }) },
      }),
    )

    stubPreferencesFetch([
      {
        key,
        value: [
          { path: '/b', name: 'B', addedAt: 2 },
          { path: '/a', name: 'A', addedAt: 1 },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const saved = JSON.parse(localStorage.getItem(key) || '[]')
    expect(saved.map((entry: { path: string }) => entry.path)).toEqual(['/b', '/a'])
  })

  it('keeps local order when local has an unsynced reorder', async () => {
    // 本地相对基线变了（尚未上传的拖拽）→ 本地顺序优先，不被服务端冲掉。
    const account = await seedAccount()
    const key = 'srv:aiagent:inst_1:opencode-saved-directories'
    const base = [
      { path: '/a', name: 'A', addedAt: 1 },
      { path: '/b', name: 'B', addedAt: 2 },
    ]
    const localReordered = [
      { path: '/b', name: 'B', addedAt: 2 },
      { path: '/a', name: 'A', addedAt: 1 },
    ]
    localStorage.setItem(key, JSON.stringify(localReordered))
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { [key]: '2020-01-01T00:00:00.000Z' },
        known: { __snapshot__: JSON.stringify({ [key]: JSON.stringify(base) }) },
      }),
    )

    stubPreferencesFetch([
      {
        key,
        value: [
          { path: '/a', name: 'A', addedAt: 1 },
          { path: '/b', name: 'B', addedAt: 2 },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const saved = JSON.parse(localStorage.getItem(key) || '[]')
    expect(saved.map((entry: { path: string }) => entry.path)).toEqual(['/b', '/a'])
  })

  it('ignores legacy hidden-directories now that it is off the whitelist', async () => {
    // opencode-hidden-directories 已不在同步白名单：服务端即使仍存有这个键，
    // 拉取时也必须被忽略，不能写进本地。
    const account = await seedAccount()

    stubPreferencesFetch([
      {
        key: 'srv:aiagent:inst_1:opencode-hidden-directories',
        value: ['/server-only'],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(localStorage.getItem('srv:aiagent:inst_1:opencode-hidden-directories')).toBeNull()
  })

  it('blocks a deleted entry from being resurrected through the union', async () => {
    const account = await seedAccount()
    localStorage.setItem(
      'opencode-pinned-sessions',
      JSON.stringify([{ sessionId: 'keep', directory: '/keep', title: 'Keep' }]),
    )
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({ 'opencode-pinned-sessions': { dead: Date.now() } }))

    stubPreferencesFetch([
      {
        key: 'opencode-pinned-sessions',
        value: [
          { sessionId: 'dead', directory: '/dead', title: 'Dead' },
          { sessionId: 'keep', directory: '/keep', title: 'Keep' },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem('opencode-pinned-sessions') || '[]')
    expect(merged.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['keep'])
  })

  it('blocks a per-server deleted entry from being resurrected', async () => {
    const account = await seedAccount()
    const key = 'srv:aiagent:inst_1:opencode-pinned-sessions'
    localStorage.setItem(key, JSON.stringify([{ sessionId: 'keep', directory: '/keep', title: 'Keep' }]))
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({ [key]: { dead: Date.now() } }))

    stubPreferencesFetch([
      {
        key,
        value: [
          { sessionId: 'dead', directory: '/dead', title: 'Dead' },
          { sessionId: 'keep', directory: '/keep', title: 'Keep' },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem(key) || '[]')
    expect(merged.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['keep'])
  })

  it('drops expired tombstones', async () => {
    const account = await seedAccount()
    localStorage.setItem('opencode-pinned-sessions', JSON.stringify([]))
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify({ 'opencode-pinned-sessions': { expired: Date.now() - 31 * 24 * 60 * 60 * 1000 } }),
    )

    stubPreferencesFetch([
      {
        key: 'opencode-pinned-sessions',
        value: [{ sessionId: 'expired', directory: '/e', title: 'E' }],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const merged = JSON.parse(localStorage.getItem('opencode-pinned-sessions') || '[]')
    expect(merged.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['expired'])
  })

  it('records a tombstone when an entry is removed locally', async () => {
    await seedAccount()
    const snapshot = JSON.stringify({
      'opencode-pinned-sessions': JSON.stringify([
        { sessionId: 'a', directory: '/a', title: 'A' },
        { sessionId: 'b', directory: '/b', title: 'B' },
      ]),
    })
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify({ stamps: {}, known: { __snapshot__: snapshot } }))
    localStorage.setItem(
      'opencode-pinned-sessions',
      JSON.stringify([{ sessionId: 'a', directory: '/a', title: 'A' }]),
    )

    let sentBody: Record<string, unknown> | null = null
    stubPreferencesFetch([], (_url, body) => {
      sentBody = body
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences()

    const tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}')
    expect(tombstones['opencode-pinned-sessions'].b).toBeTypeOf('number')
    expect(tombstones['opencode-pinned-sessions'].a).toBeUndefined()
    const values = (sentBody as unknown as { values: Record<string, unknown> }).values
    expect(values['opencode-pinned-sessions']).toEqual([{ sessionId: 'a', directory: '/a', title: 'A' }])
  })

  it('records a tombstone when the last entry is removed and the key disappears', async () => {
    await seedAccount()
    const key = 'srv:aiagent:inst_1:opencode-pinned-sessions'
    const snapshot = JSON.stringify({
      [key]: JSON.stringify([{ sessionId: 'only', directory: '/only', title: 'Only' }]),
    })
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify({ stamps: {}, known: { __snapshot__: snapshot } }))
    localStorage.removeItem(key)

    stubPreferencesFetch([], () => {})

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences()

    const tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}')
    expect(tombstones[key].only).toBeTypeOf('number')
  })

  it('keeps instance buckets isolated (no cross-instance merge)', async () => {
    // 各实例的 saved-directories 必须互不干扰：跨实例并集会把工作机的 D:/Code/*
    // 带进笔电的项目列表，出现本机不存在的幽灵目录。
    const account = await seedAccount()
    const { serverStore } = await import('../store/serverStore')

    serverStore.addServerWithId('aiagent:inst_work', { name: 'work', url: 'https://panel.example.com/gw/inst_work' })
    serverStore.setActiveServer('aiagent:inst_work')
    localStorage.setItem(
      'srv:aiagent:inst_work:opencode-saved-directories',
      JSON.stringify([{ path: 'D:/Code/API-Monitor', name: 'API-Monitor', addedAt: 1 }]),
    )
    localStorage.setItem(
      'srv:aiagent:inst_laptop:opencode-saved-directories',
      JSON.stringify([{ path: 'E:/Code/OpenCodeUI', name: 'OpenCodeUI', addedAt: 2 }]),
    )

    let sentValues: Record<string, unknown> = {}
    stubPreferencesFetch([], (_url, body) => {
      sentValues = body.values as Record<string, unknown>
    })

    const { pushPreferences, pullPreferences } = await import('./preferencesSync')
    await pushPreferences(account, true)
    await pullPreferences(account)

    // 工作实例桶只保留自己的项目，笔电路径没有被并进来
    const active = JSON.parse(localStorage.getItem('srv:aiagent:inst_work:opencode-saved-directories') || '[]')
    expect(active.map((e: { path: string }) => e.path)).toEqual(['D:/Code/API-Monitor'])
    // 每个键各推各的内容，互不合并
    expect(sentValues['srv:aiagent:inst_work:opencode-saved-directories']).toEqual([
      { path: 'D:/Code/API-Monitor', name: 'API-Monitor', addedAt: 1 },
    ])
    expect(sentValues['srv:aiagent:inst_laptop:opencode-saved-directories']).toEqual([
      { path: 'E:/Code/OpenCodeUI', name: 'OpenCodeUI', addedAt: 2 },
    ])
    // 笔电桶未被工作实例的内容改写
    const laptop = JSON.parse(localStorage.getItem('srv:aiagent:inst_laptop:opencode-saved-directories') || '[]')
    expect(laptop.map((e: { path: string }) => e.path)).toEqual(['E:/Code/OpenCodeUI'])
  })

  it('records a tombstone when a project is removed locally', async () => {
    const account = await seedAccount()
    const { serverStore } = await import('../store/serverStore')

    serverStore.addServerWithId('aiagent:inst_work', { name: 'work', url: 'https://panel.example.com/gw/inst_work' })
    serverStore.setActiveServer('aiagent:inst_work')

    const key = 'srv:aiagent:inst_work:opencode-saved-directories'
    const entry = { path: 'D:/Code/API-Monitor', name: 'API-Monitor', addedAt: 1 }
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: {},
        known: { __snapshot__: JSON.stringify({ [key]: JSON.stringify([entry]) }) },
      }),
    )
    localStorage.setItem(key, JSON.stringify([]))

    let sentValues: Record<string, unknown> = {}
    stubPreferencesFetch([], (_url, body) => {
      sentValues = body.values as Record<string, unknown>
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account, true)

    const tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}')
    expect(tombstones[key]['D:/Code/API-Monitor']).toBeTypeOf('number')
    expect(sentValues[key]).toEqual([])
  })

  it('toggles the sync switch', async () => {
    const { isSyncEnabled, setSyncEnabled } = await import('./preferencesSync')
    expect(isSyncEnabled()).toBe(false)
    setSyncEnabled(true)
    expect(isSyncEnabled()).toBe(true)
    setSyncEnabled(false)
    expect(isSyncEnabled()).toBe(false)
  })

  it('records the error message when sync fails', async () => {
    await seedAccount()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const { syncPreferences, getSyncMeta } = await import('./preferencesSync')
    await expect(syncPreferences()).rejects.toThrow()
    expect(getSyncMeta().lastError).toBeTruthy()
  })

  it('skips values over the server per-value limit instead of failing the batch', async () => {
    // 服务端单值上限 256 KB，超限返回 413 且整批失败；采集阶段就应剔除超限键。
    const { collectLocalPreferences, withinValueLimit } = await import('./preferencesSync')

    const huge = 'x'.repeat(257 * 1024)
    localStorage.setItem('theme-preset', '0.1')
    localStorage.setItem('theme-custom-css', huge)

    expect(withinValueLimit(huge)).toBe(false)
    expect(withinValueLimit('small')).toBe(true)

    const entries = collectLocalPreferences()
    expect(entries['theme-preset']).toBe('0.1')
    expect(entries['theme-custom-css']).toBeUndefined()
  })

  it('keeps the request body under the server 1MB limit', async () => {
    await seedAccount()
    // 服务端 decodeJSON 用 io.LimitReader(1MB) 读取，超限时会在 JSON 中途截断并
    // 报 "invalid JSON body"（掩盖真实原因）。白名单收窄后仍能构造超限载荷的
    // 只有项目列表（单值上限 256KB），这里用多个实例桶拼出超过 1MB 的载荷，
    // 断言实际发出的请求体仍在 1MB 内。
    const big = 'y'.repeat(240 * 1024)
    for (let i = 0; i < 6; i += 1) {
      localStorage.setItem(
        `srv:aiagent:inst_${i}:opencode-saved-directories`,
        JSON.stringify([{ path: `/${big}`, name: 'x', addedAt: 1 }]),
      )
    }
    localStorage.setItem('theme-preset', '"eucalyptus"')

    let sentBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/aiagent/auth/login')) {
          return new Response(JSON.stringify({ success: true, data: { token: 'tok-sync' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.includes('/api/aiagent/preferences') && init?.method === 'PUT') {
          sentBody = String(init.body)
        }
        return new Response(JSON.stringify({ success: true, data: { written: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    const { login } = await import('./aiagent')
    const account = await login('panel.example.com', 'salen', 'secret-pass-1')
    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account, true)

    expect(sentBody.length).toBeGreaterThan(0)
    const bytes = new TextEncoder().encode(sentBody).length
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)

    // 小键必须在裁剪后留下，不能被整体丢弃。
    expect(JSON.parse(sentBody).values['theme-preset']).toBe('eucalyptus')
  })

  it('does not send an empty payload when no key is syncable', async () => {
    // 服务端拒绝空 values（400 "values required"），客户端应在本地短路。
    let putCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/aiagent/auth/login')) {
          return new Response(JSON.stringify({ success: true, data: { token: 'tok-sync' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (init?.method === 'PUT') putCalls += 1
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    const { login } = await import('./aiagent')
    const account = await login('panel.example.com', 'salen', 'secret-pass-1')
    const { pushPreferences } = await import('./preferencesSync')
    const written = await pushPreferences(account, true)

    expect(written).toBe(0)
    expect(putCalls).toBe(0)
  })
})
