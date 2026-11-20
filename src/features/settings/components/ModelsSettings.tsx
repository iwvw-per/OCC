import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CloseIcon, EyeIcon, EyeOffIcon, SearchIcon } from '../../../components/Icons'
import { useModels } from '../../../hooks'
import { NativeTooltip } from '../../../components/ui/Tooltip'
import { modelVisibilityStore, useHiddenModelKeys, useHiddenProviderNames } from '../../../store'
import { groupModelsByProvider, getModelKey } from '../../../utils/modelUtils'
import type { ModelInfo } from '../../../types/ui'
import { SettingsSection, Toggle } from './SettingsUI'

function formatContext(limit: number): string {
  if (!limit) return ''
  const k = Math.round(limit / 1000)
  if (k >= 1000) return `${(k / 1000).toFixed(0)}M`
  return `${k}k`
}

function isModClick(e: React.MouseEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

function ModelVisibilityButton({
  enabled,
  disabled,
  ariaLabel,
  onChange,
  revealOnHover = false,
}: {
  enabled: boolean
  disabled?: boolean
  ariaLabel: string
  onChange: () => void
  revealOnHover?: boolean
}) {
  return (
    <NativeTooltip>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={ariaLabel}
        title={ariaLabel}
        disabled={disabled}
        onClick={e => {
          e.stopPropagation()
          if (!disabled) onChange()
        }}
        className={`h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md transition-all
        hover:bg-bg-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 focus-visible:outline-offset-1
        ${
          enabled
            ? `text-text-300 opacity-60 hover:opacity-100 ${
                revealOnHover ? 'sm:opacity-0 sm:group-hover:opacity-60 sm:focus-visible:opacity-100' : ''
              }`
            : 'text-text-500 opacity-70 hover:opacity-100'
        }
        ${disabled ? '!opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {enabled ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
      </button>
    </NativeTooltip>
  )
}

export function ModelsSettings() {
  const { t } = useTranslation('settings')
  const { models, isLoading } = useModels()
  const hiddenModelKeys = useHiddenModelKeys()
  const hiddenProviderNames = useHiddenProviderNames()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  // 范围选择锚点:上一次单击的模型 key
  const anchorKeyRef = useRef<string | null>(null)
  const hiddenModelKeySet = useMemo(() => new Set(hiddenModelKeys), [hiddenModelKeys])
  const hiddenProviderSet = useMemo(() => new Set(hiddenProviderNames), [hiddenProviderNames])

  // 当前真正可选(端点开着 + 模型开着)的模型数,用于「至少保留一个」的保护
  const visibleCount = useMemo(
    () =>
      models.reduce((count, model) => {
        if (hiddenProviderSet.has(model.providerName)) return count
        return hiddenModelKeySet.has(getModelKey(model)) ? count : count + 1
      }, 0),
    [models, hiddenModelKeySet, hiddenProviderSet],
  )

  const filteredModels = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()
    if (!normalizedQuery) return models

    const normalize = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '')
    return models.filter(
      model =>
        normalize(model.name).includes(normalizedQuery) ||
        normalize(model.id).includes(normalizedQuery) ||
        normalize(model.family).includes(normalizedQuery) ||
        normalize(model.providerName).includes(normalizedQuery),
    )
  }, [models, deferredQuery])

  const groups = useMemo(() => groupModelsByProvider(filteredModels), [filteredModels])

  // 左列选中的端点;搜索把当前端点过滤掉时回退到第一个匹配项
  const activeGroup = useMemo(() => {
    if (groups.length === 0) return null
    return groups.find(group => group.providerName === activeProvider) ?? groups[0]
  }, [groups, activeProvider])

  // 两侧共用:端点计数与整端点开关都按「该端点的全部模型」算,不受搜索影响
  const providerStats = useMemo(() => {
    const map = new Map<string, { models: ModelInfo[]; visibleCount: number }>()
    for (const model of models) {
      const cached = map.get(model.providerName)
      if (cached) {
        cached.models.push(model)
        if (!hiddenModelKeySet.has(getModelKey(model))) cached.visibleCount += 1
      } else {
        map.set(model.providerName, {
          models: [model],
          visibleCount: hiddenModelKeySet.has(getModelKey(model)) ? 0 : 1,
        })
      }
    }
    return map
  }, [models, hiddenModelKeySet])

  // 右列当前的扁平顺序(Shift 范围选择只在本端点内生效)
  const flatVisibleModels = useMemo(() => activeGroup?.models ?? [], [activeGroup])

  const flatKeyIndex = useMemo(() => {
    const map = new Map<string, number>()
    flatVisibleModels.forEach((model, index) => {
      map.set(getModelKey(model), index)
    })
    return map
  }, [flatVisibleModels])

  /**
   * 切换模型可见性。
   * - 普通点击:切换当前项,并设为锚点
   * - Shift+点击:从锚点到当前项整段统一设为「当前项即将变成的状态」
   * - Ctrl/Cmd+点击:只切换当前项(不打断锚点,方便接着 Shift 扩选)
   */
  const handleModelActivate = useCallback(
    (model: ModelInfo, e: React.MouseEvent | React.KeyboardEvent) => {
      const key = getModelKey(model)
      const currentlyEnabled = !hiddenModelKeySet.has(key)
      const nextVisible = !currentlyEnabled

      // 至少保留一个可见
      if (currentlyEnabled && visibleCount <= 1 && !e.shiftKey) return

      const isShift = e.shiftKey && !isModClick(e)
      const isMod = isModClick(e)

      if (isShift && anchorKeyRef.current) {
        const from = flatKeyIndex.get(anchorKeyRef.current)
        const to = flatKeyIndex.get(key)
        if (from !== undefined && to !== undefined) {
          const start = Math.min(from, to)
          const end = Math.max(from, to)
          const range = flatVisibleModels.slice(start, end + 1)

          // 批量关掉时:不能把全部模型都关掉
          if (!nextVisible) {
            const rangeKeys = new Set(range.map(getModelKey))
            const remainingVisible = models.reduce((count, m) => {
              const k = getModelKey(m)
              if (rangeKeys.has(k)) return count // 范围里的都会被关
              return hiddenModelKeySet.has(k) ? count : count + 1
            }, 0)
            if (remainingVisible <= 0) {
              // 保底:只关范围里除第一个可见外的
              const keepOne = range.find(m => !hiddenModelKeySet.has(getModelKey(m)))
              const toHide = keepOne ? range.filter(m => getModelKey(m) !== getModelKey(keepOne)) : []
              if (toHide.length > 0) modelVisibilityStore.setManyVisible(toHide, false)
              return
            }
          }

          modelVisibilityStore.setManyVisible(range, nextVisible)
          return
        }
      }

      // 普通 / Ctrl·Cmd:单点切换
      if (currentlyEnabled && visibleCount <= 1) return
      modelVisibilityStore.setVisible(model, nextVisible)

      // Ctrl/Cmd 保持锚点;普通点击更新锚点
      if (!isMod) {
        anchorKeyRef.current = key
      } else if (!anchorKeyRef.current) {
        anchorKeyRef.current = key
      }
    },
    [flatKeyIndex, flatVisibleModels, hiddenModelKeySet, models, visibleCount],
  )

  return (
    <SettingsSection
      plain
      className="flex flex-col sm:h-full sm:min-h-0"
      contentClassName="sm:min-h-0 sm:flex-1"
      title={t('models.visibility')}
      description={t('models.visibilityDesc')}
    >
      <div className="relative group">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          aria-label={t('models.searchPlaceholder')}
          spellCheck={false}
          autoCorrect="off"
          autoComplete="off"
          autoCapitalize="off"
          className="w-full h-9 bg-bg-200/70 hover:bg-bg-200 border border-border-200/50 rounded-lg pl-9 pr-9 text-ui-caption text-text-100 placeholder:text-text-400/70 focus:outline-none transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-100/80 transition-colors"
            aria-label={t('models.clearSearch')}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-ui-caption text-text-400">{t('models.loading')}</div>
      ) : groups.length === 0 ? (
        <div className="py-10 text-center text-ui-caption text-text-400">
          {query ? t('models.noResults') : t('models.empty')}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:min-h-0 sm:flex-1 sm:flex-row sm:gap-4">
          {/* 左列:端点名 + 已启用计数 + 端点开关(独立滚动) */}
          <div className="flex gap-1 overflow-x-auto max-sm:scrollbar-none sm:h-full sm:w-56 sm:shrink-0 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:pr-0.5">
            {groups.map(group => {
              const stats = providerStats.get(group.providerName)
              const providerModels = stats?.models ?? group.models
              const providerVisibleCount = stats?.visibleCount ?? providerModels.length
              const providerEnabled = !hiddenProviderSet.has(group.providerName)
              // 关掉这个端点会让一个可选模型都不剩时禁止关闭
              const providerActionDisabled =
                providerEnabled && providerVisibleCount > 0 && visibleCount - providerVisibleCount <= 0
              const isActive = activeGroup?.providerName === group.providerName
              const providerToggleLabel = `${group.providerName} · ${t(
                providerEnabled ? 'models.disableEndpoint' : 'models.enableEndpoint',
              )}`

              return (
                <div
                  key={group.providerName}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors sm:shrink ${
                    isActive ? 'bg-bg-200' : 'hover:bg-bg-200/60'
                  }`}
                >
                  <button
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => setActiveProvider(group.providerName)}
                    className="min-w-0 flex-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-main-100 rounded-md"
                  >
                    <div
                      className={`truncate text-ui-sm font-medium ${
                        isActive ? 'text-text-100' : 'text-text-300'
                      } ${providerEnabled ? '' : 'opacity-50'}`}
                    >
                      {group.providerName}
                    </div>
                    <div className={`text-ui-xs tabular-nums text-text-400 ${providerEnabled ? '' : 'opacity-50'}`}>
                      {providerVisibleCount}/{providerModels.length}
                    </div>
                  </button>
                  <Toggle
                    enabled={providerEnabled}
                    disabled={providerActionDisabled}
                    ariaLabel={providerToggleLabel}
                    onChange={() => {
                      modelVisibilityStore.setProviderVisible(group.providerName, !providerEnabled)
                    }}
                  />
                </div>
              )
            })}
          </div>

          {/* 右列:当前端点的模型(独立滚动);端点关闭时整列变淡,但仍可逐个调整模型 */}
          <div className="min-w-0 flex-1 sm:h-full sm:overflow-y-auto sm:border-l sm:border-border-200/40 sm:pl-4 sm:pr-0.5">
            {activeGroup ? (
              <div
                className={`flex flex-col gap-0.5 transition-opacity ${
                  hiddenProviderSet.has(activeGroup.providerName) ? 'opacity-50' : ''
                }`}
              >
                {activeGroup.models.map(model => {
                  const key = getModelKey(model)
                  const enabled = !hiddenModelKeySet.has(key)
                  const context = formatContext(model.contextLimit)
                  // 端点关闭时不参与「至少保留一个」的保护,仍可自由调整单个模型
                  const disabled = enabled && !hiddenProviderSet.has(activeGroup.providerName) && visibleCount <= 1

                  return (
                    <div
                      key={key}
                      onClick={e => {
                        if (disabled && !e.shiftKey && !isModClick(e)) return
                        handleModelActivate(model, e)
                      }}
                      data-haptic={disabled ? undefined : 'light'}
                      className={`group w-full flex items-start justify-between gap-3 px-2.5 py-2 rounded-lg transition-colors select-none
                        ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-bg-200 active:bg-bg-300'}`}
                    >
                      <NativeTooltip>
                        <button
                          type="button"
                          aria-pressed={enabled}
                          title={`${model.name}\n${model.id}`}
                          onClick={e => {
                            e.stopPropagation()
                            if (disabled && !e.shiftKey && !isModClick(e)) return
                            handleModelActivate(model, e)
                          }}
                          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-main-100 rounded-md"
                        >
                          <div className="h-7 flex items-center min-w-0">
                            <div
                              className={`min-w-0 truncate text-ui-base leading-snug ${
                                enabled ? 'font-semibold text-text-100' : 'font-normal text-text-400'
                              }`}
                            >
                              {model.name}
                            </div>
                          </div>
                          <div
                            className={`truncate -mt-0.5 text-ui-sm font-mono leading-relaxed ${
                              enabled ? 'text-text-400' : 'text-text-500'
                            }`}
                          >
                            {model.id}
                            {context && <span className="sm:hidden"> · {context}</span>}
                          </div>
                        </button>
                      </NativeTooltip>
                      {context && (
                        <span className="hidden sm:flex h-7 items-center shrink-0 text-ui-sm text-text-500 tabular-nums">
                          {context}
                        </span>
                      )}
                      <ModelVisibilityButton
                        enabled={enabled}
                        disabled={disabled}
                        revealOnHover
                        ariaLabel={t(enabled ? 'models.hideModel' : 'models.showModel', { name: model.name })}
                        onChange={() => {
                          if (disabled) return
                          modelVisibilityStore.setVisible(model, !enabled)
                          anchorKeyRef.current = key
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
