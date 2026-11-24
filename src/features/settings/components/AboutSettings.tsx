import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { DownloadIcon, ExternalLinkIcon, RetryIcon, UploadIcon } from '../../../components/Icons'
import {
  hasUpdateAvailable,
  updateStore,
  useUpdateStore,
  getReleaseManifestUrl,
  RELEASES_PAGE_URL,
} from '../../../store/updateStore'
import {
  autoUpdateSettingsStore,
  AUTO_UPDATE_INTERVAL_OPTIONS,
  type AutoUpdateIntervalMinutes,
} from '../../../store/autoUpdateSettings'
import { desktopUpdater, isDesktopUpdaterAvailable, type UpdaterProgress } from '../../../utils/desktopUpdater'
import {
  androidUpdater,
  isAndroidUpdaterAvailable,
  watchAndroidUpdateResume,
  type AndroidUpdateProgress,
} from '../../../utils/androidUpdater'
import { saveData } from '../../../utils/downloadUtils'
import { exportSettingsBackup, importSettingsBackup, previewBackupMeta } from '../../../utils/settingsBackup'
import { isTauri } from '../../../utils/tauri'
import {
  BUILTIN_UPDATE_PROXIES,
  updateProxySettingsStore,
  type UpdateProxyId,
  type UpdateProxySettings,
} from '../../../store/updateProxySettings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select'
import { SettingRow, SettingsSection, SegmentedControl, Toggle } from './SettingsUI'

function useUpdateProxySettings(): UpdateProxySettings {
  return useSyncExternalStore(updateProxySettingsStore.subscribe, updateProxySettingsStore.get, updateProxySettingsStore.get)
}

function useUpdaterProgress(): UpdaterProgress {
  return useSyncExternalStore(desktopUpdater.subscribe, desktopUpdater.getSnapshot, desktopUpdater.getSnapshot)
}

function useAndroidUpdaterProgress(): AndroidUpdateProgress {
  return useSyncExternalStore(androidUpdater.subscribe, androidUpdater.getSnapshot, androidUpdater.getSnapshot)
}

