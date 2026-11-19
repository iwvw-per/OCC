import { useTranslation } from 'react-i18next'
import { useTheme } from '../../../hooks'
import { layoutStore, useLayoutStore, type ChildSessionsDisplayMode } from '../../../store'
import { Toggle, SegmentedControl, SettingRow, SettingsSection } from './SettingsUI'

export function WorkspaceSettings() {
  const { t } = useTranslation(['settings'])
  const {
    chatContentWidth,
    resetChatContentWidth,
    diffStyle,
    setDiffStyle,
    codeWordWrap,
    setCodeWordWrap,
    manualTerminalTitles,
    setManualTerminalTitles,
  } = useTheme()
  const {
    sidebarFolderRecents,
    sidebarFolderRecentsShowDiff,
    sidebarChildSessions,
    terminalCopyOnSelect,
    terminalRightClickPaste,
    wakeLock,
  } = useLayoutStore()

  const toggleManualTerminalTitles = () => {
    const next = !manualTerminalTitles
    setManualTerminalTitles(next)
    layoutStore.syncTerminalTitleMode(next)
  }

  return (
    <div>
      <SettingsSection title={t('workspace.layout')} description={t('workspace.layoutDesc')}>
        <SettingRow
          label={t('appearance.resetChatWidth')}
          description={t('appearance.resetChatWidthDesc')}
          onClick={chatContentWidth === null ? undefined : resetChatContentWidth}
          disabled={chatContentWidth === null}
        >
          <span className="text-ui-caption tabular-nums text-text-300">
            {chatContentWidth === null ? t('appearance.chatWidthAuto') : `${Math.round(chatContentWidth)}px`}
          </span>
        </SettingRow>

        <SettingRow
          label={t('appearance.wakeLock')}
          description={t('appearance.wakeLockDesc')}
          onClick={() => layoutStore.setWakeLock(!wakeLock)}
        >
          <Toggle enabled={wakeLock} onChange={() => layoutStore.setWakeLock(!wakeLock)} />
        </SettingRow>

        <SettingRow
          label={t('appearance.codeWordWrap')}
          description={t('appearance.codeWordWrapDesc')}
          onClick={() => setCodeWordWrap(!codeWordWrap)}
        >
          <Toggle enabled={codeWordWrap} onChange={() => setCodeWordWrap(!codeWordWrap)} />
        </SettingRow>

        <SettingRow
          label={t('workspace.manualTerminalTitles')}
          description={t('workspace.manualTerminalTitlesDesc')}
          onClick={toggleManualTerminalTitles}
        >
          <Toggle enabled={manualTerminalTitles} onChange={toggleManualTerminalTitles} />
        </SettingRow>

        <SettingRow label={t('appearance.diffStyle')} description={t('appearance.diffStyleDesc')}>
          <SegmentedControl
            value={diffStyle}
            options={[
              { value: 'markers', label: t('appearance.diffStyleMarkers') },
              { value: 'changeBars', label: t('appearance.diffStyleChangeBars') },
            ]}
            onChange={v => setDiffStyle(v as 'markers' | 'changeBars')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('workspace.terminal')} description={t('workspace.terminalDesc')}>
        <SettingRow
          label={t('workspace.terminalCopyOnSelect')}
          description={t('workspace.terminalCopyOnSelectDesc')}
          onClick={() => layoutStore.setTerminalCopyOnSelect(!terminalCopyOnSelect)}
        >
          <Toggle
            enabled={terminalCopyOnSelect}
            onChange={() => layoutStore.setTerminalCopyOnSelect(!terminalCopyOnSelect)}
          />
        </SettingRow>

        <SettingRow
          label={t('workspace.terminalRightClickPaste')}
          description={t('workspace.terminalRightClickPasteDesc')}
          onClick={() => layoutStore.setTerminalRightClickPaste(!terminalRightClickPaste)}
        >
          <Toggle
            enabled={terminalRightClickPaste}
            onChange={() => layoutStore.setTerminalRightClickPaste(!terminalRightClickPaste)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('workspace.sidebar')} description={t('workspace.sidebarDesc')}>
        <SettingRow
          label={t('appearance.folderStyleRecents')}
          description={t('appearance.folderStyleRecentsDesc')}
          onClick={() => layoutStore.setSidebarFolderRecents(!sidebarFolderRecents)}
        >
          <Toggle
            enabled={sidebarFolderRecents}
            onChange={() => layoutStore.setSidebarFolderRecents(!sidebarFolderRecents)}
          />
        </SettingRow>

        <SettingRow
          label={t('appearance.folderStyleRecentsShowDiff')}
          description={t('appearance.folderStyleRecentsShowDiffDesc')}
          onClick={() => layoutStore.setSidebarFolderRecentsShowDiff(!sidebarFolderRecentsShowDiff)}
        >
          <Toggle
            enabled={sidebarFolderRecentsShowDiff}
            onChange={() => layoutStore.setSidebarFolderRecentsShowDiff(!sidebarFolderRecentsShowDiff)}
          />
        </SettingRow>

        <SettingRow
          label={t('appearance.showChildSessions')}
          description={t('appearance.showChildSessionsDesc')}
        >
          <SegmentedControl
            value={sidebarChildSessions}
            options={[
              { value: 'off', label: t('appearance.showChildSessionsOff') },
              { value: 'active', label: t('appearance.showChildSessionsActive') },
              { value: 'all', label: t('appearance.showChildSessionsAll') },
            ]}
            onChange={mode => layoutStore.setSidebarChildSessions(mode as ChildSessionsDisplayMode)}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
