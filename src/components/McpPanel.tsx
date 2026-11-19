// ============================================
// McpPanel - MCP 服务器管理面板
// 显示所有 MCP 服务器状态，支持连接/断开/认证
// 支持添加新服务器
// ============================================

import { memo, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PlugIcon,
  RetryIcon,
  KeyIcon,
  ExternalLinkIcon,
  AlertCircleIcon,
  CheckIcon,
  SpinnerIcon,
  PlusIcon,
  CloseIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  FileIcon,
} from './Icons'
import {
  getMcpStatus,
  getMcpResources,
  connectMcpServer,
  disconnectMcpServer,
  startMcpAuth,
  authenticateMcp,
  addMcpServer,
} from '../api/mcp'
import type { MCPResource, MCPStatus, McpServerConfig } from '../types/api/mcp'
import { Button, Chip, IconButton, Input, Tabs, TabsList, TabsTrigger, type ChipTone } from './ui'
import { cn } from '../utils/cn'
import { interactive } from '../utils/interaction'
import { useDirectory } from '../hooks'
import { logger } from '../utils/logger'
import { apiErrorHandler } from '../utils'

// ============================================
// Types
// ============================================

interface ServerEntry {
  name: string
  status: MCPStatus
  resources: MCPResource[]
}

// ============================================
// McpPanel Component
// ============================================

interface McpPanelProps {
  isResizing?: boolean
  /** 作为弹窗内容使用时传入，在面板头部右侧显示关闭按钮（rawContent 弹窗没有自带标题栏） */
  onClose?: () => void
}

