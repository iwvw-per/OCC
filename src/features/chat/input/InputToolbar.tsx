import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { logger } from '../../../utils/logger'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, PaperclipIcon, AgentIcon, ThinkingIcon } from '../../../components/Icons'
import { DropdownMenu, MenuItem, IconButton, AnimatedPresence } from '../../../components/ui'
import { ModelSelector, type ModelSelectorHandle } from '../ModelSelector'
import { useChatViewport } from '../chatViewport'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { touchTarget } from '../../../utils/interaction'
import { isTauri, isTauriMobile, extToMime } from '../../../utils/tauri'
import type { ApiAgent } from '../../../api/client'
import type { ModelInfo, FileCapabilities } from '../../../api'

interface InputToolbarProps {
  agents: ApiAgent[]
  selectedAgent?: string
  onAgentChange?: (agentName: string) => void

  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void

  fileCapabilities?: FileCapabilities
  onFilesSelected: (files: File[]) => void

  /** 发送中：禁用选择器与附件，避免中途改模型/添附件 */
  isSending?: boolean

  // Model selection（移动端显示在工具栏）
  models?: ModelInfo[]
  selectedModelKey?: string | null
  onModelChange?: (modelKey: string, model: ModelInfo) => void
  modelsLoading?: boolean
  // 输入框容器 ref，用于约束菜单边界
  inputContainerRef?: React.RefObject<HTMLDivElement | null>
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
}

