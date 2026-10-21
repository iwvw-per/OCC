import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { autoApproveStore } from '../../../store'
import type { AlwaysAllowMode, QuestionAutoSelectTimeout } from '../../../store/autoApproveStore'
import { themeStore, type ToolCardStyle } from '../../../store/themeStore'
import { ExpandableSection } from '../../../components/ui'
import { ChevronDownIcon } from '../../../components/Icons'
import { cn } from '../../../utils/cn'
import { Toggle, SegmentedControl, SettingRow, SettingsSection } from './SettingsUI'

export function AgentSettings() {
  const { t } = useTranslation(['settings'])
  const [alwaysAllowMode, setAlwaysAllowMode] = useState<AlwaysAllowMode>(autoApproveStore.alwaysAllowMode)
  const [approvePendingOnFullAuto, setApprovePendingOnFullAuto] = useState(autoApproveStore.approvePendingOnFullAuto)
  const [questionAutoSelectTimeout, setQuestionAutoSelectTimeoutState] = useState<QuestionAutoSelectTimeout>(
    autoApproveStore.questionAutoSelectTimeout,
  )
  const [descriptiveToolSteps, setDescriptiveToolSteps] = useState(themeStore.descriptiveToolSteps)
  const [inlineToolRequests, setInlineToolRequests] = useState(themeStore.inlineToolRequests)
  const [toolCardStyle, setToolCardStyle] = useState(themeStore.toolCardStyle)
  const [compactInlinePermission, setCompactInlinePermission] = useState(themeStore.compactInlinePermission)
  const [processCollapseEnabled, setProcessCollapseEnabled] = useState(themeStore.processCollapseEnabled)
  // 沉浸模式的子项默认收起：它们由预设级联设置，不是独立开关
  const [immersiveAdvancedOpen, setImmersiveAdvancedOpen] = useState(false)

  const handleAlwaysAllowModeChange = (mode: AlwaysAllowMode) => {
    const hasFrontendRules = autoApproveStore.getDebugInfo().sessions.some(session => session.rules.length > 0)
    if (mode === 'backend' && hasFrontendRules && !window.confirm(t('agent.clearFrontendRulesConfirm'))) return false
    setAlwaysAllowMode(mode)
    autoApproveStore.setAlwaysAllowMode(mode)
    if (mode === 'backend') autoApproveStore.clearAllRules()
    return true
  }

  /**
   * 沉浸模式是「预设 + 4 个继承项」的结构，不是独立开关。
   *
   * store 里的 immersiveMode 只由总开关写入，四个子 setter 不会反向更新它，
   * 所以子项被单独改动后它就会失真。这里按等价条件推导出「显示值」：
   * 四项都符合「开启」才算开，任一项偏离即视为关。
   *
   * 注意：只推导显示值，不回写 store。回写会触发 setImmersiveMode 的级联
   * 改写，把用户刚打开的其它子项一起关掉。
   */
  const immersiveActive =
    inlineToolRequests &&
    descriptiveToolSteps &&
    compactInlinePermission &&
    toolCardStyle === 'compact'

  /**
   * 沉浸模式是一个「预设」，themeStore.setImmersiveMode 内部会一并改写
   * inlineToolRequests / descriptiveToolSteps / toolCardStyle /
   * compactInlinePermission 四个值并落盘。
   *
   * 这里只同步本地镜像状态，不再重复调用那四个 setter：
   *   - themeStore.setImmersiveMode 有短路（值相同即 return），
   *     重复调用四个子 setter 不会落盘，只会让本地 state 与 store 脱节；
   *   - 用户在别处单独关掉某个子项后，再点总开关会因短路而什么都不做，
   *     但本地 state 已被改掉 —— 界面与真实状态就会不一致。
   */
  const handleImmersiveModeToggle = () => {
    const next = !immersiveActive
    themeStore.setImmersiveMode(next)
    // 子项跟随预设；读回 store 的最新值，保证镜像与落盘结果一致
    setInlineToolRequests(themeStore.inlineToolRequests)
    setDescriptiveToolSteps(themeStore.descriptiveToolSteps)
    setToolCardStyle(themeStore.toolCardStyle)
    setCompactInlinePermission(themeStore.compactInlinePermission)
  }

  const toggleApprovePending = () => {
    const next = !approvePendingOnFullAuto
    setApprovePendingOnFullAuto(next)
    autoApproveStore.setApprovePendingOnFullAuto(next)
  }

  const handleQuestionAutoSelectTimeoutChange = (value: string) => {
    const seconds = Number(value) as QuestionAutoSelectTimeout
    setQuestionAutoSelectTimeoutState(seconds)
    autoApproveStore.setQuestionAutoSelectTimeout(seconds)
  }

  const toggleInlineToolRequests = () => {
    const next = !inlineToolRequests
    setInlineToolRequests(next)
    themeStore.setInlineToolRequests(next)
    // 子项被单独改动后，总开关的显示必须跟着变，
    // 否则「沉浸模式=开」但子项=关，界面自相矛盾。
  }

  const toggleDescriptiveToolSteps = () => {
    const next = !descriptiveToolSteps
    setDescriptiveToolSteps(next)
    themeStore.setDescriptiveToolSteps(next)
  }

  const toggleProcessCollapse = () => {
    const next = !processCollapseEnabled
    setProcessCollapseEnabled(next)
    themeStore.setProcessCollapseEnabled(next)
  }

  const toggleCompactInlinePermission = () => {
    const next = !compactInlinePermission
    setCompactInlinePermission(next)
    themeStore.setCompactInlinePermission(next)
  }

  const handleToolCardStyleChange = (style: ToolCardStyle) => {
    setToolCardStyle(style)
    themeStore.setToolCardStyle(style)
  }

  return (
    <div>
      <SettingsSection title={t('agent.behavior')} description={t('agent.behaviorDesc')}>
        <SettingRow label={t('chat.alwaysAllowMode')} description={t('chat.alwaysAllowModeDesc')}>
            <SegmentedControl
              value={alwaysAllowMode}
              options={[
                { value: 'backend', label: t('chat.alwaysAllowBackend') },
                { value: 'frontend', label: t('chat.alwaysAllowFrontend') },
              ]}
              onChange={v => handleAlwaysAllowModeChange(v as AlwaysAllowMode)}
            />
        </SettingRow>

        <SettingRow
          label={t('chat.approvePendingOnFullAuto')}
          description={t('chat.approvePendingOnFullAutoDesc')}
          onClick={toggleApprovePending}
        >
          <Toggle enabled={approvePendingOnFullAuto} onChange={toggleApprovePending} />
        </SettingRow>

        <SettingRow
          label={t('chat.questionAutoSelect')}
          description={t('chat.questionAutoSelectDesc')}
        >
          <SegmentedControl
            value={String(questionAutoSelectTimeout)}
            options={[
              { value: '0', label: t('chat.questionAutoSelectOff') },
              { value: '60', label: t('chat.questionAutoSelect1m') },
              { value: '120', label: t('chat.questionAutoSelect2m') },
            ]}
            onChange={handleQuestionAutoSelectTimeoutChange}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('agent.toolInteraction')} description={t('agent.toolInteractionDesc')}>
        {/* 沉浸模式是「预设」，下面四项是它级联设置的结果。
            默认收起，避免看起来像 5 个互相独立的开关。 */}
        <SettingRow
          label={t('chat.immersiveMode')}
          description={t('chat.immersiveModeDesc')}
          onClick={handleImmersiveModeToggle}
        >
          <Toggle enabled={immersiveActive} onChange={handleImmersiveModeToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.immersiveAdvanced')}
          description={t('chat.immersiveAdvancedDesc')}
          onClick={() => setImmersiveAdvancedOpen(v => !v)}
        >
          <ChevronDownIcon
            size={14}
            className={cn('text-text-400 transition-transform duration-150', immersiveAdvancedOpen ? '' : '-rotate-90')}
          />
        </SettingRow>

        <ExpandableSection show={immersiveAdvancedOpen}>
          {/* 子项缩进 + 左侧竖线，表达从属关系 */}
          <div className="ml-4 flex flex-col border-l border-border-200/50 pl-3">
            <SettingRow
              label={t('chat.inlineToolRequests')}
              description={t('chat.inlineToolRequestsDesc')}
              onClick={toggleInlineToolRequests}
            >
              <Toggle enabled={inlineToolRequests} onChange={toggleInlineToolRequests} />
            </SettingRow>

            <SettingRow
              label={t('chat.descriptiveToolSteps')}
              description={t('chat.descriptiveToolStepsDesc')}
              onClick={toggleDescriptiveToolSteps}
            >
              <Toggle enabled={descriptiveToolSteps} onChange={toggleDescriptiveToolSteps} />
            </SettingRow>

            <SettingRow
              label={t('chat.compactInlinePermission')}
              description={t('chat.compactInlinePermissionDesc')}
              onClick={toggleCompactInlinePermission}
            >
              <Toggle enabled={compactInlinePermission} onChange={toggleCompactInlinePermission} />
            </SettingRow>

            <SettingRow label={t('chat.toolCardStyle')} description={t('chat.toolCardStyleDesc')}>
              <SegmentedControl
                value={toolCardStyle}
                options={[
                  { value: 'classic', label: t('chat.toolCardClassic') },
                  { value: 'compact', label: t('chat.toolCardCompact') },
                ]}
                onChange={v => handleToolCardStyleChange(v as ToolCardStyle)}
              />
            </SettingRow>
          </div>
        </ExpandableSection>

        {/* 过程折叠不属于沉浸模式预设，独立成项 */}
        <SettingRow
          label={t('chat.processCollapse')}
          description={t('chat.processCollapseDesc')}
          onClick={toggleProcessCollapse}
        >
          <Toggle enabled={processCollapseEnabled} onChange={toggleProcessCollapse} />
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
