import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, Button, Checkbox, ConfirmDialog, NativeTooltip } from '../../../components/ui'
import { ArchiveIcon, ChevronDownIcon, FolderIcon, GlobeIcon, TrashIcon, UndoIcon } from '../../../components/Icons'
import { Spinner } from '../../../components/ui/Spinner'
import { useArchivedSessions } from '../../../hooks'
import type { ApiSession } from '../../../api'
import { splitSessionKey } from '../../../utils/sessionKey'
import { getDirectoryName } from '../../../utils/directoryUtils'
import { cn } from '../../../utils/cn'
import { interactive } from '../../../utils/interaction'
import { formatLocaleDateTime } from '../../../utils/formatUtils'
import { ExpandableSection } from '../../../components/ui/AnimatedPresence'

interface ArchivedSessionsDialogProps {
  isOpen: boolean
  onClose: () => void
  serverId?: string
  /** 恢复后跳转/刷新用（当前不需要，保留以便调用方联动） */
  activeSessionKey?: string | null
}

export function ArchivedSessionsDialog({ isOpen, onClose, serverId }: ArchivedSessionsDialogProps) {
  const { t } = useTranslation(['chat', 'common', 'commands'])
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('chat:archived.title', { defaultValue: 'Archived chats' })}
      width={680}
      className="w-full"
    >
      {isOpen ? <ArchivedSessionsBody serverId={serverId} /> : null}
    </Dialog>
  )
}

