import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { SettingsSection, SettingRow, settingsFieldClass } from './SettingsUI'
import { Switch, NativeTooltip } from '../../../components/ui'
import {
  login as accountLogin,
  logout as accountLogout,
  readAccount,
  syncInstances,
  type AiAgentAccount,
  type AiAgentInstance,
} from '../../../api/aiagent'
import {
  getSyncState,
  startPreferencesSync,
  stopPreferencesSync,
  subscribeSyncState,
  syncNow,
  type SyncState,
} from '../../../api/preferencesSyncEngine'
import { isSyncEnabled, setSyncEnabled } from '../../../api/preferencesSync'
import { useServerStore } from '../../../hooks'

function formatSyncedAt(timestamp: number): string {
  if (!timestamp) return '尚未同步'
  return new Date(timestamp).toLocaleTimeString()
}

function describeSyncState(state: SyncState): string {
  switch (state.status) {
    case 'syncing':
      return '同步中…'
    case 'synced':
      return `已同步 · ${formatSyncedAt(state.lastSyncedAt)}`
    case 'error':
      return `同步失败：${state.error || '未知错误'}`
    case 'disabled':
      return '未启用'
    default:
      return '待同步'
  }
}

/**
 * 设置同步：把本地设置同步到 API Monitor 面板，在多台设备间保持一致。
 *
 * 独立成一个组件 + 区块，不复用 AI Agent 账号的卡片：
 * 它依赖同一份登录态，但语义上属于「本地偏好同步」，与「服务器连接」无关。
 * 放在服务器页时容易被误读成服务器的一个属性。
 */
export function PreferencesSyncSettings() {
  const [syncEnabled, setSyncEnabledState] = useState(() => isSyncEnabled())
  const [syncState, setSyncState] = useState<SyncState>(() => getSyncState())
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeSyncState(setSyncState), [])

  const handleToggleSync = useCallback(async (next: boolean) => {
    setBusy(true)
    setSyncEnabled(next)
    try {
      if (next) {
        // startPreferencesSync 内部会读账号并自行判断是否可同步
        await startPreferencesSync()
      } else {
        stopPreferencesSync()
      }
      setSyncEnabledState(next)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <SettingsSection title="设置同步" description="把主题、布局、快捷键等本地设置同步到面板，在多台设备间保持一致。">
      <SettingRow label="启用同步" description={describeSyncState(syncState)}>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!syncEnabled || busy || syncState.status === 'syncing'}
            onClick={() => void syncNow()}
          >
            立即同步
          </Button>
          <Switch
            checked={syncEnabled}
            onCheckedChange={next => void handleToggleSync(next)}
            disabled={busy}
            aria-label="启用设置同步"
          />
        </div>
      </SettingRow>
    </SettingsSection>
  )
}

/** AI Agent 账号：连接 API Monitor 的 aiagent 模块，同步实例为可切换服务器。 */
export function AiAgentAccountSettings() {
  const [account, setAccount] = useState<AiAgentAccount | null>(() => readAccount())
  const [domain, setDomain] = useState(account?.domain ?? '')
  const [username, setUsername] = useState(account?.username ?? '')
  const [password, setPassword] = useState('')
  const [instances, setInstances] = useState<AiAgentInstance[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { getHealth, checkHealth } = useServerStore()

  const refreshInstances = useCallback(
    async (target?: AiAgentAccount | null) => {
      try {
        const list = await syncInstances(target)
        setInstances(list)
        // 实例状态以「能否经网关访问到服务」为准：列表接口默认不做实时探测
        // （返回的 online 恒为 false），这里逐个跑一次真实健康检查。
        await Promise.all(list.map(instance => checkHealth(`aiagent:${instance.id}`)))
      } catch (err) {
        setError(err instanceof Error ? err.message : '同步实例失败')
      }
    },
    [checkHealth],
  )

  useEffect(() => {
    if (account) {
      void refreshInstances(account)
    }
  }, [account, refreshInstances])

  const handleLogin = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const next = await accountLogin(domain, username, password, '客户端')
      setPassword('')
      setAccount(next)
      if (isSyncEnabled()) {
        await startPreferencesSync()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }, [domain, username, password])

  const handleLogout = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      stopPreferencesSync()
      await accountLogout()
      setAccount(null)
      setInstances([])
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '退出失败')
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    // 不再自带 SettingsSection：外层 ServersSettings 已提供区块标题与描述，
    // 内层再包一层会出现两个「AI Agent 账号」标题。
    <>
      {!account ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-ui-sm text-text-300">
            面板域名
            <input
              className={settingsFieldClass}
              value={domain}
              placeholder="panel.example.com"
              autoComplete="off"
              onChange={event => setDomain(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-sm text-text-300">
            用户名
            <input
              className={settingsFieldClass}
              value={username}
              autoComplete="username"
              onChange={event => setUsername(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-sm text-text-300">
            密码
            <input
              className={settingsFieldClass}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <Button onClick={handleLogin} disabled={busy}>
              {busy ? '登录中…' : '登录'}
            </Button>
            {error && <span className="text-ui-sm text-danger-100">{error}</span>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm text-text-300">
            <span>
              已登录 <span className="text-text-100">{account.username}</span> @ {account.domain}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => refreshInstances(account)} disabled={busy}>
                刷新实例
              </Button>
              <Button variant="secondary" size="sm" onClick={handleLogout} disabled={busy}>
                退出登录
              </Button>
            </div>
          </div>

          {instances.length === 0 ? (
            <p className="text-ui-sm text-text-500">该账号下还没有登记实例。请先在面板的 AI Agent 模块添加。</p>
          ) : (
            /* 只展示实例状态，不提供「切换」按钮：
               切服务器统一在下方「连接」清单里做。此前这里另有一个切换入口，
               与连接清单操作同一份 serverStore，属重复呈现。 */
            <ul className="flex flex-col gap-1">
              {instances.map(instance => {
                const serverId = `aiagent:${instance.id}`
                const health = getHealth(serverId)
                const online = health?.status === 'online'
                const offlineLabel = health?.error || instance.status?.error || ''
                return (
                  <li
                    key={instance.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border-100 bg-bg-100 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-ui-caption text-text-100">{instance.label}</span>
                        <NativeTooltip>
                          <span
                            className={`text-ui-xs ${online ? 'text-success-100' : 'text-text-500'}`}
                            title={offlineLabel}
                          >
                            {online ? '运行中' : '离线'}
                          </span>
                        </NativeTooltip>
                      </div>
                      <div className="truncate text-ui-xs text-text-500">
                        {instance.providerLabel || instance.provider} · {instance.hostName || instance.serverId} ·{' '}
                        {instance.port}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {error && <span className="text-ui-sm text-danger-100">{error}</span>}
        </div>
      )}
    </>
  )
}