export function InputToolbar({
  agents,
  selectedAgent,
  onAgentChange,
  variants = [],
  selectedVariant,
  onVariantChange,
  fileCapabilities,
  onFilesSelected,
  isSending = false,
  models = [],
  selectedModelKey = null,
  onModelChange,
  modelsLoading = false,
  inputContainerRef,
  modelSelectorRef,
}: InputToolbarProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { presentation } = useChatViewport()
  const isCompact = presentation.isCompact
  const { preferTouchUi } = useInputCapabilities()
  const useBrowserFileInput = !isTauri() || isTauriMobile()

  // 根据模型能力计算支持的文件类型
  const caps = fileCapabilities ?? { image: false, pdf: false, audio: false, video: false }
  const supportsAnyFile = caps.image || caps.pdf || caps.audio || caps.video
  const controlsDisabled = isSending

  // 动态构建 HTML accept 和 Tauri filter
  const { acceptString, tauriFilters } = useMemo(() => {
    const accept: string[] = []
    const extensions: string[] = []
    const filterNames: string[] = []

    if (caps.image) {
      accept.push('image/*')
      extensions.push('png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg')
      filterNames.push(t('inputToolbar.filterImages'))
    }
    if (caps.pdf) {
      accept.push('application/pdf')
      extensions.push('pdf')
      filterNames.push(t('inputToolbar.filterPdf'))
    }
    if (caps.audio) {
      accept.push('audio/*')
      extensions.push('mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a')
      filterNames.push(t('inputToolbar.filterAudio'))
    }
    if (caps.video) {
      accept.push('video/*')
      extensions.push('mp4', 'webm', 'mov', 'avi', 'mkv')
      filterNames.push(t('inputToolbar.filterVideo'))
    }

    return {
      acceptString: accept.join(','),
      tauriFilters: extensions.length > 0 ? [{ name: filterNames.join(' / '), extensions }] : [],
    }
  }, [caps.image, caps.pdf, caps.audio, caps.video, t])
  // State for menus
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [variantMenuOpen, setVariantMenuOpen] = useState(false)

  // Refs
  const agentTriggerRef = useRef<HTMLButtonElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const variantTriggerRef = useRef<HTMLButtonElement>(null)
  const variantMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentMenuFocusRef = useRef<'selected' | 'first' | 'last'>('selected')
  const variantMenuFocusRef = useRef<'selected' | 'first' | 'last'>('selected')
  const agentMenuId = 'input-toolbar-agent-menu'
  const variantMenuId = 'input-toolbar-variant-menu'

  const focusComposerInput = useCallback(() => {
    const input = inputContainerRef?.current?.querySelector<HTMLElement>(
      'textarea, input:not([type="file"]):not([disabled]), [contenteditable="true"]',
    )
    input?.focus()
  }, [inputContainerRef])

  const closeMenuToComposer = useCallback(
    (close: () => void) => {
      close()
      /**
       * 触摸端不主动回焦输入框。
       *
       * 桌面端这么做是对的：用键盘选完「对话模式 / 思考强度」，手接着就能打字。
       * 但在触摸端，`focus()` 会**立刻拉起软键盘**，把刚关掉的菜单区域整块顶走，
       * 用户只是选了个模式却被打断输入节奏（实测在手机上切一次模式就弹一次键盘）。
       *
       * 焦点因此留在触发按钮上：既不会弹键盘，屏幕阅读器的落点也仍然明确。
       */
      if (preferTouchUi) return
      window.setTimeout(focusComposerInput, 0)
    },
    [focusComposerInput, preferTouchUi],
  )

  const focusMenuItem = useCallback((menu: HTMLDivElement | null, mode: 'selected' | 'first' | 'last') => {
    if (!menu) return

    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], button'))
    if (items.length === 0) return

    const selectedItem = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
    const target = mode === 'first' ? items[0] : mode === 'last' ? items[items.length - 1] : (selectedItem ?? items[0])
    target?.focus()
  }, [])

  const focusRelativeToTrigger = useCallback((trigger: HTMLButtonElement | null, direction: 1 | -1) => {
    if (!trigger) return

    const focusables = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([type="file"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(element => {
      if (element.closest('[aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
    })
    const currentIndex = focusables.findIndex(item => item === trigger)
    if (currentIndex === -1) return
    const nextIndex = currentIndex + direction
    focusables[nextIndex]?.focus()
  }, [])

  const isFocusableElement = useCallback((target: EventTarget | null) => {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    if (!element) return false
    const candidate = element.closest<HTMLElement>(
      'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!candidate) return false

    const style = window.getComputedStyle(candidate)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }, [])

  const handleMenuKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      menu: HTMLDivElement | null,
      onClose: () => void,
      trigger: HTMLButtonElement | null,
    ) => {
      const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], button') ?? [])
      if (items.length === 0) {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          trigger?.focus()
        }
        return
      }

      const currentIndex = items.findIndex(item => item === document.activeElement)
      const focusByIndex = (index: number) => items[index]?.focus()

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % items.length
        focusByIndex(nextIndex)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        const nextIndex = currentIndex === -1 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
        focusByIndex(nextIndex)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusByIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusByIndex(items.length - 1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        trigger?.focus()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        onClose()
        window.setTimeout(() => {
          focusRelativeToTrigger(trigger, event.shiftKey ? -1 : 1)
        }, 0)
      }
    },
    [focusRelativeToTrigger],
  )

  // 文件选择器（Tauri 原生 / 浏览器 fallback）
  const handleFileClick = useCallback(async () => {
    if (useBrowserFileInput) {
      fileInputRef.current?.click()
      return
    }

    try {
      const [{ open }, { readFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ])

      const selected = await open({
        multiple: true,
        filters: tauriFilters,
        fileAccessMode: 'copy',
      })

      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return

      const files: File[] = []
      for (const path of paths) {
        const fileName = path.split(/[\\/]/).pop() || 'file'
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const mime = extToMime(ext)

        const data = await readFile(path)
        const file = new File([data], fileName, { type: mime })
        files.push(file)
      }

      if (files.length > 0) {
        onFilesSelected(files)
      }
    } catch (err) {
      logger.warn('[InputToolbar] File picker error:', err)
    }
  }, [onFilesSelected, tauriFilters, useBrowserFileInput])

  // Click outside logic
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        agentMenuOpen &&
        !agentMenuRef.current?.contains(e.target as Node) &&
        !agentTriggerRef.current?.contains(e.target as Node)
      ) {
        setAgentMenuOpen(false)
        if (!isFocusableElement(e.target)) {
          agentTriggerRef.current?.focus()
        }
      }
      if (
        variantMenuOpen &&
        !variantMenuRef.current?.contains(e.target as Node) &&
        !variantTriggerRef.current?.contains(e.target as Node)
      ) {
        setVariantMenuOpen(false)
        if (!isFocusableElement(e.target)) {
          variantTriggerRef.current?.focus()
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [agentMenuOpen, variantMenuOpen, isFocusableElement])

  useEffect(() => {
    if (!agentMenuOpen) return
    const timerId = window.setTimeout(() => {
      focusMenuItem(agentMenuRef.current, agentMenuFocusRef.current)
    }, 0)
    return () => clearTimeout(timerId)
  }, [agentMenuOpen, focusMenuItem])

  useEffect(() => {
    if (!variantMenuOpen) return
    const timerId = window.setTimeout(() => {
      focusMenuItem(variantMenuRef.current, variantMenuFocusRef.current)
    }, 0)
    return () => clearTimeout(timerId)
  }, [variantMenuOpen, focusMenuItem])

  const selectableAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
  const currentAgent = agents.find(a => a.name === selectedAgent)

  return (
    // 右侧留出 ChatFab 的位置（FAB 绝对定位在输入框右下角，宽 32 + right 18）
    <div className="flex items-center justify-between pl-3 pr-14 pb-3 relative">
      {/* Left side: Model + Agent + Variant selectors */}
      <div className={`flex items-center min-w-0 ${isCompact ? 'gap-1' : 'gap-2'}`}>
        {/* Agent Selector（模式选择） */}
        <AnimatedPresence show={selectableAgents.length > 1} className={isCompact ? 'shrink min-w-0' : ''}>
          <div className={isCompact ? 'relative min-w-0' : 'relative'}>
            <button
              ref={agentTriggerRef}
              type="button"
              onClick={() => {
                agentMenuFocusRef.current = 'selected'
                setAgentMenuOpen(!agentMenuOpen)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  agentMenuFocusRef.current = e.key === 'ArrowUp' ? 'last' : 'first'
                  setAgentMenuOpen(true)
                }
              }}
              disabled={controlsDisabled}
              aria-haspopup="menu"
              aria-expanded={agentMenuOpen}
              aria-controls={agentMenuOpen ? agentMenuId : undefined}
              className={`flex items-center gap-1.5 px-2 py-1.5 text-[length:var(--fs-base)] rounded-lg transition-colors duration-150 hover:bg-bg-200 active:bg-bg-300 cursor-pointer min-w-0 overflow-hidden ${isCompact ? 'max-w-[6rem]' : 'w-full'} ${touchTarget.chip}`}
              title={
                currentAgent
                  ? `${currentAgent.name}${currentAgent.description ? ': ' + currentAgent.description : ''}`
                  : selectedAgent || 'build'
              }
            >
              {/* 紧凑信息流隐藏 AgentIcon 节省空间 */}
              <span
                className={`text-text-400 shrink-0 ${isCompact ? 'hidden' : ''}`}
                style={currentAgent?.color ? { color: currentAgent.color } : undefined}
              >
                <AgentIcon />
              </span>
              <span className="text-[length:var(--fs-sm)] text-text-300 capitalize truncate">
                {selectedAgent || 'build'}
              </span>
              {/* 箭头与 ModelSelector 保持一致：展开时旋转 180°，带过渡 */}
              <span
                className={`text-text-400 shrink-0 transition-transform duration-200 ${isCompact ? 'hidden' : ''} ${
                  agentMenuOpen ? 'rotate-180' : ''
                }`}
              >
                <ChevronDownIcon />
              </span>
            </button>

            <DropdownMenu
              triggerRef={agentTriggerRef}
              isOpen={agentMenuOpen}
              position="top"
              align="left"
              constrainToRef={inputContainerRef}
            >
              <div
                id={agentMenuId}
                ref={agentMenuRef}
                role="menu"
                aria-label={t('header.agentMenu')}
                className="flex flex-col gap-0.5"
                onKeyDown={event =>
                  handleMenuKeyDown(event, agentMenuRef.current, () => setAgentMenuOpen(false), agentTriggerRef.current)
                }
              >
                {selectableAgents.map(agent => (
                  <MenuItem
                    key={agent.name}
                    label={agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}
                    description={agent.description}
                    icon={
                      <span style={agent.color ? { color: agent.color } : undefined}>
                        <AgentIcon />
                      </span>
                    }
                    selected={selectedAgent === agent.name}
                    selectionRole="menuitemradio"
                    onClick={() => {
                      onAgentChange?.(agent.name)
                      closeMenuToComposer(() => setAgentMenuOpen(false))
                    }}
                  />
                ))}
              </div>
            </DropdownMenu>
          </div>
        </AnimatedPresence>

        {/* Model Selector — 放在模式选择后面（桌面 + 移动端）
            移动端必须保证入口可见可点：给它 shrink-0 与最小宽度，
            让 Agent / Variant 先让位，而不是把模型入口挤成 0 宽 */}
        {onModelChange && (
          <div className={isCompact ? 'shrink-0 min-w-[6.5rem] max-w-[11rem]' : 'min-w-0 flex-1'}>
            <ModelSelector
              ref={modelSelectorRef}
              models={models}
              selectedModelKey={selectedModelKey}
              onSelect={onModelChange}
              isLoading={modelsLoading}
              position="top"
              trigger="toolbar"
              constrainToRef={inputContainerRef}
            />
          </div>
        )}

        {/* Variant Selector */}
        <AnimatedPresence show={variants.length > 0} className={isCompact ? 'shrink min-w-0' : ''}>
          <div className={isCompact ? 'relative min-w-0' : 'relative'}>
            <button
              ref={variantTriggerRef}
              type="button"
              onClick={() => {
                variantMenuFocusRef.current = 'selected'
                setVariantMenuOpen(!variantMenuOpen)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  variantMenuFocusRef.current = e.key === 'ArrowUp' ? 'last' : 'first'
                  setVariantMenuOpen(true)
                }
              }}
              disabled={controlsDisabled}
              aria-haspopup="menu"
              aria-expanded={variantMenuOpen}
              aria-controls={variantMenuOpen ? variantMenuId : undefined}
              className={`flex items-center gap-1.5 px-2 py-1.5 text-[length:var(--fs-base)] rounded-lg transition-colors duration-150 hover:bg-bg-200 active:bg-bg-300 cursor-pointer min-w-0 overflow-hidden ${isCompact ? 'max-w-[5.5rem]' : 'w-full'} ${touchTarget.chip}`}
              title={
                selectedVariant
                  ? selectedVariant.charAt(0).toUpperCase() + selectedVariant.slice(1)
                  : t('inputToolbar.default')
              }
            >
              {/* 紧凑信息流隐藏 ThinkingIcon */}
              <span className={`text-text-400 shrink-0 ${isCompact ? 'hidden' : ''}`}>
                <ThinkingIcon />
              </span>
              <span className="text-[length:var(--fs-sm)] text-text-300 truncate">
                {selectedVariant
                  ? selectedVariant.charAt(0).toUpperCase() + selectedVariant.slice(1)
                  : t('inputToolbar.default')}
              </span>
              {/* 箭头与 ModelSelector 保持一致：展开时旋转 180°，带过渡 */}
              <span
                className={`text-text-400 shrink-0 transition-transform duration-200 ${isCompact ? 'hidden' : ''} ${
                  variantMenuOpen ? 'rotate-180' : ''
                }`}
              >
                <ChevronDownIcon />
              </span>
            </button>

            <DropdownMenu
              triggerRef={variantTriggerRef}
              isOpen={variantMenuOpen}
              position="top"
              align="left"
              minWidth="auto"
              constrainToRef={inputContainerRef}
            >
              <div
                id={variantMenuId}
                ref={variantMenuRef}
                role="menu"
                aria-label={t('header.variantMenu')}
                className="flex flex-col gap-0.5"
                onKeyDown={event =>
                  handleMenuKeyDown(
                    event,
                    variantMenuRef.current,
                    () => setVariantMenuOpen(false),
                    variantTriggerRef.current,
                  )
                }
              >
                <MenuItem
                  label={t('inputToolbar.default')}
                  icon={<ThinkingIcon />}
                  selected={!selectedVariant}
                  selectionRole="menuitemradio"
                  onClick={() => {
                    onVariantChange?.(undefined)
                    closeMenuToComposer(() => setVariantMenuOpen(false))
                  }}
                />
                {variants.map(variant => (
                  <MenuItem
                    key={variant}
                    label={variant.charAt(0).toUpperCase() + variant.slice(1)}
                    icon={<ThinkingIcon />}
                    selected={selectedVariant === variant}
                    selectionRole="menuitemradio"
                    onClick={() => {
                      onVariantChange?.(variant)
                      closeMenuToComposer(() => setVariantMenuOpen(false))
                    }}
                  />
                ))}
              </div>
            </DropdownMenu>
          </div>
        </AnimatedPresence>
      </div>

      {/* Action Buttons — 发送 / 停止已移出，由右下角的 ChatFab 承担（同一图标形变）。
          这里只保留附件、上传等左侧动作。 */}
      <div className="flex items-center gap-1 shrink-0">
        <AnimatedPresence show={supportsAnyFile}>
          <>
            {/* 浏览器模式下的隐藏文件输入 */}
            {useBrowserFileInput && (
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptString}
                multiple
                className="hidden"
                onChange={e => {
                  onFilesSelected(Array.from(e.target.files ?? []))
                  e.currentTarget.value = ''
                }}
              />
            )}
            <IconButton aria-label={t('inputToolbar.attachFile')} disabled={controlsDisabled} onClick={handleFileClick}>
              <PaperclipIcon />
            </IconButton>
          </>
        </AnimatedPresence>
      </div>
    </div>
  )
}
