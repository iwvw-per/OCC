import { useCallback, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { DownloadIcon, ExternalLinkIcon, RetryIcon, UploadIcon } from '../../../components/Icons'
import { hasUpdateAvailable, updateStore, useUpdateStore, getReleaseManifestUrl, RELEASES_PAGE_URL } from '../../../store/updateStore'
import { desktopUpdater, isDesktopUpdaterAvailable, type UpdaterProgress } from '../../../utils/desktopUpdater'
import { androidUpdater, isAndroidUpdaterAvailable, type AndroidUpdateProgress } from '../../../utils/androidUpdater'
import { saveData } from '../../../utils/downloadUtils'
import { exportSettingsBackup, importSettingsBackup, previewBackupMeta } from '../../../utils/settingsBackup'
import { isTauri } from '../../../utils/tauri'
import { SettingsSection } from './SettingsUI'

function useUpdaterProgress(): UpdaterProgress {
  return useSyncExternalStore(desktopUpdater.subscribe, desktopUpdater.getSnapshot, desktopUpdater.getSnapshot)
}

function useAndroidUpdaterProgress(): AndroidUpdateProgress {
  return useSyncExternalStore(
    androidUpdater.subscribe,
    androidUpdater.getSnapshot,
    androidUpdater.getSnapshot,
  )
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

  const canAutoUpdate = isDesktopUpdaterAvailable()
  const canAndroidUpdate = isAndroidUpdaterAvailable()
  const updaterBusy =
    updaterProgress.phase === 'checking' ||
    updaterProgress.phase === 'downloading' ||
    updaterProgress.phase === 'installing'
  const androidBusy =
    androidProgress.phase === 'downloading' || androidProgress.phase === 'installing'

  const handleCheckUpdates = useCallback(() => {
    void updateStore.checkForUpdates({ force: true })
  }, [])

  const handleAutoUpdate = useCallback(() => {
    // 把该 release 自己的 latest.json 传给 Rust：canary 清单在其 tag 路径下，
    // 静态 endpoint（releases/latest）解析不到。
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
            <div className="text-[length:var(--fs-sm)] text-text-300">{t('about.currentVersion')}</div>
            <div className="shrink-0 text-[length:var(--fs-sm)] font-semibold text-text-100 tabular-nums">
              v{updateState.currentVersion}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="text-[length:var(--fs-sm)] text-text-300">{t('about.updateChannel')}</div>
            <div className="shrink-0 text-[length:var(--fs-sm)] font-semibold text-text-100">
              {updateState.currentChannel === 'canary' ? t('about.channelCanary') : t('about.channelStable')}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="text-[length:var(--fs-sm)] text-text-300">{t('about.latestVersion')}</div>
            <div className="shrink-0 text-[length:var(--fs-sm)] font-semibold text-text-100 tabular-nums">{latestVersion}</div>
          </div>
        </div>

        <div className="min-w-0 text-[length:var(--fs-sm)] text-text-300 leading-relaxed">
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

      <SettingsSection plain title={t('about.backupCardTitle')} description={t('about.backupCardDesc')}>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportBackup}
          className="hidden"
        />
        <div className="rounded-lg bg-warning-bg/40 border border-warning-100/20 px-3.5 py-3 text-[length:var(--fs-sm)] text-text-300 leading-relaxed">
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
          <div className="min-w-0 break-all rounded-lg bg-danger-100/10 border border-danger-100/20 px-3.5 py-2.5 text-[length:var(--fs-sm)] text-danger-100 leading-relaxed">
            {backupError}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
