/**
 * ModelSelector - 统一模型选择器
 *
 * 单一组件同时服务 PC 端(Header)和移动端(InputToolbar)。
 * 通过 props 控制触发按钮样式、弹出方向等差异。
 *
 * 菜单结构(与 ZCode composer 对齐):
 *   端点行(向右展开子菜单)/ 分隔线 / 当前端点的模型列表 / 分隔线 / 思维强度滑动条
 *
 * 搜索、置顶、上下文长度都已移除:菜单是「按端点切换的短列表」,
 * 而不是需要检索的全局目录。
 */

import { useState, useRef, useEffect, useMemo, useCallback, memo, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PackageIcon,
  SpinnerIcon,
} from '../../components/Icons'
import { DropdownMenu } from '../../components/ui'
import type { ModelInfo } from '../../api'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'
import { getModelKey, groupModelsByProvider, recordModelUsage } from '../../utils/modelUtils'

// ============================================
// Public types
// ============================================

export interface ModelSelectorHandle {
  openMenu: () => void
}

const HOVER_CLOSE_DELAY_MS = 160

interface ModelSelectorProps {
  models: ModelInfo[]
  selectedModelKey: string | null
  onSelect: (modelKey: string, model: ModelInfo) => void
  isLoading?: boolean
  disabled?: boolean
  /** 弹出方向 */
  position?: 'bottom' | 'top'
  /** 约束菜单边界的容器 ref */
  constrainToRef?: React.RefObject<HTMLElement | null>
  /** 触发按钮的展示风格 */
  trigger?: 'header' | 'toolbar'
  /** 思维强度(模型变体)选项;存在时与模型选择合并到同一菜单 */
  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void
  /** 菜单开合变化:供外部在菜单打开期间抑制输入框滚动收起 */
  onMenuOpenChange?: (open: boolean) => void
}

// ============================================
// ModelSelector — 统一组件
// ============================================

