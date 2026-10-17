import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Switch } from '../../../components/ui'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import {
  TrashIcon,
  WifiIcon,
  WifiOffIcon,
  SpinnerIcon,
  KeyIcon,
  PencilIcon,
  RetryIcon,
} from '../../../components/Icons'
import { useServerStore, useRouter } from '../../../hooks'
import { messageStore } from '../../../store'
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import { cn } from '../../../utils/cn'
import { interactive } from '../../../utils/interaction'
import type { ServerConfig, ServerHealth } from '../../../store/serverStore'
import { AiAgentAccountSettings, PreferencesSyncSettings } from './AiAgentAccountSettings'

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
/** 显示名长度上限，避免列表项把右侧操作按钮挤穿 */
const SERVER_NAME_MAX_LENGTH = 40

function isHttpsIpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    return parsed.protocol === 'https:' && (IPV4_PATTERN.test(hostname) || hostname.includes(':'))
  } catch {
    return false
  }
}

// ============================================
// Server Item
// ============================================

function ServerItem({
  server,
  health,
  isActive,
  onSelect,
  onDelete,
  onEdit,
  onCheckHealth,
  onToggleEnabled,
}: {
  server: ServerConfig
  health: ServerHealth | null
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onEdit: (updates: { name: string; url: string; username?: string; password?: string }) => void
  onCheckHealth: () => void
  onToggleEnabled: (enabled: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const statusIcon = () => {
    if (!health || health.status === 'checking') return <SpinnerIcon size={12} className="animate-spin text-text-400" />
    if (health.status === 'online') return <WifiIcon size={12} className="text-success-100" />
    if (health.status === 'unauthorized') return <KeyIcon size={12} className="text-warning-100" />
    return <WifiOffIcon size={12} className="text-danger-100" />
  }

  const statusTitle = () => {
    if (!health) return t('servers.checkHealth')
    switch (health.status) {
      case 'checking':
        return t('servers.checking')
      case 'online':
        return `${t('servers.onlineLatency', { latency: health.latency })}${health.version ? ` · OpenCode v${health.version}` : ''}`
      case 'unauthorized':
        return t('servers.invalidCredentials')
      case 'offline':
        return health.error || t('common:offline')
      case 'error':
        return health.error || t('common:error')
      default:
        return t('common:unknown')
    }
  }

  if (editing) {
    return (
      <EditServerForm
        server={server}
        onSave={updates => {
          onEdit(updates)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <div
        onClick={onSelect}
        className={`group flex items-center gap-1.5 p-2.5 rounded-lg border transition-colors min-w-0
          ${
            isActive
              ? 'border-accent-main-100/50 bg-accent-main-100/10'
              : 'border-border-200/50 bg-bg-200/40 hover:border-border-200 hover:bg-bg-200/60'
          }`}
      >
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onSelect()
          }}
          aria-current={isActive ? 'true' : undefined}
          className="min-w-0 flex-1 overflow-hidden bg-transparent border-none p-0 text-left"
        >
          <div className="min-w-0">
            <div
              className="text-[length:var(--fs-md)] font-medium text-text-100 truncate"
              title={server.name}
            >
              {server.name}
            </div>
            <div className="text-[length:var(--fs-xs)] text-text-400 truncate font-mono flex items-center gap-1 mt-0.5 min-w-0">
              <span className="truncate min-w-0" title={server.url}>
                {server.url}
              </span>
              {server.auth?.password && <KeyIcon size={10} className="shrink-0 text-text-400" />}
            </div>
          </div>
        </button>
        <div className="shrink-0 flex items-center gap-1.5">
          <IconButton
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onCheckHealth()
            }}
            title={statusTitle()}
            aria-label={statusTitle()}
          >
            {statusIcon()}
          </IconButton>
          {/* Local（默认服务器）也允许编辑：它是本机 opencode serve 的连接信息，
              桌面端会从 URL 里解析端口固定监听，用户可据此自定义端口。
              但默认服务器不可删除，故删除按钮仍对 Local 隐藏。 */}
          <IconButton
            size="sm"
            className={cn('hover:text-accent-main-100', interactive.accent)}
            onClick={e => {
              e.stopPropagation()
              setEditing(true)
            }}
            title={t('servers.editServer')}
            aria-label={t('servers.editServer')}
          >
            <PencilIcon size={13} />
          </IconButton>
          {!server.isDefault && (
            <IconButton
              size="sm"
              variant="danger"
              onClick={e => {
                e.stopPropagation()
                setConfirmDelete(true)
              }}
              title={t('common:remove')}
              aria-label={t('common:remove')}
            >
              <TrashIcon size={13} />
            </IconButton>
          )}
          {/* 启用/停用放最后：它是"这台主机要不要用"的总开关，
              与其他行内操作（检测/编辑/删除）性质不同，独立在末尾更清楚。
              停用后不建连接、不参与事件订阅、不出现会话分组，但保留配置。
              Local 也可停用；若停用的正是当前活动服务器，store 会自动切到
              另一台已启用的（没有可切目标时拒绝停用）。 */}
          <Switch
            checked={server.enabled !== false}
            onCheckedChange={next => onToggleEnabled(next)}
            onClick={e => e.stopPropagation()}
            aria-label={t('servers.enableServer', { name: server.name })}
          />
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete()
        }}
        title={t('servers.deleteServer')}
        description={t('servers.deleteServerConfirm', { name: server.name })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
        variant="danger"
      />
    </>
  )
}