export const McpPanel = memo(function McpPanel({ isResizing: _isResizing, onClose }: McpPanelProps) {
  const { t } = useTranslation(['components', 'common'])
  const { currentDirectory } = useDirectory()
  const [servers, setServers] = useState<ServerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [resourceError, setResourceError] = useState<string | null>(null)

  // 加载 MCP 状态
  const loadStatus = useCallback(async () => {
    try {
      setError(null)
      const statusResponse = await getMcpStatus(currentDirectory)
      logger.log('[McpPanel] Status:', statusResponse)

      let resourcesByClient = new Map<string, MCPResource[]>()
      try {
        const resourceResponse = await getMcpResources(currentDirectory)
        resourcesByClient = groupResourcesByClient(Object.values(resourceResponse))
        setResourceError(null)
      } catch (err) {
        apiErrorHandler('load MCP resources', err)
        setResourceError(t('mcpPanel.failedToLoadResources'))
      }

      // 构建 server entries
      const entries: ServerEntry[] = Object.entries(statusResponse).map(([name, status]) => ({
        name,
        status: status as MCPStatus,
        resources: resourcesByClient.get(name) ?? [],
      }))

      // 按名称排序
      entries.sort((a, b) => a.name.localeCompare(b.name))
      setServers(entries)
    } catch (err) {
      apiErrorHandler('load MCP status', err)
      setError(t('mcpPanel.failedToLoad'))
    } finally {
      setLoading(false)
    }
  }, [currentDirectory, t])

  // 初始加载
  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // 刷新
  const handleRefresh = useCallback(() => {
    setLoading(true)
    loadStatus()
  }, [loadStatus])

  // 连接服务器
  const handleConnect = useCallback(
    async (name: string) => {
      setActionLoading(name)
      try {
        await connectMcpServer(name, currentDirectory)
        // 等一下让后端处理完
        await new Promise(r => setTimeout(r, 500))
        await loadStatus()
      } catch (err) {
        apiErrorHandler('connect MCP server', err)
      } finally {
        setActionLoading(null)
      }
    },
    [currentDirectory, loadStatus],
  )

  // 断开服务器
  const handleDisconnect = useCallback(
    async (name: string) => {
      setActionLoading(name)
      try {
        await disconnectMcpServer(name, currentDirectory)
        await new Promise(r => setTimeout(r, 500))
        await loadStatus()
      } catch (err) {
        apiErrorHandler('disconnect MCP server', err)
      } finally {
        setActionLoading(null)
      }
    },
    [currentDirectory, loadStatus],
  )

  // 开始认证流程
  const handleAuth = useCallback(
    async (name: string) => {
      setActionLoading(name)
      try {
        // 尝试使用 authenticate 接口（自动打开浏览器）
        await authenticateMcp(name, currentDirectory)
        // 等待用户完成认证
        await new Promise(r => setTimeout(r, 3000))
        await loadStatus()
      } catch {
        // 如果失败，尝试 startMcpAuth 获取 URL
        try {
          const result = await startMcpAuth(name, currentDirectory)
          if ((await import('../utils/tauri')).isTauri()) {
            import('@tauri-apps/plugin-opener')
              .then(mod => mod.openUrl(result.url))
              .catch(() => window.open(result.url, '_blank', 'noopener,noreferrer'))
          } else {
            window.open(result.url, '_blank', 'noopener,noreferrer')
          }
          await new Promise(r => setTimeout(r, 3000))
          await loadStatus()
        } catch (err2) {
          apiErrorHandler('start MCP auth', err2)
        }
      } finally {
        setActionLoading(null)
      }
    },
    [currentDirectory, loadStatus],
  )

  // 添加新服务器
  const handleAddServer = useCallback(
    async (name: string, config: McpServerConfig) => {
      setActionLoading('__adding__')
      try {
        await addMcpServer(name, config, currentDirectory)
        setShowAddForm(false)
        await new Promise(r => setTimeout(r, 500))
        await loadStatus()
      } catch (err) {
        apiErrorHandler('add MCP server', err)
        throw err
      } finally {
        setActionLoading(null)
      }
    },
    [currentDirectory, loadStatus],
  )

  // ============================================
  // Render
  // ============================================

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-100">
      {/* Header */}
      <div className="relative flex h-10 items-center justify-between px-3">
        <div className="flex h-6 min-w-0 items-center gap-1.5 text-text-100 text-ui-sm font-medium">
          <span>{t('mcpPanel.title')}</span>
          {!loading && <span className="inline-flex h-4 items-center text-ui-sm leading-none text-text-400">({servers.length})</span>}
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            size="sm"
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
            aria-label={t('mcpPanel.addServer')}
            title={t('mcpPanel.addServer')}
          >
            <PlusIcon size={12} />
          </IconButton>
          <IconButton
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            aria-label={t('common:refresh')}
            title={t('common:refresh')}
          >
            <RetryIcon size={12} className={loading ? 'animate-spin' : ''} />
          </IconButton>
          {onClose && (
            <IconButton size="sm" onClick={onClose} aria-label={t('common:close')} title={t('common:close')}>
              <CloseIcon size={12} />
            </IconButton>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* Add Server Form */}
        {showAddForm && (
          <AddServerForm
            onSubmit={handleAddServer}
            onCancel={() => setShowAddForm(false)}
            isLoading={actionLoading === '__adding__'}
          />
        )}

        {loading && servers.length === 0 ? (
          <div className="flex flex-col gap-1 p-1" role="status" aria-label={t('mcpPanel.loadingServers')}>
            {[0, 1, 2].map(index => (
              <div key={index} className="flex items-center gap-2.5 rounded-md px-2 py-2.5">
                <span className="size-2 shrink-0 rounded-full bg-bg-300/60" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-1/3 rounded bg-bg-300/50 animate-pulse" />
                  <div className="h-2.5 w-1/4 rounded bg-bg-300/40 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-ui-base gap-2">
            <AlertCircleIcon size={20} className="text-danger-100" />
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={handleRefresh}>
              {t('common:retry')}
            </Button>
          </div>
        ) : servers.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-ui-base gap-2 px-4 text-center">
            <PlugIcon size={24} className="opacity-30" />
            <span>{t('mcpPanel.noServers')}</span>
            <Button variant="secondary" size="sm" onClick={() => setShowAddForm(true)}>
              {t('mcpPanel.addServer')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 p-1">
            {resourceError && (
              <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-warning-bg/50 px-2 py-1.5 text-ui-caption text-warning-100">
                <AlertCircleIcon size={13} />
                <span>{resourceError}</span>
              </div>
            )}
            {servers.map(server => (
              <ServerItem
                key={server.name}
                server={server}
                isLoading={actionLoading === server.name}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onAuth={handleAuth}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

function groupResourcesByClient(resources: MCPResource[]): Map<string, MCPResource[]> {
  const groups = new Map<string, MCPResource[]>()

  for (const resource of resources) {
    const items = groups.get(resource.client) ?? []
    items.push(resource)
    groups.set(resource.client, items)
  }

  for (const items of groups.values()) {
    items.sort((a, b) => a.name.localeCompare(b.name))
  }

  return groups
}

// ============================================
// AddServerForm Component
// ============================================

interface AddServerFormProps {
  onSubmit: (name: string, config: McpServerConfig) => Promise<void>
  onCancel: () => void
  isLoading: boolean
}

const AddServerForm = memo(function AddServerForm({ onSubmit, onCancel, isLoading }: AddServerFormProps) {
  const { t } = useTranslation(['components', 'common'])
  const [serverType, setServerType] = useState<'local' | 'remote'>('local')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError(t('mcpPanel.nameRequired'))
      return
    }

    try {
      if (serverType === 'local') {
        if (!command.trim()) {
          setError(t('mcpPanel.commandRequired'))
          return
        }
        // 解析命令为数组
        const cmdParts = command.trim().split(/\s+/)
        await onSubmit(name.trim(), {
          type: 'local',
          command: cmdParts,
        })
      } else {
        if (!url.trim()) {
          setError(t('mcpPanel.urlRequired'))
          return
        }
        await onSubmit(name.trim(), {
          type: 'remote',
          url: url.trim(),
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mcpPanel.failedToAdd'))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="m-3 rounded-lg border border-border-200/60 bg-bg-100/50 p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-ui-base font-medium text-text-100">{t('mcpPanel.addMcpServer')}</span>
        <IconButton size="sm" onClick={onCancel} aria-label={t('common:close')} title={t('common:close')}>
          <CloseIcon size={14} />
        </IconButton>
      </div>

      {/* Server Type Toggle */}
      <Tabs
        variant="slider"
        value={serverType}
        onValueChange={value => setServerType(value as 'local' | 'remote')}
        size="md"
        className="mb-3"
      >
        <TabsList activeIndex={serverType === 'local' ? 0 : 1} itemCount={2} className="w-full">
          <TabsTrigger value="local" className="justify-center normal-case tracking-normal">
            {t('mcpPanel.local')}
          </TabsTrigger>
          <TabsTrigger value="remote" className="justify-center normal-case tracking-normal">
            {t('mcpPanel.remote')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Name Input */}
      <div className="mb-2 flex flex-col gap-1">
        <label className="text-ui-sm text-text-400">{t('mcpPanel.serverName')}</label>
        <Input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('mcpPanel.serverNamePlaceholder')}
        />
      </div>

      {/* Local: Command Input */}
      {serverType === 'local' && (
        <div className="mb-2 flex flex-col gap-1">
          <label className="text-ui-sm text-text-400">{t('mcpPanel.command')}</label>
          <Input
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder={t('mcpPanel.commandPlaceholder')}
          />
        </div>
      )}

      {/* Remote: URL Input */}
      {serverType === 'remote' && (
        <div className="mb-2 flex flex-col gap-1">
          <label className="text-ui-sm text-text-400">{t('mcpPanel.url')}</label>
          <Input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={t('mcpPanel.urlPlaceholder')}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md bg-danger-bg px-2 py-1.5 text-ui-caption text-danger-100">
          <AlertCircleIcon size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {/* Submit */}
      <Button type="submit" className="w-full" isLoading={isLoading}>
        {isLoading ? (
          <>{t('common:adding')}</>
        ) : (
          <>
            <PlusIcon size={12} />
            {t('mcpPanel.addServer')}
          </>
        )}
      </Button>
    </form>
  )
})

// ============================================
// ServerItem Component
// ============================================

interface ServerItemProps {
  server: ServerEntry
  isLoading: boolean
  onConnect: (name: string) => void
  onDisconnect: (name: string) => void
  onAuth: (name: string) => void
}

const ServerItem = memo(function ServerItem({ server, isLoading, onConnect, onDisconnect, onAuth }: ServerItemProps) {
  const { t } = useTranslation(['components', 'common'])
  const { name, status } = server
  const [expanded, setExpanded] = useState(false)

  // 获取错误信息（如果有）
  const getErrorMessage = (): string | null => {
    if (status.status === 'failed') {
      return status.error
    }
    if (status.status === 'needs_client_registration') {
      return status.error
    }
    return null
  }

  const errorMessage = getErrorMessage()
  const canExpand = Boolean(errorMessage) || server.resources.length > 0

  // 状态标签与色调（dot 用实色，chip 用语义底色）
  const getStatusInfo = (): { tone: ChipTone; dot: string; label: string; icon: typeof CheckIcon | null } => {
    switch (status.status) {
      case 'connected':
        return { tone: 'success', dot: 'bg-success-100', label: t('mcpPanel.connected'), icon: CheckIcon }
      case 'disabled':
        return { tone: 'neutral', dot: 'bg-text-500', label: t('mcpPanel.disabled'), icon: null }
      case 'failed':
        return { tone: 'danger', dot: 'bg-danger-100', label: t('common:failed'), icon: AlertCircleIcon }
      case 'needs_auth':
        return { tone: 'warning', dot: 'bg-warning-100', label: t('mcpPanel.needsAuth'), icon: KeyIcon }
      case 'needs_client_registration':
        return { tone: 'warning', dot: 'bg-warning-100', label: t('mcpPanel.needsRegistration'), icon: KeyIcon }
      default:
        return { tone: 'neutral', dot: 'bg-text-500', label: t('common:unknown'), icon: null }
    }
  }

  const statusInfo = getStatusInfo()
  const StatusIcon = statusInfo.icon

  // 渲染操作按钮：统一用 Button 组件，避免各状态各自手写底色
  const renderActions = () => {
    if (isLoading) {
      return <SpinnerIcon size={14} className="animate-spin text-text-400" />
    }

    switch (status.status) {
      case 'connected':
        return (
          <Button
            variant="secondary"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onDisconnect(name)
            }}
          >
            {t('mcpPanel.disconnect')}
          </Button>
        )
      case 'disabled':
      case 'failed':
        return (
          <Button
            variant="secondary"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onConnect(name)
            }}
          >
            {t('mcpPanel.connect')}
          </Button>
        )
      case 'needs_auth':
      case 'needs_client_registration':
        return (
          <Button
            variant="primary"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onAuth(name)
            }}
          >
            <ExternalLinkIcon size={10} />
            {t('mcpPanel.authenticate')}
          </Button>
        )
      default:
        return null
    }
  }

  return (
    <div className="group">
      {/* Main row */}
      <div
        className={cn('flex items-center gap-2 rounded-md px-2 py-2', canExpand && interactive.subtle)}
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        {/* Expand icon only if there are details to show */}
        {canExpand ? (
          <span className="text-text-400 shrink-0">
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Status indicator */}
        <span className={cn('size-2 rounded-full shrink-0', statusInfo.dot)} />

        {/* Server name + status chip */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-ui-base text-text-100">{name}</span>
            <Chip tone={statusInfo.tone} size="xs" className="gap-0.5">
              {StatusIcon && <StatusIcon size={9} />}
              {statusInfo.label}
            </Chip>
            {server.resources.length > 0 && (
              <span className="shrink-0 text-ui-xs tabular-nums text-text-500">
                {t('mcpPanel.resourceCount', { count: server.resources.length })}
              </span>
            )}
          </div>
          {errorMessage && !expanded && (
            <div className="mt-0.5 truncate text-ui-caption text-danger-100" title={errorMessage}>
              {errorMessage}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">{renderActions()}</div>
      </div>

      {/* Expanded Error Details */}
      {expanded && errorMessage && (
        <div className="mb-1 rounded-md bg-danger-bg px-2 py-2 text-ui-caption text-text-200 break-words font-mono">
          {errorMessage}
        </div>
      )}

      {expanded && server.resources.length > 0 && (
        <div className="mb-1 overflow-hidden rounded-md border border-border-100/40 bg-bg-200/25">
          <div className="flex items-center gap-1.5 border-b border-border-100/30 px-2 py-1 text-ui-sm font-medium text-text-300">
            <FileIcon size={12} />
            <span>{t('mcpPanel.resources')}</span>
          </div>
          <div className="divide-y divide-border-100/25">
            {server.resources.map(resource => (
              <div key={resource.uri} className="px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-ui-caption text-text-100">
                  <span className="truncate">{resource.name}</span>
                  {resource.mimeType && (
                    <span className="shrink-0 rounded bg-bg-300/60 px-1.5 py-0.5 text-ui-xs text-text-400">
                      {resource.mimeType}
                    </span>
                  )}
                </div>
                {resource.description && (
                  <div className="mt-0.5 line-clamp-2 text-ui-sm text-text-400">
                    {resource.description}
                  </div>
                )}
                <div className="mt-0.5 truncate font-mono text-ui-xs text-text-500">{resource.uri}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
