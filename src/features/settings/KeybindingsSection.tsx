/**
 * KeybindingsSection - 快捷键设置
 * 简洁平铺列表，无 emoji，搜索即过滤
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useKeybindingStore } from '../../hooks/useKeybindings'
import { keyEventToString, formatKeybinding, parseKeybinding } from '../../store/keybindingStore'
import { UndoIcon, SearchIcon } from '../../components/Icons'
import type { KeybindingConfig, KeybindingAction } from '../../store/keybindingStore'
import { SettingsSection } from './components/SettingsUI'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'

const ACTION_TRANSLATION_KEYS: Record<KeybindingAction, { label: string; description: string }> = {
  openSettings: { label: 'openSettings', description: 'openSettingsDesc' },
  openProject: { label: 'openProject', description: 'openProjectDesc' },
  commandPalette: { label: 'commandPalette', description: 'commandPaletteDesc' },
  toggleSidebar: { label: 'toggleSidebar', description: 'toggleSidebarDesc' },
  toggleRightPanel: { label: 'toggleRightPanel', description: 'toggleRightPanelDesc' },
  focusInput: { label: 'focusInput', description: 'focusInputDesc' },
  newSession: { label: 'newSession', description: 'newSessionDesc' },
  archiveSession: { label: 'archiveSession', description: 'archiveSessionDesc' },
  previousSession: { label: 'previousSession', description: 'previousSessionDesc' },
  nextSession: { label: 'nextSession', description: 'nextSessionDesc' },
  toggleTerminal: { label: 'toggleTerminal', description: 'toggleTerminalDesc' },
  newTerminal: { label: 'newTerminal', description: 'newTerminalDesc' },
  'terminal.copySelection': { label: 'terminalCopySelection', description: 'terminalCopySelectionDesc' },
  'terminal.paste': { label: 'terminalPaste', description: 'terminalPasteDesc' },
  selectModel: { label: 'selectModel', description: 'selectModelDesc' },
  toggleAgent: { label: 'toggleAgent', description: 'toggleAgentDesc' },
  sendMessage: { label: 'sendMessage', description: 'sendMessageDesc' },
  cancelMessage: { label: 'cancelMessage', description: 'cancelMessageDesc' },
  copyLastResponse: { label: 'copyLastResponse', description: 'copyLastResponseDesc' },
  toggleFullAuto: { label: 'toggleFullAuto', description: 'toggleFullAutoDesc' },
  focusNextPane: { label: 'focusNextPane', description: 'focusNextPaneDesc' },
  focusPrevPane: { label: 'focusPrevPane', description: 'focusPrevPaneDesc' },
  splitRight: { label: 'splitRight', description: 'splitRightDesc' },
  splitDown: { label: 'splitDown', description: 'splitDownDesc' },
  closePane: { label: 'closePane', description: 'closePaneDesc' },
  togglePaneFullscreen: { label: 'togglePaneFullscreen', description: 'togglePaneFullscreenDesc' },
}

// ============================================
// Kbd - 按键胶囊
// ============================================

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5
                    text-ui-sm font-mono font-medium leading-none
                    bg-bg-100 text-text-300 border border-border-200 rounded
                    shadow-[0_1px_0_0_var(--border-200)]"
    >
      {children}
    </kbd>
  )
}

function ShortcutDisplay({ shortcut, className }: { shortcut: string; className?: string }) {
  const parsed = parseKeybinding(shortcut)
  const formatted = formatKeybinding(parsed)
  const parts = formatted.split(' + ')
  return (
    <span className={`inline-flex items-center gap-0.5 ${className || ''}`}>
      {parts.map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </span>
  )
}

// ============================================
// KeybindingRow - 单行编辑
// ============================================

interface KeybindingRowProps {
  config: KeybindingConfig
  onEdit: (action: KeybindingAction, newKey: string) => void
  onReset: (action: KeybindingAction) => void
  isKeyUsed: (key: string, exclude?: KeybindingAction, scope?: KeybindingConfig['scope']) => boolean
  t: (key: string) => string
}

function KeybindingRow({ config, onEdit, onReset, isKeyUsed, t }: KeybindingRowProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [tempKey, setTempKey] = useState('')
  const [error, setError] = useState('')
  const captureRef = useRef<HTMLDivElement>(null)
  const isModified = config.currentKey !== config.defaultKey

  useEffect(() => {
    if (isEditing) captureRef.current?.focus()
  }, [isEditing])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

      const newKey = keyEventToString(e)
      setTempKey(newKey)
      setError(isKeyUsed(newKey, config.action, config.scope) ? t('keybindings.alreadyInUse') : '')
    },
    [isKeyUsed, config.action, config.scope, t],
  )

  const confirm = useCallback(() => {
    if (tempKey && !error) onEdit(config.action, tempKey)
    setIsEditing(false)
    setTempKey('')
    setError('')
  }, [tempKey, error, onEdit, config.action])

  const cancel = useCallback(() => {
    setIsEditing(false)
    setTempKey('')
    setError('')
  }, [])

  useEffect(() => {
    if (!isEditing) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      if (e.key === 'Enter' && tempKey && !error) {
        e.preventDefault()
        confirm()
        return
      }
      handleKeyDown(e)
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [isEditing, tempKey, error, handleKeyDown, confirm, cancel])

  return (
    <div
      data-setting-label={config.label}
      className={cn(
        'flex min-w-0 items-center h-9 px-3 rounded-md transition-colors group',
        // 编辑态（捕获按键）是选中态，非编辑态悬停回落到通用列表行词汇
        isEditing ? 'bg-accent-main-100/5 ring-1 ring-accent-main-100/20' : interactive.row,
      )}
    >
      {/* Label */}
      <span className="min-w-0 flex-1 truncate pr-2 text-ui-base text-text-200">{config.label}</span>

      {/* Reset */}
      {isModified && !isEditing && (
        <button
          type="button"
          onClick={() => onReset(config.action)}
          className={cn(
            'p-1 mr-1 rounded text-text-400 hover:text-text-100',
            interactive.subtle,
            interactive.focusRingCompact,
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
          )}
          title={t('keybindings.resetToDefault')}
        >
          <UndoIcon size={12} />
        </button>
      )}

      {/* Key */}
      {isEditing ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <div
            ref={captureRef}
            tabIndex={0}
            className={`
              min-w-[120px] h-7 flex items-center justify-center px-3
              text-ui-caption font-mono rounded border-2 outline-none
              ${
                error
                  ? 'border-danger-100/60 bg-danger-100/5 text-danger-100'
                  : 'border-accent-main-100/60 bg-accent-main-100/5 text-accent-main-100'
              }
            `}
          >
            {tempKey || <span className="text-text-400">...</span>}
          </div>
          {error && <span className="text-ui-sm text-danger-100">{error}</span>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setIsEditing(true)
            setTempKey('')
            setError('')
          }}
          className={cn(
            'h-7 shrink-0 flex items-center gap-0.5 px-1 rounded transition-colors',
            // 已改键的项用 accent 浅底标记，未改的用中性行悬停
            isModified ? 'hover:bg-accent-main-100/15' : interactive.subtle,
          )}
        >
          <ShortcutDisplay
            shortcut={config.currentKey}
            className={isModified ? '[&_kbd]:border-accent-main-100/40 [&_kbd]:text-accent-main-100' : ''}
          />
        </button>
      )}
    </div>
  )
}