// ============================================
// Edit Server Form (inline)
// ============================================

function EditServerForm({
  server,
  onSave,
  onCancel,
}: {
  server: ServerConfig
  onSave: (updates: { name: string; url: string; username?: string; password?: string }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url)
  const [username, setUsername] = useState(server.auth?.username || '')
  const [password, setPassword] = useState(server.auth?.password || '')
  const [showAuth, setShowAuth] = useState(!!server.auth?.password)
  const [error, setError] = useState('')
  const showHttpsIpWarning = isHttpsIpUrl(url)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH)
    if (!trimmedName) {
      setError(t('servers.nameRequired'))
      return
    }
    if (!url.trim()) {
      setError(t('servers.urlRequired'))
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('servers.invalidUrl'))
      return
    }
    onSave({
      name: trimmedName,
      url: url.trim(),
      username: password.trim() ? username.trim() || 'opencode' : undefined,
      password: password.trim() || undefined,
    })
  }

  const inputCls = settingsFieldClass

  return (
    <form
      onSubmit={handleSubmit}
      className="p-3 rounded-lg border border-accent-main-100/30 bg-accent-main-100/[0.02] space-y-2.5"
    >
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.name')}</label>
        <input
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.namePlaceholder')}
          className={inputCls}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.url')}</label>
        <input
          type="text"
          value={url}
          onChange={e => {
            setUrl(e.target.value)
            setError('')
          }}
          placeholder={t('servers.urlPlaceholder')}
          className={`${inputCls} font-mono`}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAuth(!showAuth)}
        className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-accent-main-100 transition-colors hover:bg-bg-200"
      >
        <KeyIcon size={10} />
        {showAuth ? t('servers.hideAuth') : t('servers.addAuth')}
      </button>

      {showAuth && (
        <>
          <div>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.username')}</label>
            <input
              type="text"
              value={username}
              onChange={e => {
                setUsername(e.target.value)
                setError('')
              }}
              placeholder={t('servers.usernamePlaceholder')}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.password')}</label>
            <input
              type="password"
              value={password}
              onChange={e => {
                setPassword(e.target.value)
                setError('')
              }}
              placeholder={t('servers.passwordPlaceholder')}
              className={inputCls}
            />
          </div>
        </>
      )}

      {showHttpsIpWarning && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button type="submit" size="sm">
          {t('common:save')}
        </Button>
      </div>
    </form>
  )
}

// ============================================
// Add Server Form
// ============================================

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, url: string, username?: string, password?: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showAuth, setShowAuth] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH)
    if (!trimmedName) {
      setError(t('servers.nameRequired'))
      return
    }
    if (!url.trim()) {
      setError(t('servers.urlRequired'))
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('servers.invalidUrl'))
      return
    }

    onAdd(
      trimmedName,
      url.trim(),
      password.trim() ? username.trim() || 'opencode' : undefined,
      password.trim() || undefined,
    )
  }

  const isCrossOrigin = (() => {
    if (!url.trim()) return false
    try {
      const serverUrl = new URL(url)
      return serverUrl.origin !== window.location.origin
    } catch {
      return false
    }
  })()
  const showHttpsIpWarning = isHttpsIpUrl(url)

  const inputCls = settingsFieldClass

  return (
    <form onSubmit={handleSubmit} className="p-3 rounded-lg border border-border-200 bg-bg-100 space-y-2.5">
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.name')}</label>
        <input
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.namePlaceholder')}
          className={inputCls}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.url')}</label>
        <input
          type="text"
          value={url}
          onChange={e => {
            setUrl(e.target.value)
            setError('')
          }}
          placeholder={t('servers.urlPlaceholder')}
          className={`${inputCls} font-mono`}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAuth(!showAuth)}
        className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-accent-main-100 transition-colors hover:bg-bg-200"
      >
        <KeyIcon size={10} />
        {showAuth ? t('servers.hideAuth') : t('servers.addAuth')}
      </button>

      {showAuth && (
        <>
          <div>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.username')}</label>
            <input
              type="text"
              value={username}
              onChange={e => {
                setUsername(e.target.value)
                setError('')
              }}
              placeholder={t('servers.usernamePlaceholder')}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.password')}</label>
            <input
              type="password"
              value={password}
              onChange={e => {
                setPassword(e.target.value)
                setError('')
              }}
              placeholder={t('servers.passwordPlaceholder')}
              className={inputCls}
            />
          </div>

          {isCrossOrigin && password.trim() && (
            <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
              {t('servers.crossOriginWarning')}{' '}
              <a
                href="https://github.com/anomalyco/opencode/issues/10047"
                target="_blank"
                rel="noopener"
                className="underline hover:no-underline"
              >
                #10047
              </a>
            </div>
          )}

          <div data-setting-desc className="text-[length:var(--fs-xs)] text-text-400 leading-relaxed">{t('servers.credentialsStorage')}</div>
        </>
      )}

      {showHttpsIpWarning && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button type="submit" size="sm">
          {t('common:add')}
        </Button>
      </div>
    </form>
  )
}

