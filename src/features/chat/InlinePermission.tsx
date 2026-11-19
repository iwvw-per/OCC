/**
 * InlinePermission — 融入信息流的权限确认
 *
 * 复用工具调用结果的 ContentBlock 渲染风格。
 * 操作按钮紧跟 ContentBlock 下方。
 */

import { memo } from 'react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApiPermissionRequest, PermissionReply } from '../../api'
// 深导入而非走 components barrel：barrel 会把 MarkdownRenderer/DiffView/
// FullscreenViewer 等重链路一并拉进首屏 chunk（CodeMirror ~860KB）。
import { ContentBlock } from '../../components/ContentBlock'
import { ShieldIcon } from '../../components/Icons'
import { ApprovalCard } from '../../components/ui/ApprovalCard'
import { Spinner } from '../../components/ui/Spinner'
import { autoApproveStore } from '../../store'
import { themeStore } from '../../store/themeStore'

interface InlinePermissionProps {
  request: ApiPermissionRequest
  onReply: (requestId: string, reply: PermissionReply) => void
  isReplying: boolean
  /** 权限已批准但工具还没完成，保留渲染避免跳动 */
  resolved?: boolean
  /** ToolBody 已渲染内容时隐藏权限内容区，只显示操作按钮 */
  contentHidden?: boolean
}

export const InlinePermission = memo(function InlinePermission({
  request,
  onReply,
  isReplying,
  resolved = false,
  contentHidden = false,
}: InlinePermissionProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { toolCardStyle } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  const isCompact = toolCardStyle === 'compact'

  const metadata = request.metadata
  const diff = metadata?.diff as string | undefined
  const filepath = metadata?.filepath as string | undefined

  let diffData: { before: string; after: string } | string | undefined
  if (metadata?.filediff && typeof metadata.filediff === 'object') {
    const fd = metadata.filediff as Record<string, unknown>
    // 上游优先返回 patch 格式
    if (typeof fd.patch === 'string') {
      diffData = fd.patch
    } else if (fd.before !== undefined && fd.after !== undefined) {
      diffData = { before: String(fd.before), after: String(fd.after) }
    }
  }
  if (!diffData && diff) {
    diffData = diff
  }

  const isFileEdit = request.permission === 'edit' || request.permission === 'write'
  const hasPatterns = request.patterns && request.patterns.length > 0
  const patternsText = hasPatterns ? request.patterns.map(p => p.replace(/\\n/g, '\n')).join('\n\n') : ''

  const handleAlways = () => {
    if (autoApproveStore.enabled) {
      const rulePatterns = [...(request.always || []), ...(request.patterns || [])]
      const unique = [...new Set(rulePatterns)]
      if (unique.length > 0) {
        autoApproveStore.addRules(request.sessionID, request.permission, unique)
        onReply(request.id, 'once')
        return
      }
    }
    onReply(request.id, 'always')
  }

  // 内容由 ToolBody 渲染时（contentHidden），只保留操作条
  const showContent = !contentHidden && (isFileEdit ? !!diffData : !!patternsText)

  const actions = resolved ? (
    <div className="flex items-center gap-2 text-ui-caption text-text-400">
      <Spinner size="sm" tone="accent" />
      <span>{t('permissionDialog.applying', { defaultValue: 'Applying…' })}</span>
    </div>
  ) : (
    <>
      <button
        onClick={() => onReply(request.id, 'once')}
        disabled={isReplying}
        data-haptic="strong"
        className="px-2.5 h-7 rounded-md text-ui-caption font-medium bg-text-100 text-bg-000 hover:bg-text-200 transition-colors disabled:opacity-50"
      >
        {t('permissionDialog.allowOnce')}
      </button>
      <button
        onClick={handleAlways}
        disabled={isReplying}
        data-haptic="strong"
        className="px-2.5 h-7 rounded-md text-ui-caption text-text-300 hover:bg-bg-200 transition-colors disabled:opacity-50"
      >
        {t('permissionDialog.alwaysAllow')}
      </button>
      <button
        onClick={() => onReply(request.id, 'reject')}
        disabled={isReplying}
        data-haptic="strong"
        className="px-2.5 h-7 rounded-md text-ui-caption text-text-400 hover:bg-danger-100/10 transition-colors disabled:opacity-50"
      >
        {t('common:reject')}
      </button>
    </>
  )

  if (!showContent) {
    return <div className="flex items-center gap-2">{actions}</div>
  }

  return (
    <ApprovalCard
      header={
        <>
          <ShieldIcon size={14} className="shrink-0 text-text-400" />
          <span className="font-medium text-text-300 font-mono">{request.permission}</span>
          {filepath && <span className="min-w-0 truncate text-text-500 font-mono">{filepath}</span>}
        </>
      }
      footer={actions}
    >
      {isFileEdit && diffData ? (
        <ContentBlock
          stateKey={`permission:${request.sessionID}:${request.id}:diff`}
          label={request.permission}
          filePath={filepath}
          diff={diffData}
          collapsible={false}
          compact={isCompact}
        />
      ) : (
        <ContentBlock
          stateKey={`permission:${request.sessionID}:${request.id}:patterns`}
          label={request.permission}
          content={patternsText}
          language="bash"
          collapsible={false}
          compact={isCompact}
        />
      )}
    </ApprovalCard>
  )
})