async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await import('@tauri-apps/plugin-opener')
      .then(mod => mod.openUrl(url))
      .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export function AboutSettings() {
  const { t } = useTranslation(['settings'])
  const updateState = useUpdateStore()
  const updaterProgress = useUpdaterProgress()
  const androidProgress = useAndroidUpdaterProgress()
  const hasUpdate = hasUpdateAvailable(updateState)
  const latestRelease = updateState.latestRelease
  const latestVersion = latestRelease?.tagName || t('about.unknownVersion')
  const releaseDate = latestRelease?.publishedAt ? new Date(latestRelease.publishedAt).toLocaleString() : null
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [autoUpdate, setAutoUpdate] = useState(autoUpdateSettingsStore.get())
  const proxySettings = useUpdateProxySettings()

  const canAutoUpdate = isDesktopUpdaterAvailable()
  const canAndroidUpdate = isAndroidUpdaterAvailable()
  const updaterBusy =
    updaterProgress.phase === 'checking' ||
    updaterProgress.phase === 'downloading' ||
    updaterProgress.phase === 'installing'
  const androidBusy =
    androidProgress.phase === 'downloading' ||
    androidProgress.phase === 'awaitingPermission' ||
    androidProgress.phase === 'installing'

  // store 是单一事实来源，本地 state 只做渲染镜像，避免直接读快照导致不重渲
  useEffect(
    () =>
      autoUpdateSettingsStore.subscribe(() => {
        setAutoUpdate(autoUpdateSettingsStore.get())
      }),
    [],
  )

  const handleToggleAutoUpdate = useCallback(() => {
    autoUpdateSettingsStore.commit(prev => ({ ...prev, enabled: !prev.enabled }))
  }, [])

  const handleAutoUpdateInterval = useCallback((value: string) => {
    const minutes = Number(value)
    if (!(AUTO_UPDATE_INTERVAL_OPTIONS as readonly number[]).includes(minutes)) return
    autoUpdateSettingsStore.commit(prev => ({ ...prev, intervalMinutes: minutes as AutoUpdateIntervalMinutes }))
  }, [])

  const handleProxyChange = useCallback(async (value: string) => {
    const proxy = value as UpdateProxyId
    const needsPrefix = proxy === 'custom' && !updateProxySettingsStore.get().customPrefix
    updateProxySettingsStore.commit(prev => ({ ...prev, proxy }))
    // 换了线路立刻重查一次，用户能马上看到是否通（否则要等 12h 或手动点）
    if (!needsPrefix) void updateStore.checkForUpdates({ force: true })
  }, [])

  const handleCustomPrefixCommit = useCallback((value: string) => {
    let prefix = value.trim()
    if (!prefix) return
    // 允许用户粘贴不带协议的域名（ghproxy.example.com/），补 https:// 更省事
    if (!/^https?:\/\//i.test(prefix)) prefix = `https://${prefix}`
    if (!prefix.endsWith('/')) prefix = `${prefix}/`
    updateProxySettingsStore.commit(prev => ({ ...prev, proxy: 'custom', customPrefix: prefix }))
    void updateStore.checkForUpdates({ force: true })
  }, [])

  // 从「安装未知应用」设置页返回后推进更新状态（否则界面会停在「等待授权」）
  useEffect(() => watchAndroidUpdateResume(), [])

  const handleCheckUpdates = useCallback(() => {
    void updateStore.checkForUpdates({ force: true })
  }, [])

  const handleAutoUpdate = useCallback(() => {
    /**
     * 把「原始清单地址」交给 desktopUpdater：那里会按线路顺序取回清单、**改写
     * asset 地址**，再交给 Rust 安装。只改清单地址而不改 asset 地址的话安装包仍然
     * 直连 —— 典型表现就是「检查能过、下载必失败」。
     *
     * 为什么传原始地址而不是第 0 条：desktopUpdater 内部与检查更新共用同一份
     * 线路链（getRouteChain），两处不会分叉。
     */
    void desktopUpdater.installLatest(latestRelease ? getReleaseManifestUrl(latestRelease) : undefined)
  }, [latestRelease])

  const handleAndroidUpdate = useCallback(() => {
    if (!latestRelease) return
    void androidUpdater.installLatest(latestRelease)
  }, [latestRelease])

  const handleRelaunch = useCallback(() => {
    void desktopUpdater.relaunchApp().catch(() => {
      // 重启失败时保持 ready 状态，用户可手动重启
    })
  }, [])

  const handleOpenRelease = useCallback(() => {
    const targetUrl = latestRelease?.url || RELEASES_PAGE_URL
    updateStore.hideToastForCurrentVersion()
    void openExternalUrl(targetUrl)
  }, [latestRelease?.url])

  const handleExportBackup = useCallback(async () => {
    setBackupError(null)
    setBackupBusy('export')
    try {
      const { fileName, data } = await exportSettingsBackup()
      saveData(data, fileName, 'application/json;charset=utf-8')
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : t('about.backupExportFailed'))
    } finally {
      setBackupBusy(null)
    }
  }, [t])

  const handleImportClick = useCallback(() => {
    setBackupError(null)
    fileInputRef.current?.click()
  }, [])

  const handleImportBackup = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return

      setBackupError(null)
      setBackupBusy('import')

      try {
        const { createdAt } = await previewBackupMeta(file)
        const confirmed = window.confirm(
          createdAt
            ? t('about.backupImportConfirmWithDate', { date: new Date(createdAt).toLocaleString() })
            : t('about.backupImportConfirm'),
        )
        if (!confirmed) return

        await importSettingsBackup(file)
        window.location.reload()
      } catch (error) {
        setBackupError(error instanceof Error ? error.message : t('about.backupImportFailed'))
      } finally {
        setBackupBusy(null)
      }
    },
    [t],
  )

  let statusText = t('about.statusIdle')
  if (updaterProgress.phase === 'error') {
    statusText = t('about.autoUpdateError', { error: updaterProgress.error ?? '' })
  } else if (androidProgress.phase === 'error') {
    statusText = t('about.autoUpdateError', { error: androidProgress.error ?? '' })
  } else if (updaterProgress.phase === 'ready') {
    statusText = t('about.autoUpdateReady')
  } else if (androidProgress.phase === 'awaitingPermission') {
    // 首次更新：已跳去「安装未知应用」授权页，返回后自动续装
    statusText = t('about.androidAwaitingPermission')
  } else if (androidProgress.phase === 'installing') {
    // Android 下载完成：系统安装界面已弹出，等用户确认
    statusText = t('about.androidInstalling')
  } else if (updaterProgress.phase === 'installing') {
    statusText = t('about.autoUpdateInstalling')
  } else if (androidProgress.phase === 'downloading') {
    statusText = t('about.autoUpdateDownloading', {
      percent: androidProgress.totalBytes
        ? Math.floor((androidProgress.downloadedBytes / androidProgress.totalBytes) * 100)
        : null,
    })
  } else if (updaterProgress.phase === 'downloading') {
    statusText = t('about.autoUpdateDownloading', {
      percent: updaterProgress.totalBytes
        ? Math.floor((updaterProgress.downloadedBytes / updaterProgress.totalBytes) * 100)
        : null,
    })
  } else if (updateState.checking) {
    statusText = t('about.statusChecking')
  } else if (updateState.error) {
    statusText = t('about.statusError', { error: updateState.error })
  } else if (hasUpdate) {
    statusText = t('about.statusUpdateAvailable', { version: latestVersion })
  } else if (latestRelease) {
    statusText = t('about.statusUpToDate')
  }

  return (
    <div>
      <SettingsSection plain title={t('about.versionCardTitle')} description={t('about.versionCardDesc')}>
        <div className="divide-y divide-border-200/35">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="text-ui-caption text-text-300">{t('about.currentVersion')}</div>
            <div className="shrink-0 text-ui-caption font-semibold text-text-100 tabular-nums">
              v{updateState.currentVersion}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="text-ui-caption text-text-300">{t('about.updateChannel')}</div>
            <div className="shrink-0 text-ui-caption font-semibold text-text-100">
              {updateState.currentChannel === 'canary' ? t('about.channelCanary') : t('about.channelStable')}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="text-ui-caption text-text-300">{t('about.latestVersion')}</div>
            <div className="shrink-0 text-ui-caption font-semibold text-text-100 tabular-nums">
              {latestVersion}
            </div>
          </div>
        </div>

        <div className="min-w-0 text-ui-caption text-text-300 leading-relaxed">
          <div className="break-words font-medium text-text-100">{statusText}</div>
          {releaseDate && <div className="mt-1 text-text-400">{t('about.publishedAt', { date: releaseDate })}</div>}
        </div>

        <div className="flex flex-wrap gap-2">
          {canAutoUpdate && hasUpdate && updaterProgress.phase !== 'ready' && (
            <Button size="sm" variant="primary" isLoading={updaterBusy} onClick={handleAutoUpdate}>
              {!updaterBusy && <DownloadIcon size={12} />}
              {t('about.autoUpdateNow')}
            </Button>
          )}
          {canAutoUpdate && updaterProgress.phase === 'ready' && (
            <Button size="sm" variant="primary" onClick={handleRelaunch}>
              <RetryIcon size={12} />
              {t('about.autoUpdateRestart')}
            </Button>
          )}
          {/* Android：下载 APK 后交给系统安装器（应用内无法静默安装） */}
          {canAndroidUpdate && hasUpdate && (
            <Button size="sm" variant="primary" isLoading={androidBusy} onClick={handleAndroidUpdate}>
              {!androidBusy && <DownloadIcon size={12} />}
              {t('about.autoUpdateNow')}
            </Button>
          )}
          <Button size="sm" variant="secondary" isLoading={updateState.checking} onClick={handleCheckUpdates}>
            {!updateState.checking && <RetryIcon size={12} />}
            {t('about.checkNow')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleOpenRelease}>
            <ExternalLinkIcon size={12} />
            {hasUpdate ? t('about.viewUpdate') : t('about.openReleases')}
          </Button>
        </div>
      </SettingsSection>

      {/* 自动更新只对桌面端有意义：Web 端没有安装能力，Android 走系统安装器 */}
      {canAutoUpdate ? (
        <SettingsSection title={t('about.autoUpdateCardTitle')} description={t('about.autoUpdateCardDesc')}>
          <SettingRow label={t('about.autoUpdateEnabled')} description={t('about.autoUpdateEnabledDesc')}>
            <Toggle
              enabled={autoUpdate.enabled}
              onChange={handleToggleAutoUpdate}
              ariaLabel={t('about.autoUpdateEnabled')}
            />
          </SettingRow>
          <SettingRow
            label={t('about.autoUpdateInterval')}
            description={t('about.autoUpdateIntervalDesc')}
            disabled={!autoUpdate.enabled}
          >
            <SegmentedControl
              value={String(autoUpdate.intervalMinutes)}
              size="sm"
              options={AUTO_UPDATE_INTERVAL_OPTIONS.map(minutes => ({
                value: String(minutes),
                label: t(`about.autoUpdateInterval${minutes}`),
              }))}
              onChange={handleAutoUpdateInterval}
            />
          </SettingRow>
        </SettingsSection>
      ) : null}

      {/*
        更新线路：GitHub 直连常被墙，「检查更新」会一直转圈、「安装更新」总是失败。
        这里让用户选一个加速代理（失败自动回退直连），并提供自定义前缀。
      */}
      <SettingsSection title={t('about.updateProxyCardTitle')} description={t('about.updateProxyCardDesc')}>
        <SettingRow label={t('about.updateProxy')} description={t('about.updateProxyDesc')}>
          <Select value={proxySettings.proxy} onValueChange={handleProxyChange}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="auto">{t('about.updateProxyAuto')}</SelectItem>
              <SelectItem value="none">{t('about.updateProxyNone')}</SelectItem>
              {BUILTIN_UPDATE_PROXIES.map(item => (
                <SelectItem key={item.id} value={item.id}>
                  {item.id}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t('about.updateProxyCustom')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {proxySettings.proxy === 'custom' && (
          <SettingRow label={t('about.updateProxyCustomPrefix')} description={t('about.updateProxyCustomPrefixDesc')}>
            <input
              type="text"
              defaultValue={proxySettings.customPrefix}
              placeholder="https://gh-proxy.com/"
              onBlur={event => handleCustomPrefixCommit(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') handleCustomPrefixCommit((event.target as HTMLInputElement).value)
              }}
              className="h-8 w-56 min-w-0 rounded-md border border-border-200 bg-transparent px-2.5 text-ui-caption text-text-100 placeholder:text-text-500 hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 focus-visible:outline-none"
            />
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection plain title={t('about.backupCardTitle')} description={t('about.backupCardDesc')}>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportBackup}
          className="hidden"
        />
        <div className="rounded-lg bg-warning-bg/40 border border-warning-100/20 px-3.5 py-3 text-ui-caption text-text-300 leading-relaxed">
          {t('about.backupWarning')}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isLoading={backupBusy === 'export'} onClick={handleExportBackup}>
            {backupBusy !== 'export' && <DownloadIcon size={12} />}
            {t('about.exportBackup')}
          </Button>
          <Button size="sm" variant="ghost" isLoading={backupBusy === 'import'} onClick={handleImportClick}>
            {backupBusy !== 'import' && <UploadIcon size={12} />}
            {t('about.importBackup')}
          </Button>
        </div>

        {backupError && (
          <div className="min-w-0 break-all rounded-lg bg-danger-100/10 border border-danger-100/20 px-3.5 py-2.5 text-ui-caption text-danger-100 leading-relaxed">
            {backupError}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