// ============================================
// Main
// ============================================

const CATEGORY_ORDER: KeybindingConfig['category'][] = [
  'general',
  'session',
  'pane',
  'terminal',
  'model',
  'message',
  'permission',
]

const CATEGORY_LABELS: Record<KeybindingConfig['category'], string> = {
  general: 'keybindings.categories.general',
  session: 'keybindings.categories.session',
  pane: 'keybindings.categories.pane',
  terminal: 'keybindings.categories.terminal',
  model: 'keybindings.categories.model',
  message: 'keybindings.categories.message',
  permission: 'keybindings.categories.permission',
}

export function KeybindingsSection() {
  const { t } = useTranslation(['settings', 'common', 'commands'])
  const { keybindings, setKeybinding, resetKeybinding, resetAll, isKeyUsed } = useKeybindingStore()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const localizedKeybindings = useMemo(
    () =>
      keybindings.map(kb => ({
        ...kb,
        label: t(`commands:${ACTION_TRANSLATION_KEYS[kb.action].label}`),
        description: t(`commands:${ACTION_TRANSLATION_KEYS[kb.action].description}`),
      })),
    [keybindings, t],
  )

  // 搜索直接过滤，不需要 toggle
  const filtered = useMemo(() => {
    if (!search.trim()) return localizedKeybindings
    const q = search.toLowerCase()
    return localizedKeybindings.filter(
      kb =>
        kb.label.toLowerCase().includes(q) ||
        kb.description.toLowerCase().includes(q) ||
        kb.currentKey.toLowerCase().includes(q),
    )
  }, [localizedKeybindings, search])

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map(cat => ({ category: cat, items: filtered.filter(kb => kb.category === cat) })).filter(
        g => g.items.length > 0,
      ),
    [filtered],
  )

  const hasModifications = localizedKeybindings.some(kb => kb.currentKey !== kb.defaultKey)

  // 自动聚焦搜索
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  return (
    <SettingsSection
      plain
      title={t('keybindings.title')}
      description={t('keybindings.clickToRebind')}
      actions={
        hasModifications ? (
          <button
            type="button"
            onClick={resetAll}
            className={cn(
              'h-7 px-2 rounded-md text-ui-sm font-medium text-text-400',
              interactive.danger,
              interactive.focusRingCompact,
            )}
          >
            {t('keybindings.resetAll')}
          </button>
        ) : undefined
      }
    >
      <div className="relative group">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors pointer-events-none" />
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('keybindings.filterPlaceholder')}
          spellCheck={false}
          autoCorrect="off"
          autoComplete="off"
          autoCapitalize="off"
          className="w-full h-9 bg-bg-200/70 hover:bg-bg-200 border border-border-200/50 rounded-lg pl-9 pr-3 text-ui-caption text-text-100 placeholder:text-text-400/70 focus:outline-none transition-colors"
        />
      </div>

      <div className="-mx-1">
        {grouped.length === 0 ? (
          <div className="py-8 text-center text-ui-base text-text-400">{t('common:noMatches')}</div>
        ) : (
          grouped.map(({ category, items }) => (
            <div key={category} className="mb-3">
              <div className="px-3 py-1 text-ui-sm font-medium text-text-400 uppercase tracking-wider">
                {t(CATEGORY_LABELS[category])}
              </div>
              {/* 条目之间留 2px：KeybindingRow 是 rounded-md + hover 底色，
                  紧贴时相邻圆角会拼成一条凹槽 */}
              <div className="flex flex-col gap-0.5">
                {items.map(item => (
                  <KeybindingRow
                    key={item.action}
                    config={item}
                    onEdit={setKeybinding}
                    onReset={resetKeybinding}
                    isKeyUsed={isKeyUsed}
                    t={t}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

    </SettingsSection>
  )
}
