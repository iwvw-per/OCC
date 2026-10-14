import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PathAutoIcon, PathUnixIcon, PathWindowsIcon } from '../../../components/Icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select'
import { usePathMode, useTheme, useModels } from '../../../hooks'
import { themeStore, type ReasoningDisplayMode, type CompletedAtFormat } from '../../../store/themeStore'
import { useLayoutStore, layoutStore } from '../../../store/layoutStore'
import { useHiddenModelKeys, aiRenameModelStore, useAiRenameModelKey } from '../../../store'
import { largeTextPasteStore, useLargeTextPasteSettings, type LargeTextPasteBehavior } from '../../../store/largeTextPasteStore'
import { getModelKey } from '../../../utils/modelUtils'
import { Toggle, SegmentedControl, SettingRow, SettingsSection, SettingsCardRow } from './SettingsUI'
import type { PathMode } from '../../../utils/directoryUtils'

const STEP_FINISH_FIELDS = [
  { key: 'latestOnly', label: 'chat.latestOnly', desc: 'chat.showLatestOnly' },
  { key: 'agent', label: 'chat.agent', desc: 'chat.showAgent' },
  { key: 'model', label: 'chat.model', desc: 'chat.showModel' },
  { key: 'tokens', label: 'chat.tokens', desc: 'chat.showTokenUsage' },
  { key: 'cache', label: 'chat.cache', desc: 'chat.showCacheHit' },
  { key: 'cost', label: 'chat.cost', desc: 'chat.showApiCost' },
  { key: 'duration', label: 'chat.duration', desc: 'chat.showResponseTime' },
  { key: 'turnDuration', label: 'chat.totalDuration', desc: 'chat.showTurnElapsed' },
  { key: 'completedAt', label: 'chat.completedAt', desc: 'chat.showCompletedAt' },
] as const