export const ModelSelector = memo(
  forwardRef<ModelSelectorHandle, ModelSelectorProps>(function ModelSelector(
    {
      models,
      selectedModelKey,
      onSelect,
      isLoading = false,
      disabled = false,
      position = 'bottom',
      constrainToRef,
      trigger = 'header',
      variants = [],
      selectedVariant,
      onVariantChange,
      onMenuOpenChange,
    },
    ref,
  ) {
    const { t } = useTranslation('chat')
    const { preferTouchUi, canHover } = useInputCapabilities()
    const [isOpen, setIsOpen] = useState(false)
    const [highlightedIndex, setHighlightedIndex] = useState(0)
    /** 端点(provider)浏览态:null 表示跟随当前选中模型 */
    const [browseProviderId, setBrowseProviderId] = useState<string | null>(null)
    /** 端点子菜单是否展开 */
    const [endpointsOpen, setEndpointsOpen] = useState(false)

    const containerRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const pendingFocusIndexRef = useRef(0)
    const endpointHoverTimerRef = useRef<number | null>(null)

    const idPrefix = trigger === 'header' ? 'ms-item' : 'ms-tb-item'
    const listboxId = `${idPrefix}-listbox`

    // ---- Derived data ----

    const selectedModel = useMemo(() => {
      if (!selectedModelKey) return null
      return models.find(m => getModelKey(m) === selectedModelKey) ?? null
    }, [models, selectedModelKey])

    /** 全量端点分组,用于端点子菜单 */
    const allProviderGroups = useMemo(() => groupModelsByProvider(models), [models])

    /** 当前端点:优先用户显式选择的,其次当前模型所属端点,最后第一个端点 */
    const activeProviderId = useMemo(() => {
      if (browseProviderId && allProviderGroups.some(g => g.providerId === browseProviderId)) {
        return browseProviderId
      }
      const selectedProviderId = selectedModel?.providerId
      if (selectedProviderId && allProviderGroups.some(g => g.providerId === selectedProviderId)) {
        return selectedProviderId
      }
      return allProviderGroups[0]?.providerId ?? ''
    }, [allProviderGroups, browseProviderId, selectedModel?.providerId])

    const activeProviderGroup = allProviderGroups.find(g => g.providerId === activeProviderId)

    /** 当前端点下的模型列表 */
    const visibleModels = useMemo(
      () => models.filter(model => model.providerId === activeProviderId),
      [activeProviderId, models],
    )

    // ---- 思维强度档位 ----

    const thoughtLevels = useMemo(() => {
      if (variants.length === 0) return []
      return [
        { value: undefined as string | undefined, label: t('inputToolbar.default') },
        ...variants.map(variant => ({
          value: variant as string | undefined,
          label: variant.charAt(0).toUpperCase() + variant.slice(1),
        })),
      ]
    }, [t, variants])

    const thoughtIndex = Math.max(
      0,
      thoughtLevels.findIndex(level => level.value === selectedVariant),
    )
    // 第一档是「默认」(不指定思维强度),此时填充为空。
    const thoughtFilled = thoughtIndex > 0
    const thoughtProgress = thoughtLevels.length > 1 ? (thoughtIndex / (thoughtLevels.length - 1)) * 100 : 0

    // ---- Open / Close ----

    const closeMenu = useCallback((options?: { focusTrigger?: boolean }) => {
      setIsOpen(false)
      setEndpointsOpen(false)
      // 下次打开时回到当前模型所属端点,不保留上次临时浏览的端点。
      setBrowseProviderId(null)
      if (options?.focusTrigger !== false) {
        triggerRef.current?.focus()
      }
    }, [])

    const focusToolbarInput = useCallback(() => {
      if (trigger !== 'toolbar') return
      const container = constrainToRef?.current
      const input = container?.querySelector<HTMLElement>(
        'textarea, input:not([type="file"]):not([disabled]), [contenteditable="true"]',
      )
      input?.focus()
    }, [constrainToRef, trigger])

    const focusRelativeToTrigger = useCallback((direction: 1 | -1) => {
      const currentTrigger = triggerRef.current
      if (!currentTrigger) return

      const focusables = Array.from(
        document.body.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([type="file"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(element => {
        if (element.closest('[aria-hidden="true"]')) return false
        const style = window.getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      })
      const currentIndex = focusables.findIndex(item => item === currentTrigger)
      if (currentIndex === -1) return
      focusables[currentIndex + direction]?.focus()
    }, [])

    const openMenu = useCallback(
      (preferredIndex?: number) => {
        if (disabled || isLoading) return
        let targetIndex = 0
        if (typeof preferredIndex === 'number') {
          targetIndex = Math.max(0, Math.min(preferredIndex, visibleModels.length - 1))
        } else if (selectedModelKey) {
          const index = visibleModels.findIndex(m => getModelKey(m) === selectedModelKey)
          if (index !== -1) targetIndex = index
        }
        pendingFocusIndexRef.current = targetIndex
        setHighlightedIndex(targetIndex)
        setIsOpen(true)
      },
      [disabled, isLoading, selectedModelKey, visibleModels],
    )

    const cancelEndpointHoverClose = useCallback(() => {
      if (endpointHoverTimerRef.current !== null) {
        window.clearTimeout(endpointHoverTimerRef.current)
        endpointHoverTimerRef.current = null
      }
    }, [])

    const scheduleEndpointHoverClose = useCallback(() => {
      cancelEndpointHoverClose()
      endpointHoverTimerRef.current = window.setTimeout(() => {
        endpointHoverTimerRef.current = null
        setEndpointsOpen(false)
      }, HOVER_CLOSE_DELAY_MS)
    }, [cancelEndpointHoverClose])

    useEffect(() => cancelEndpointHoverClose, [cancelEndpointHoverClose])

    const handleEndpointMouseEnter = useCallback(() => {
      if (!canHover || preferTouchUi) return
      cancelEndpointHoverClose()
      setEndpointsOpen(true)
    }, [canHover, cancelEndpointHoverClose, preferTouchUi])

    const handleEndpointMouseLeave = useCallback(() => {
      if (!canHover || preferTouchUi) return
      scheduleEndpointHoverClose()
    }, [canHover, preferTouchUi, scheduleEndpointHoverClose])

    useImperativeHandle(ref, () => ({ openMenu: () => openMenu() }), [openMenu])

    const focusItemAtIndex = useCallback(
      (index: number) => {
        if (visibleModels.length === 0) return
        const clamped = Math.max(0, Math.min(index, visibleModels.length - 1))
        setHighlightedIndex(clamped)
        const target = document.getElementById(`${idPrefix}-${clamped}`) as HTMLElement | null
        target?.focus()
        target?.scrollIntoView({ block: 'nearest' })
      },
      [idPrefix, visibleModels.length],
    )

    // ---- Select ----

    const handleSelect = useCallback(
      (model: ModelInfo) => {
        const key = getModelKey(model)
        recordModelUsage(model)
        onSelect(key, model)
        closeMenu({ focusTrigger: trigger !== 'toolbar' })
        // 触摸端选完模型不抢焦点:聚焦输入框会直接唤起软键盘。
        if (trigger === 'toolbar' && !preferTouchUi) {
          window.setTimeout(() => {
            focusToolbarInput()
          }, 0)
        }
      },
      [closeMenu, focusToolbarInput, onSelect, preferTouchUi, trigger],
    )

    /**
     * 滑动条拖动时实时切换思维强度。
     *
     * 与「点选项」不同,这里不关闭菜单:拖动过程中每一帧都会回调,
     * 关掉菜单就没法连续调档;关闭交给点击外部 / Escape。
     */
    const handleVariantSliderChange = useCallback(
      (variant: string | undefined) => {
        onVariantChange?.(variant)
      },
      [onVariantChange],
    )

    const handleSelectEndpoint = useCallback((providerId: string) => {
      setBrowseProviderId(providerId)
      setEndpointsOpen(false)
      setHighlightedIndex(0)
    }, [])

    // ---- Keyboard navigation ----

    const handleItemKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        e.stopPropagation()

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            focusItemAtIndex(index >= visibleModels.length - 1 ? 0 : index + 1)
            break
          case 'ArrowUp':
            e.preventDefault()
            focusItemAtIndex(index <= 0 ? visibleModels.length - 1 : index - 1)
            break
          case 'Home':
            e.preventDefault()
            focusItemAtIndex(0)
            break
          case 'End':
            e.preventDefault()
            focusItemAtIndex(visibleModels.length - 1)
            break
          case 'Escape':
            e.preventDefault()
            closeMenu()
            break
          case 'Tab':
            e.preventDefault()
            closeMenu({ focusTrigger: false })
            window.setTimeout(() => {
              focusRelativeToTrigger(e.shiftKey ? -1 : 1)
            }, 0)
            break
          case 'Enter':
          case ' ':
            e.preventDefault()
            handleSelect(visibleModels[index])
            break
        }
      },
      [closeMenu, focusItemAtIndex, focusRelativeToTrigger, handleSelect, visibleModels],
    )

    // ---- Side effects ----

    useEffect(() => {
      onMenuOpenChange?.(isOpen)
    }, [isOpen, onMenuOpenChange])

    useEffect(() => {
      if (!isOpen) return
      // 触摸端不自动聚焦列表项:避免用户点开菜单就被焦点环和软键盘打断。
      if (preferTouchUi) return
      const timerId = window.setTimeout(() => {
        focusItemAtIndex(pendingFocusIndexRef.current)
      }, 50)
      return () => clearTimeout(timerId)
    }, [isOpen, preferTouchUi, focusItemAtIndex])

    useEffect(() => {
      if (!isOpen) return
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node
        if (containerRef.current && !containerRef.current.contains(target) && !menuRef.current?.contains(target)) {
          closeMenu()
        }
      }
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [closeMenu, isOpen])

    useEffect(() => {
      if (!isOpen) return
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        // 端点子菜单先收起,再按一次才关菜单。
        if (endpointsOpen) {
          setEndpointsOpen(false)
          return
        }
        closeMenu()
      }
      document.addEventListener('keydown', handleEsc, { capture: true })
      return () => document.removeEventListener('keydown', handleEsc, { capture: true })
    }, [closeMenu, endpointsOpen, isOpen])

    useEffect(() => {
      if (!isOpen) return
      requestAnimationFrame(() => {
        document.getElementById(`${idPrefix}-${highlightedIndex}`)?.scrollIntoView({ block: 'nearest' })
      })
    }, [highlightedIndex, idPrefix, isOpen])

    // ---- Trigger button ----

    const placeholderLabel = trigger === 'header' ? t('modelSelector.selectModel') : t('modelSelector.model')
    const displayName = selectedModel?.name || (isLoading ? t('common:loading') : placeholderLabel)
    const labelTone = selectedModel ? 'text-text-200' : 'text-text-400'
    const trailingIndicator = isLoading ? (
      <SpinnerIcon
        size={14}
        data-loading-indicator="true"
        className="pointer-events-none shrink-0 animate-spin text-text-400"
      />
    ) : (
      <span
        className={`pointer-events-none inline-flex shrink-0 text-text-400 transition-transform duration-200 ${
          isOpen ? 'rotate-180' : ''
        }`}
      >
        <ChevronDownIcon size={14} />
      </span>
    )

    const thoughtLabel = thoughtLevels[thoughtIndex]?.label ?? t('inputToolbar.default')

    const triggerDisabledClasses =
      'disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:active:bg-transparent'

    const triggerButton =
      trigger === 'header' ? (
        <button
          ref={triggerRef}
          onClick={() => (isOpen ? closeMenu() : openMenu())}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              openMenu()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              openMenu(visibleModels.length - 1)
            }
          }}
          disabled={disabled || isLoading}
          aria-expanded={isOpen}
          className={`group flex h-7 items-center gap-1 rounded-lg pl-2 pr-1.5 text-ui-base text-text-200 transition-colors duration-150 hover:bg-bg-200 active:bg-bg-300 cursor-pointer ${triggerDisabledClasses}`}
        >
          <PackageIcon size={16} className="shrink-0 text-text-400" />
          <span className={`min-w-0 max-w-[240px] truncate font-medium ${labelTone}`}>{displayName}</span>
          {variants.length > 0 && <span className="shrink-0 truncate text-ui-base text-text-500">{thoughtLabel}</span>}
          {trailingIndicator}
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => (isOpen ? closeMenu() : openMenu())}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              openMenu()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              openMenu(visibleModels.length - 1)
            }
          }}
          disabled={disabled || isLoading}
          aria-expanded={isOpen}
          className={`flex h-7 items-center gap-1 rounded-lg pl-2 pr-1.5 text-ui-base transition-colors duration-150 hover:bg-bg-200 active:bg-bg-300 cursor-pointer min-w-0 overflow-hidden w-full ${triggerDisabledClasses}`}
        >
          <PackageIcon size={16} className="shrink-0 text-text-400" />
          <span className={`min-w-0 flex-1 truncate text-ui-base ${labelTone}`}>{displayName}</span>
          {variants.length > 0 && <span className="shrink-0 truncate text-ui-base text-text-500">{thoughtLabel}</span>}
          {trailingIndicator}
        </button>
      )

    // ---- Menu pieces ----

    const endpointLabel = t('modelSelector.endpoint')
    const modelsLabel = t('modelSelector.model')

    const endpointOptionButton = (group: { providerId: string; providerName: string; models: ModelInfo[] }) => {
      const isActive = group.providerId === activeProviderId
      return (
        <button
          key={group.providerId}
          type="button"
          role="option"
          aria-selected={isActive}
          onClick={() => handleSelectEndpoint(group.providerId)}
          className={`flex min-h-7 items-center gap-2 rounded-md px-2 text-left text-ui-base transition-colors duration-100 hover:bg-bg-200 ${
            isActive ? 'text-text-100' : 'text-text-200'
          }`}
        >
          <PackageIcon size={16} className="shrink-0 text-text-400" />
          <span className="min-w-0 flex-1 truncate">{group.providerName}</span>
          <span className="shrink-0 text-ui-xs tabular-nums text-text-500">{group.models.length}</span>
          {isActive && <CheckIcon size={16} className="shrink-0 text-text-400" />}
        </button>
      )
    }

    const endpointRow = (
      <div className="relative">
        <button
          type="button"
          data-focus-target="endpoint"
          aria-haspopup="listbox"
          aria-expanded={endpointsOpen}
          aria-label={endpointLabel}
          onClick={() => setEndpointsOpen(open => !open)}
          onMouseEnter={handleEndpointMouseEnter}
          onMouseLeave={handleEndpointMouseLeave}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-ui-base text-text-200 transition-colors duration-100 hover:bg-bg-200"
        >
          <PackageIcon size={16} className="shrink-0 text-text-400" />
          <span className="min-w-0 truncate text-text-100">{activeProviderGroup?.providerName ?? '—'}</span>
          <ChevronRightIcon
            size={14}
            className={`ml-auto shrink-0 text-text-400 transition-transform duration-150 ${
              endpointsOpen ? 'rotate-90' : ''
            }`}
          />
        </button>
      </div>
    )

    const modelList = (
      <div
        ref={listRef}
        id={listboxId}
        role="list"
        aria-label={modelsLabel}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto custom-scrollbar p-1"
      >
        {visibleModels.length === 0 ? (
          <div className="px-4 py-10 text-center" role="status" aria-live="polite">
            <div className="text-ui-base text-text-400">{t('modelSelector.noModelsFound')}</div>
          </div>
        ) : (
          visibleModels.map((model, index) => {
            const itemKey = getModelKey(model)
            const isSelected = selectedModelKey === itemKey
            const isHL = highlightedIndex === index
            return (
              <button
                key={itemKey}
                id={`${idPrefix}-${index}`}
                data-model-key={itemKey}
                data-focus-target="item"
                type="button"
                onClick={() => handleSelect(model)}
                onFocus={() => setHighlightedIndex(index)}
                onMouseMove={() => setHighlightedIndex(index)}
                onKeyDown={e => handleItemKeyDown(e, index)}
                className={`flex w-full min-h-7 items-center gap-2 rounded-md px-2 text-left text-ui-base transition-colors duration-100 hover:bg-bg-200 ${
                  isSelected || isHL ? 'text-text-100' : 'text-text-200'
                }`}
              >
                <span className="min-w-0 truncate">{model.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {model.supportsImages && (
                    <span
                      data-model-capability="vision"
                      className="rounded-full bg-text-100/10 px-1.5 text-ui-xs leading-normal text-text-400"
                    >
                      {t('modelSelector.vision')}
                    </span>
                  )}
                  {model.supportsReasoning && (
                    <span
                      data-model-capability="thinking"
                      className="rounded-full bg-text-100/10 px-1.5 text-ui-xs leading-normal text-text-400"
                    >
                      {t('modelSelector.thinking')}
                    </span>
                  )}
                </span>
                <span className="ml-auto flex w-4 shrink-0 items-center justify-center">
                  {isSelected && <CheckIcon size={16} className="text-text-400" />}
                </span>
              </button>
            )
          })
        )}
      </div>
    )

    const thoughtSection =
      variants.length > 0 ? (
        <div className="px-2 pb-1.5 pt-1.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-ui-sm text-text-500">{t('modelSelector.effort')}</span>
            <span className="min-w-0 truncate text-ui-base text-text-100">
              {thoughtLevels[thoughtIndex]?.label ?? '—'}
            </span>
          </div>
          <div className={`thought-slider relative h-6 w-full ${thoughtLevels.length < 2 ? 'opacity-50' : ''}`}>
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-text-100/10" />
              <div
                className="thought-slider-fill absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-linear-to-r from-accent-main-100 to-info-100"
                style={{
                  width: thoughtFilled ? `calc(7px + (100% - 14px) * ${thoughtProgress / 100})` : 0,
                }}
              />
              <div className="absolute inset-x-[7px] top-1/2 flex -translate-y-1/2 items-center justify-between">
                {thoughtLevels.map((level, index) => (
                  <span
                    key={level.value ?? '__default'}
                    className={`size-1 shrink-0 rounded-full transition-transform duration-150 ${
                      thoughtFilled && index <= thoughtIndex ? 'bg-oncolor-100/60' : 'bg-text-500'
                    }`}
                  />
                ))}
              </div>
              <div
                className="thought-slider-thumb absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full border border-border-200/50 bg-oncolor-100 shadow-md"
                style={{ left: `calc((100% - 14px) * ${thoughtProgress / 100})` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, thoughtLevels.length - 1)}
              step={1}
              value={thoughtIndex}
              disabled={thoughtLevels.length < 2}
              aria-label={t('modelSelector.effort')}
              aria-valuetext={thoughtLevels[thoughtIndex]?.label ?? ''}
              onChange={event => {
                handleVariantSliderChange(thoughtLevels[Number(event.target.value)]?.value)
              }}
              onPointerUp={event => {
                handleVariantSliderChange(thoughtLevels[Number(event.currentTarget.value)]?.value)
              }}
              className="thought-slider-range absolute inset-0 m-0 h-6 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-default"
            />
          </div>
        </div>
      ) : null

    // ---- Render ----

    return (
      <div
        ref={containerRef}
        className={`relative font-sans ${trigger === 'toolbar' ? 'min-w-0 overflow-hidden' : ''}`}
        data-dropdown-open={isOpen || undefined}
      >
        {triggerButton}

        <DropdownMenu
          triggerRef={triggerRef}
          isOpen={isOpen}
          position={position}
          align="left"
          width="320px"
          minWidth="260px"
          maxWidth="min(320px, calc(100vw - 24px))"
          mobileFullWidth
          constrainToRef={constrainToRef}
          clampToViewport
          className="!p-0 flex flex-col"
        >
          <div ref={menuRef} className="relative flex min-h-0 flex-1 flex-col">
            {preferTouchUi && endpointsOpen ? (
              // 触摸端不做向右浮层(会超出屏宽),退回列表内下钻。
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
                <button
                  type="button"
                  onClick={() => setEndpointsOpen(false)}
                  className="flex h-8 items-center gap-1.5 rounded-md px-2 text-ui-base text-text-200 hover:bg-bg-200"
                >
                  <ChevronLeftIcon size={14} className="text-text-400" />
                  <span>{t('common:back')}</span>
                </button>
                <div className="mx-2 my-1 h-px bg-border-200/60" />
                <div role="listbox" aria-label={endpointLabel} className="flex flex-col gap-0.5">
                  {allProviderGroups.map(endpointOptionButton)}
                </div>
              </div>
            ) : (
              <>
                <div className="p-1 pb-0">{endpointRow}</div>
                <div className="mx-2 my-1 h-px bg-border-200/60" />
                {modelList}
                {thoughtSection && (
                  <>
                    <div className="mx-2 h-px bg-border-200/60" />
                    {thoughtSection}
                  </>
                )}
              </>
            )}

            {/* 桌面:端点列表向右展开,顶部与模型菜单对齐,左侧留出空隙;
                圆角/边框/阴影/内边距与模型菜单一致,背景用实色避免透出背后内容。 */}
            {endpointsOpen && !preferTouchUi && (
              <div
                role="listbox"
                aria-label={endpointLabel}
                onMouseEnter={handleEndpointMouseEnter}
                onMouseLeave={handleEndpointMouseLeave}
                className="bg-bg-000 absolute -top-px left-full z-20 ml-2 flex w-52 flex-col gap-0.5 rounded-xl border border-border-200/60 p-1 shadow-lg"
              >
                {allProviderGroups.map(endpointOptionButton)}
              </div>
            )}
          </div>
        </DropdownMenu>
      </div>
    )
  }),
)