function ArchivedSessionsBody({ serverId }: { serverId?: string }) {
  const { t } = useTranslation(['chat', 'common', 'commands'])
  const { sessions, isLoading, error, restore, remove, removeMany } = useArchivedSessions({ enabled: true, serverId })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [isBulkBusy, setIsBulkBusy] = useState(false)
  const [bulkFailed, setBulkFailed] = useState(false)
  // 记录被折叠的项目；不在集合内即为展开（默认全部展开）
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0)),
    [sessions],
  )

  // 按项目（目录）分组，保留每组内归档时间倒序；无目录的会话归入「全局」
  const groups = useMemo(() => {
    const map = new Map<string, { directory: string; name: string; sessions: ApiSession[] }>()
    for (const session of sorted) {
      const directory = session.directory || ''
      const key = directory || '\u0000global'
      let group = map.get(key)
      if (!group) {
        group = {
          directory,
          name: directory
            ? getDirectoryName(directory) || directory
            : t('chat:sidebar.global', { defaultValue: 'Global' }),
          sessions: [],
        }
        map.set(key, group)
      }
      group.sessions.push(session)
    }
    return Array.from(map.values())
  }, [sorted, t])

  const toggleProject = useCallback((directory: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }, [])

  const outgoing = sorted.filter(session => selected.has(session.id))
  const allSelected = sorted.length > 0 && outgoing.length === sorted.length
  const someSelected = outgoing.length > 0 && !allSelected

  const toggleOne = useCallback((sessionKey: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(sessionKey)) next.delete(sessionKey)
      else next.add(sessionKey)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected(prev => (prev.size === sorted.length ? new Set() : new Set(sorted.map(session => session.id))))
  }, [sorted])

  const handleRestore = async (sessionId: string) => {
    setBusyId(sessionId)
    try {
      await restore(sessionId)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (sessionId: string) => {
    setBusyId(sessionId)
    try {
      await remove(sessionId)
      setConfirmId(null)
    } finally {
      setBusyId(null)
    }
  }

  const handleDeleteSelected = async () => {
    if (outgoing.length === 0) return
    setIsBulkBusy(true)
    setBulkFailed(false)
    try {
      const failed = await removeMany(outgoing.map(session => session.id))
      const failedRawIds = new Set(failed)
      setSelected(
        new Set(outgoing.filter(session => failedRawIds.has(splitSessionKey(session.id).sessionId)).map(s => s.id)),
      )
      setBulkFailed(failed.length > 0)
      if (failed.length === 0) setConfirmBulk(false)
    } finally {
      setIsBulkBusy(false)
    }
  }

  const handleClearAll = async () => {
    if (sorted.length === 0) return
    setIsBulkBusy(true)
    setBulkFailed(false)
    try {
      const failed = await removeMany(sorted.map(session => session.id))
      const failedRawIds = new Set(failed)
      setSelected(
        new Set(sorted.filter(session => failedRawIds.has(splitSessionKey(session.id).sessionId)).map(s => s.id)),
      )
      setBulkFailed(failed.length > 0)
      if (failed.length === 0) setConfirmClearAll(false)
    } finally {
      setIsBulkBusy(false)
    }
  }

  if (isLoading && sorted.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-text-400">
        <Spinner size="sm" tone="muted" variant="ring" />
        {t('common:loading')}
      </div>
    )
  }

  if (error && sorted.length === 0) {
    return (
      <div className="py-10 text-center text-ui-caption text-text-400">
        {t('chat:archived.loadFailed', { defaultValue: 'Failed to load archived chats' })}
      </div>
    )
  }

  if (sorted.length === 0) {
    return (
      <div className="py-10 flex flex-col items-center gap-2 text-text-400">
        <ArchiveIcon size={24} className="opacity-50" />
        <span className="text-ui-caption">{t('chat:archived.empty', { defaultValue: 'No archived chats' })}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 -mt-1 mb-2 flex items-center gap-3 border-b border-border-100/50 pb-2">
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={() => toggleAll()}
          aria-label={t('chat:archived.selectAll', { defaultValue: 'Select all' })}
        />
        <button
          type="button"
          onClick={() => toggleAll()}
          className="text-ui-xs text-text-400 hover:text-text-200 transition-colors"
        >
          {t('chat:archived.selectAll', { defaultValue: 'Select all' })}
        </button>
        <span className="flex-1 text-ui-xs tabular-nums text-text-500">
          {outgoing.length > 0
            ? t('chat:archived.selectedCount', { count: outgoing.length, defaultValue: '{{count}} selected' })
            : t('chat:archived.totalCount', { count: sorted.length, defaultValue: '{{count}} archived' })}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={outgoing.length === 0 || isBulkBusy}
          onClick={() => {
            setBulkFailed(false)
            setConfirmBulk(true)
          }}
        >
          <TrashIcon size={13} />
          {t('chat:archived.deleteSelected', { defaultValue: 'Delete selected' })}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={isBulkBusy}
          onClick={() => {
            setBulkFailed(false)
            setConfirmClearAll(true)
          }}
        >
          <TrashIcon size={13} />
          {t('chat:archived.clearAll', { defaultValue: 'Delete all' })}
        </Button>
      </div>

      {bulkFailed && (
        <div className="mb-2 rounded-md bg-danger-100/10 px-3 py-2 text-ui-xs text-danger-100">
          {t('chat:archived.deleteFailed', { defaultValue: 'Some chats failed to delete. Please retry.' })}
        </div>
      )}

      <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-0.5">
        {groups.map(group => {
          const groupKey = group.directory || '\u0000global'
          const isExpanded = !collapsedProjects.has(group.directory)
          const GroupIcon = group.directory ? FolderIcon : GlobeIcon
          const groupSelectedCount = group.sessions.filter(session => selected.has(session.id)).length
          const groupAllSelected = groupSelectedCount === group.sessions.length
          const groupSomeSelected = groupSelectedCount > 0 && !groupAllSelected
          return (
            <div key={groupKey} className="flex flex-col">
              <div
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border border-border-200/50 bg-bg-100 px-3 py-2',
                  interactive.row,
                )}
              >
                <Checkbox
                  checked={groupAllSelected ? true : groupSomeSelected ? 'indeterminate' : false}
                  onCheckedChange={() =>
                    setSelected(prev => {
                      const next = new Set(prev)
                      if (groupAllSelected) group.sessions.forEach(session => next.delete(session.id))
                      else group.sessions.forEach(session => next.add(session.id))
                      return next
                    })
                  }
                  aria-label={group.name}
                />
                <NativeTooltip>
                  <button
                    type="button"
                    onClick={() => toggleProject(group.directory)}
                    className="group flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
                    title={group.directory || group.name}
                  >
                    <span className="relative size-5 shrink-0 flex items-center justify-center">
                      <GroupIcon
                        size={16}
                        className={cn(
                          'transition-opacity duration-150 group-hover:opacity-0',
                          group.directory ? 'text-text-400' : 'text-accent-main-100',
                        )}
                      />
                      <ChevronDownIcon
                        size={13}
                        className={cn(
                          'absolute text-text-300 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100',
                          isExpanded ? '' : '-rotate-90',
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-caption font-semibold text-text-100">
                      {group.name}
                    </span>
                    <span className="shrink-0 text-ui-xs tabular-nums text-text-500">{group.sessions.length}</span>
                  </button>
                </NativeTooltip>
              </div>

              <ExpandableSection show={isExpanded}>
                <div className="mt-1 flex flex-col gap-1 pl-4">
                  {group.sessions.map(session => {
                    const rawId = splitSessionKey(session.id).sessionId
                    const isBusy = busyId === session.id || isBulkBusy
                    const isConfirming = confirmId === session.id
                    const isSelected = selected.has(session.id)
                    return (
                      <div
                        key={session.id}
                        className={cn(
                          'group flex items-center gap-3 rounded-lg border px-3 py-2',
                          'transition-colors',
                          isSelected
                            ? 'border-accent-main-100/50 bg-accent-main-100/5'
                            : cn('border-border-200/40 bg-bg-100', interactive.row),
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={isBusy}
                          onCheckedChange={() => toggleOne(session.id)}
                          aria-label={
                            session.title || t('commands:sessions.untitledChat', { defaultValue: 'Untitled' })
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-ui-caption text-text-200">
                            {session.title || t('commands:sessions.untitledChat', { defaultValue: 'Untitled' })}
                          </div>
                          <div className="mt-0.5 text-ui-xs tabular-nums text-text-500">
                            {formatLocaleDateTime(session.time?.archived)}
                          </div>
                        </div>

                        {isConfirming ? (
                          <div className="shrink-0 flex items-center gap-2">
                            <Button
                              variant="danger"
                              size="sm"
                              isLoading={isBusy}
                              onClick={() => void handleDelete(session.id)}
                            >
                              {t('common:confirm')}
                            </Button>
                            <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => setConfirmId(null)}>
                              {t('common:cancel')}
                            </Button>
                          </div>
                        ) : (
                          <div className="shrink-0 flex items-center gap-1">
                            <NativeTooltip>
                              <button
                                type="button"
                                title={t('chat:archived.restore', { defaultValue: 'Restore' })}
                                disabled={isBusy}
                                onClick={() => void handleRestore(session.id)}
                                className={cn(
                                  'flex h-7 items-center gap-1 rounded-md px-2 text-ui-xs',
                                  'bg-bg-200 text-text-300 transition-colors duration-150',
                                  'hover:bg-bg-300 active:bg-bg-300',
                                  isBusy && 'opacity-50',
                                )}
                              >
                                {isBusy ? <Spinner size="xs" tone="current" variant="ring" /> : <UndoIcon size={13} />}
                                <span>{t('chat:archived.restore', { defaultValue: 'Restore' })}</span>
                              </button>
                            </NativeTooltip>
                            <NativeTooltip>
                              <button
                                type="button"
                                title={t('chat:archived.delete', { defaultValue: 'Delete' })}
                                disabled={isBusy}
                                onClick={() => setConfirmId(session.id)}
                                className={cn(
                                  'flex h-7 items-center gap-1 rounded-md px-2 text-ui-xs',
                                  'bg-danger-100/10 text-danger-100 transition-colors duration-150',
                                  'hover:bg-danger-100/20 active:bg-danger-100/30',
                                  isBusy && 'opacity-50',
                                )}
                                data-session-id={rawId}
                              >
                                <TrashIcon size={13} />
                              </button>
                            </NativeTooltip>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </ExpandableSection>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        isOpen={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={() => void handleDeleteSelected()}
        title={t('chat:archived.deleteSelected', { defaultValue: 'Delete selected' })}
        description={t('chat:archived.deleteSelectedConfirm', {
          count: outgoing.length,
          defaultValue: 'Permanently delete {{count}} archived chat(s)? This cannot be undone.',
        })}
        variant="danger"
        isLoading={isBulkBusy}
      />

      <ConfirmDialog
        isOpen={confirmClearAll}
        onClose={() => setConfirmClearAll(false)}
        onConfirm={() => void handleClearAll()}
        title={t('chat:archived.clearAll', { defaultValue: 'Delete all' })}
        description={t('chat:archived.clearAllConfirm', {
          count: sorted.length,
          defaultValue: 'Permanently delete all {{count}} archived chat(s)? This cannot be undone.',
        })}
        variant="danger"
        isLoading={isBulkBusy}
      />
    </div>
  )
}