export function ChatSettings() {
  const { t } = useTranslation(['settings'])
  const { pathMode, setPathMode, effectiveStyle, detectedStyle, isAutoMode } = usePathMode()
  const {
    externalFileDropMode,
    setExternalFileDropMode,
    outlineCurrentHighlight,
    setOutlineCurrentHighlight,
    actionsOnLatestAssistantOnly,
    setActionsOnLatestAssistantOnly,
    desktopCollapsedInputDock,
    setDesktopCollapsedInputDock,
    showInputStatusBar,
    setShowInputStatusBar,
    renderUserMarkdown,
    setRenderUserMarkdown,
  } = useTheme()
  const { sendOnEnter } = useLayoutStore()
  const { behavior: largePasteBehavior } = useLargeTextPasteSettings()
  const { models, isLoading: modelsLoading } = useModels()
  const hiddenModelKeys = useHiddenModelKeys()
  const aiRenameModelKey = useAiRenameModelKey()
  const [collapseUserMessages, setCollapseUserMessages] = useState(themeStore.collapseUserMessages)
  const [stepFinishDisplay, setStepFinishDisplay] = useState(themeStore.stepFinishDisplay)
  const [completedAtFormat, setCompletedAtFormat] = useState(themeStore.completedAtFormat)
  const [reasoningDisplayMode, setReasoningDisplayMode] = useState(themeStore.reasoningDisplayMode)

  const externalDropAlwaysMention = externalFileDropMode === 'mention'

  const toggleCollapse = () => {
    const v = !collapseUserMessages
    setCollapseUserMessages(v)
    themeStore.setCollapseUserMessages(v)
  }

  const toggleStepField = (key: (typeof STEP_FINISH_FIELDS)[number]['key']) => {
    const next = { [key]: !stepFinishDisplay[key] }
    setStepFinishDisplay(prev => ({ ...prev, ...next }))
    themeStore.setStepFinishDisplay(next)
  }

  return (
    <div>
      <SettingsSection title={t('chat.pathsFormatting')} description={t('chat.pathsFormattingDesc')}>
        <SettingsCardRow>
          <div className="w-full max-w-[320px]">
            <SegmentedControl
              value={pathMode}
              options={[
                { value: 'auto', label: t('chat.auto'), icon: <PathAutoIcon size={14} /> },
                { value: 'unix', label: t('chat.unixSlash'), icon: <PathUnixIcon size={14} /> },
                { value: 'windows', label: t('chat.winBackslash'), icon: <PathWindowsIcon size={14} /> },
              ]}
              onChange={v => setPathMode(v as PathMode)}
            />
          </div>
          {isAutoMode && (
            <p data-setting-desc className="text-[length:var(--fs-xs)] text-text-400 mt-2">
              {t('chat.usingStyle', { style: effectiveStyle === 'windows' ? '\\' : '/' })}
              {detectedStyle &&
                ` · ${t('chat.detectedStyle', {
                  style: detectedStyle === 'windows' ? t('chat.windows') : t('chat.unix'),
                })}`}
            </p>
          )}
        </SettingsCardRow>

        <SettingRow
          label={t('chat.externalDropMentionMode')}
          description={t('chat.externalDropMentionModeDesc')}
          onClick={() => setExternalFileDropMode(externalDropAlwaysMention ? 'upload-first' : 'mention')}
        >
          <Toggle
            enabled={externalDropAlwaysMention}
            onChange={() => setExternalFileDropMode(externalDropAlwaysMention ? 'upload-first' : 'mention')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('chat.conversationExperience')} description={t('chat.conversationExperienceDesc')}>
        <SettingRow
          label={t('chat.collapseLongMessages')}
          description={t('chat.collapseLongMessagesDesc')}
          onClick={toggleCollapse}
        >
          <Toggle enabled={collapseUserMessages} onChange={toggleCollapse} />
        </SettingRow>

        <SettingRow
          label={t('chat.renderUserMarkdown')}
          description={t('chat.renderUserMarkdownDesc')}
          onClick={() => setRenderUserMarkdown(!renderUserMarkdown)}
        >
          <Toggle enabled={renderUserMarkdown} onChange={() => setRenderUserMarkdown(!renderUserMarkdown)} />
        </SettingRow>

        <SettingRow
          label={t('chat.outlineCurrentHighlight')}
          description={t('chat.outlineCurrentHighlightDesc')}
          onClick={() => setOutlineCurrentHighlight(!outlineCurrentHighlight)}
        >
          <Toggle
            enabled={outlineCurrentHighlight}
            onChange={() => setOutlineCurrentHighlight(!outlineCurrentHighlight)}
          />
        </SettingRow>

        <SettingRow
          label={t('chat.actionsOnLatestAssistantOnly')}
          description={t('chat.actionsOnLatestAssistantOnlyDesc')}
          onClick={() => setActionsOnLatestAssistantOnly(!actionsOnLatestAssistantOnly)}
        >
          <Toggle
            enabled={actionsOnLatestAssistantOnly}
            onChange={() => setActionsOnLatestAssistantOnly(!actionsOnLatestAssistantOnly)}
          />
        </SettingRow>

        <SettingRow
          label={t('chat.desktopCollapsedInputDock')}
          description={t('chat.desktopCollapsedInputDockDesc')}
          onClick={() => setDesktopCollapsedInputDock(!desktopCollapsedInputDock)}
        >
          <Toggle
            enabled={desktopCollapsedInputDock}
            onChange={() => setDesktopCollapsedInputDock(!desktopCollapsedInputDock)}
          />
        </SettingRow>

        <SettingRow
          label={t('chat.showInputStatusBar')}
          description={t('chat.showInputStatusBarDesc')}
          onClick={() => setShowInputStatusBar(!showInputStatusBar)}
        >
          <Toggle enabled={showInputStatusBar} onChange={() => setShowInputStatusBar(!showInputStatusBar)} />
        </SettingRow>

        <SettingRow label={t('chat.sendMode')} description={t('chat.sendModeDesc')}>
            <SegmentedControl
              value={sendOnEnter ? 'enter' : 'shiftEnter'}
              options={[
                { value: 'enter', label: t('chat.sendModeEnter') },
                { value: 'shiftEnter', label: t('chat.sendModeShiftEnter') },
              ]}
              onChange={v => layoutStore.setSendOnEnter(v === 'enter')}
            />
        </SettingRow>

        <SettingRow label={t('chat.largePaste')} description={t('chat.largePasteDesc')}>
            <SegmentedControl
              value={largePasteBehavior}
              options={[
                { value: 'ask', label: t('chat.largePasteAsk') },
                { value: 'attach', label: t('chat.largePasteAttach') },
                { value: 'inline', label: t('chat.largePasteInline') },
              ]}
              onChange={v => largeTextPasteStore.setBehavior(v as LargeTextPasteBehavior)}
            />
        </SettingRow>

        <SettingRow label={t('chat.thinkingDisplay')} description={t('chat.thinkingDisplayDesc')}>
            <SegmentedControl
              value={reasoningDisplayMode}
              options={[
                { value: 'capsule', label: t('chat.capsule') },
                { value: 'italic', label: t('chat.italic') },
                { value: 'markdown', label: t('chat.markdown') },
                { value: 'ticker', label: t('chat.ticker') },
                { value: 'block', label: t('chat.block') },
              ]}
              onChange={v => {
                setReasoningDisplayMode(v as ReasoningDisplayMode)
                themeStore.setReasoningDisplayMode(v as ReasoningDisplayMode)
              }}
            />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('chat.aiRenameModel')} description={t('chat.aiRenameModelDesc')}>
        <SettingRow label={t('chat.aiRenameModelPick')} description={t('chat.aiRenameModelPickDesc')}>
          <Select
            value={aiRenameModelKey ?? 'auto'}
            onValueChange={value => aiRenameModelStore.set(value === 'auto' ? null : value)}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t('chat.aiRenameAuto')} />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="auto">{t('chat.aiRenameAuto')}</SelectItem>
              {models
                .filter(model => !hiddenModelKeys.includes(getModelKey(model)))
                .map(model => (
                  <SelectItem key={getModelKey(model)} value={getModelKey(model)}>
                    {model.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {modelsLoading && (
          <SettingsCardRow>
            <p className="text-[length:var(--fs-xs)] text-text-400">{t('models.loading')}</p>
          </SettingsCardRow>
        )}
      </SettingsSection>

      <SettingsSection title={t('chat.stepFinishInfo')}>
        {STEP_FINISH_FIELDS.map(({ key, label, desc }) => (
          <SettingRow key={key} label={t(label)} description={t(desc)} onClick={() => toggleStepField(key)}>
            <Toggle enabled={stepFinishDisplay[key]} onChange={() => toggleStepField(key)} />
          </SettingRow>
        ))}

        {stepFinishDisplay.completedAt && (
          <SettingRow label={t('chat.completedAtFormat')} description={t('chat.completedAtFormatDesc')}>
            <SegmentedControl
              value={completedAtFormat}
              options={[
                { value: 'time', label: t('chat.completedAtTimeOnly') },
                { value: 'dateTime', label: t('chat.completedAtDateTime') },
              ]}
              onChange={v => {
                const next = v as CompletedAtFormat
                setCompletedAtFormat(next)
                themeStore.setCompletedAtFormat(next)
              }}
            />
          </SettingRow>
        )}
      </SettingsSection>
    </div>
  )
}
