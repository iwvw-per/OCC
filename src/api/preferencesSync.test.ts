import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const TOMBSTONES_KEY = 'opencode-preferences-sync-tombstones'

const GLOBAL_WHITELIST = [
  'chat-content-width',
  'code-word-wrap',
  'collapse-user-messages',
  'descriptive-tool-steps',
  'desktop-collapsed-input-dock',
  'diff-style',
  'external-file-drop-mode',
  'font-scale',
  'glass-effect',
  'i18nextLng',
  'process-collapse-enabled',
  'queue-followup-messages',
  'reasoning-display-mode',
  'render-user-markdown',
  'sidebar-width',
  'step-finish-display',
  'theme-custom-css',
  'theme-mode',
  'theme-preset',
]

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
    localStorage.setItem('font-scale', '0.5')
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
            data: [{ key: 'font-scale', value: '0.1', updatedAt: '2030-01-01T00:00:00.000Z' }],
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
    expect(localStorage.getItem('font-scale')).toBe('0.1')

    // 第二次：带上 ETag，服务端回 304，不产生任何写入。
    const second = await pullPreferences(account)
    expect(sawIfNoneMatch).toBe(ETAG)
    expect(second).toBe(0)
    expect(getCalls).toBe(2)
  })

  it('admits every globally whitelisted key', async () => {
    const { isSyncableKey } = await import('./preferencesSync')
    for (const key of GLOBAL_WHITELIST) {
      expect(isSyncableKey(key), key).toBe(true)
    }
  })

  it('admits the opencode: and opencode- prefixes', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    expect(isSyncableKey('opencode:sound-settings')).toBe(true)
    expect(isSyncableKey('opencode:toast-enabled')).toBe(true)
    expect(isSyncableKey('opencode:update-check')).toBe(true)
    expect(isSyncableKey('opencode:notification-event-settings')).toBe(true)

    expect(isSyncableKey('opencode-keybindings')).toBe(true)
    expect(isSyncableKey('opencode-sidebar-project-sort')).toBe(true)
    expect(isSyncableKey('opencode-bottom-panel-height')).toBe(true)
    expect(isSyncableKey('opencode-right-panel-width')).toBe(true)
    expect(isSyncableKey('opencode-pinned-sessions')).toBe(true)
    expect(isSyncableKey('opencode-pinned-messages')).toBe(true)
    // 已读水位：裸键，跨端同步「未读」依赖它
    expect(isSyncableKey('opencode-read-watermarks')).toBe(true)
    // 项目最后活动时间：裸键，跨端同步项目顺序依赖它
    expect(isSyncableKey('opencode-project-last-used')).toBe(true)
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

  it('admits srv:aiagent: preferences but rejects path and stats keys', async () => {
    const { isSyncableKey } = await import('./preferencesSync')

    expect(isSyncableKey('srv:aiagent:inst_1:model-variant-prefs')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-detected-path-style')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-hidden-directories')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-saved-directories')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-auto-approve-enabled')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-path-mode')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:selected-agent:pane-1')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:selected-model-key')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:session-model-selection')).toBe(true)
    expect(isSyncableKey('srv:aiagent:inst_1:hidden-model-keys')).toBe(true)

    expect(isSyncableKey('srv:aiagent:inst_1:last-directory')).toBe(false)
    expect(isSyncableKey('srv:aiagent:inst_1:model-usage-stats')).toBe(false)
    expect(isSyncableKey('srv:aiagent:inst_1:opencode-recent-projects')).toBe(false)
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
    localStorage.setItem('font-scale', '0.1')
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

    expect(entries['font-scale']).toBe('0.1')
    expect(entries['theme-preset']).toBe('"eucalyptus"')
    expect(entries['i18nextLng']).toBe('zh-CN')
    expect(entries['opencode:sound-settings']).toBeDefined()
    expect(entries['opencode-keybindings']).toBeDefined()
    expect(entries['srv:aiagent:inst_1:selected-agent:pane-1']).toBeDefined()

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
    localStorage.setItem('diff-style', '"markers"')
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
    expect(values.values['diff-style']).toEqual('markers')
    expect(values.values['theme-preset']).toBe('sakura')
    expect(values.values['opencode-aiagent-account']).toBeUndefined()
    expect(Object.keys(updatedAt.updatedAt).sort()).toEqual(['diff-style', 'theme-preset'])

    const firstDiffStamp = updatedAt.updatedAt['diff-style']

    const callsBefore = fetchMock.mock.calls.length
    localStorage.setItem('theme-preset', '"ocean"')
    const second = await pushPreferences()
    expect(second).toBe(2)
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1)

    const secondStamps = (sentBody as unknown as { updatedAt: Record<string, string> }).updatedAt
    expect(secondStamps['diff-style']).toBe(firstDiffStamp)
    expect(secondStamps['theme-preset']).not.toBe(updatedAt.updatedAt['theme-preset'])

    const afterChange = fetchMock.mock.calls.length
    const third = await pushPreferences()
    expect(third).toBe(0)
    expect(fetchMock.mock.calls.length).toBe(afterChange)
  })

  it('uses the current time for every key on the first sync', async () => {
    await seedAccount()
    localStorage.setItem('font-scale', '0.2')

    let sentBody: Record<string, unknown> | null = null
    stubPreferencesFetch([], (_url, body) => {
      sentBody = body
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences()

    const stamps = (sentBody as unknown as { updatedAt: Record<string, string> }).updatedAt
    expect(stamps['font-scale']).toBeTruthy()
    expect(Number.isNaN(Date.parse(stamps['font-scale']))).toBe(false)
  })

  it('does not overwrite a newer local value with an older server value', async () => {
    const account = await seedAccount()
    localStorage.setItem('font-scale', '0.5')
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({ stamps: { 'font-scale': '2030-01-01T00:00:00.000Z' }, known: {} }),
    )

    stubPreferencesFetch([
      { key: 'font-scale', value: '0.1', updatedAt: '2020-01-01T00:00:00.000Z' },
      { key: 'theme-preset', value: 'ocean', updatedAt: '2030-01-01T00:00:00.000Z' },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    const written = await pullPreferences(account)
    expect(written).toBe(1)
    expect(localStorage.getItem('font-scale')).toBe('0.5')
    expect(localStorage.getItem('theme-preset')).toBe('ocean')
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
      { key: 'font-scale', value: '0.1', updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'theme-preset', value: 'ocean', updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'opencode-aiagent-account', value: { token: 'must-be-ignored' }, updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'opencode-servers', value: [{ url: 'http://evil' }], updatedAt: '2030-01-01T00:00:00Z' },
      { key: 'srv:local:opencode-hidden-directories', value: ['/other'], updatedAt: '2030-01-01T00:00:00Z' },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    const written = await pullPreferences(account)
    expect(written).toBe(2)

    expect(localStorage.getItem('font-scale')).toBe('0.1')
    expect(localStorage.getItem('theme-preset')).toBe('ocean')
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

  it('merges per-server pinned sessions and saved directories as a union', async () => {
    const account = await seedAccount()
    localStorage.setItem(
      'srv:aiagent:inst_1:opencode-pinned-sessions',
      JSON.stringify([{ sessionId: 'local-1', directory: '/local', title: 'Local' }]),
    )
    localStorage.setItem(
      'srv:aiagent:inst_1:opencode-saved-directories',
      JSON.stringify([{ path: '/a', name: 'A', addedAt: 1 }]),
    )

    stubPreferencesFetch([
      {
        key: 'srv:aiagent:inst_1:opencode-pinned-sessions',
        value: [
          { sessionId: 'server-1', directory: '/server', title: 'Server' },
          { sessionId: 'local-1', directory: '/server', title: 'Server copy' },
        ],
        updatedAt: '2030-01-01T00:00:00Z',
      },
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

    const pinned = JSON.parse(localStorage.getItem('srv:aiagent:inst_1:opencode-pinned-sessions') || '[]')
    expect(pinned.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['local-1', 'server-1'])

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

  it('keeps legacy hidden-directories on whole-key last-write-wins', async () => {
    // 该键已废弃（项目列表不再自动发现，用户看到的项目由 saved-directories 决定），
    // 但历史数据仍在准入前缀下，同步语义保持整键 LWW 不变，避免旧数据行为突变。
    const account = await seedAccount()
    localStorage.setItem('srv:aiagent:inst_1:opencode-hidden-directories', JSON.stringify(['/local-only']))
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { 'srv:aiagent:inst_1:opencode-hidden-directories': '2020-01-01T00:00:00.000Z' },
        known: {},
      }),
    )

    stubPreferencesFetch([
      {
        key: 'srv:aiagent:inst_1:opencode-hidden-directories',
        value: ['/server-only'],
        updatedAt: '2030-01-01T00:00:00Z',
      },
    ])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem('srv:aiagent:inst_1:opencode-hidden-directories') || '[]')).toEqual([
      '/server-only',
    ])
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
    localStorage.setItem('font-scale', '0.1')
    localStorage.setItem('theme-custom-css', huge)

    expect(withinValueLimit(huge)).toBe(false)
    expect(withinValueLimit('small')).toBe(true)

    const entries = collectLocalPreferences()
    expect(entries['font-scale']).toBe('0.1')
    expect(entries['theme-custom-css']).toBeUndefined()
  })

  it('keeps the request body under the server 1MB limit', async () => {
    await seedAccount()
    // 服务端 decodeJSON 用 io.LimitReader(1MB) 读取，超限时会在 JSON 中途截断并
    // 报 "invalid JSON body"（掩盖真实原因）。这里构造一个整体超限的载荷，
    // 断言实际发出的请求体仍在 1MB 内。
    const big = 'y'.repeat(240 * 1024)
    localStorage.setItem('font-scale', '0.1')
    localStorage.setItem('theme-custom-css', big)
    localStorage.setItem('opencode-keybindings', JSON.stringify({ k: big }))
    localStorage.setItem('sidebar-width', big)
    localStorage.setItem('i18nextLng', 'zh-CN')

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
    expect(JSON.parse(sentBody).values['i18nextLng']).toBe('zh-CN')
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