// ============================================
// Tab: Servers
// ============================================

export function ServersSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const [addingServer, setAddingServer] = useState(false)
  const {
    servers,
    activeServer,
    addServer,
    removeServer,
    updateServer,
    setActiveServer,
    checkHealth,
    checkAllHealth,
    getHealth,
    setServerEnabled,
  } = useServerStore()
  const { restoreWorkspace, sessionId: routeSessionId, directory } = useRouter()
  /**
   * 连接清单的显示顺序：Local 固定第一，其余保持配置顺序。
   *
   * 此前把「当前活动服务器」提到最前，导致每次切换主机整列表重排
   * ——用户正在点的行会跳走，也会误以为列表顺序"一直在变"。
   * 用固定的 Local 优先顺序，活动状态由行内高亮表达即可。
   */
  const orderedServers = useMemo(() => {
    const isLocal = (s: ServerConfig) => s.isDefault === true || s.id === 'local'
    const locals = servers.filter(isLocal)
    const rest = servers.filter(s => !isLocal(s))
    return [...locals, ...rest]
  }, [servers])

  useEffect(() => {
    checkAllHealth()
  }, [checkAllHealth])

  // 切换服务器：设置 active + 清理当前 session + 把路由落到新服务器首页。
  // 用 restoreWorkspace（replaceState）而不是 navigateHome（hash 导航）——
  // hash 变更会被 Dialog 的 useBackClose 当作「返回」触发 popstate，把设置面板
  // 弹掉；replaceState 不产生新历史项、不触发 popstate，切换主机时设置保持打开。
  const handleSelectServer = useCallback(
    (id: string) => {
      if (activeServer?.id === id) return // 没变，不做事

      // 清理当前 session 的 store 状态
      if (routeSessionId) {
        messageStore.clearSession(routeSessionId)
      }

      setActiveServer(id) // 内部触发 serverChangeListeners → reconnectSSE()
      restoreWorkspace(id, null, directory)
      void checkHealth(id)
    },
    [activeServer?.id, checkHealth, routeSessionId, setActiveServer, restoreWorkspace, directory],
  )

  return (
    <>
      {/* AI Agent 账号：登录第三方面板并同步实例，属于「接入来源」而非日常服务器配置。
          标题与描述由本区块提供，AiAgentAccountSettings 只渲染内容，不再自带标题。 */}
      <SettingsSection plain title={t('servers.aiAgentAccount')} description={t('servers.aiAgentAccountDesc')}>
        <AiAgentAccountSettings />
      </SettingsSection>

      <SettingsSection
        plain
        title={t('servers.connections')}
        description={t('servers.connectionsDesc')}
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void checkAllHealth()}
              title={t('common:refresh')}
              aria-label={t('common:refresh')}
            >
              <RetryIcon size={12} />
              {t('common:refresh')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAddingServer(true)}
              disabled={addingServer}
            >
              {t('common:add')}
            </Button>
          </div>
        }
      >
        <div className="space-y-1.5">
          {orderedServers.map(s => (
            <ServerItem
              key={s.id}
              server={s}
              health={getHealth(s.id)}
              isActive={activeServer?.id === s.id}
              onSelect={() => handleSelectServer(s.id)}
              onDelete={() => removeServer(s.id)}
              onEdit={updates => {
                const auth = updates.password
                  ? { username: updates.username || 'opencode', password: updates.password }
                  : undefined
                updateServer(s.id, { name: updates.name, url: updates.url, auth })
                void checkHealth(s.id)
              }}
              onCheckHealth={() => void checkHealth(s.id)}
              onToggleEnabled={next => setServerEnabled(s.id, next)}
            />
          ))}

        {addingServer && (
          <AddServerForm
            onAdd={(n, u, user, pass) => {
              const auth = pass ? { username: user || 'opencode', password: pass } : undefined
              const s = addServer({ name: n, url: u, auth })
              setAddingServer(false)
              void checkHealth(s.id)
            }}
            onCancel={() => setAddingServer(false)}
          />
        )}

        {servers.length === 0 && !addingServer && (
          <div className="text-[length:var(--fs-md)] text-text-400 text-center py-8">{t('servers.noServersConfigured')}</div>
        )}
      </div>
      </SettingsSection>

      {/* 设置同步与服务器无关，独立成区块放在末尾 */}
      <PreferencesSyncSettings />
    </>
  )
}
