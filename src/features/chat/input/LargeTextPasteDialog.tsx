// ============================================
// LargeTextPasteDialog — 大文本粘贴处理选择
// ============================================
//
// 粘贴的纯文本超过阈值时弹出，让用户选择处理方式：
// - 作为附件：把文本存为 .txt 附件，输入框保持整洁
// - 内联到输入框：按原样插入
// - 记住选择：把本次选择写入偏好，后续不再询问
//
// 不提供「取消」以外的高级选项，保持决策成本最低。

import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../components/ui/Dialog'
import { Button } from '../../../components/ui/Button'
import { PaperclipIcon, ReturnIcon } from '../../../components/Icons'

interface LargeTextPasteDialogProps {
  isOpen: boolean
  /** 待处理文本的字符数，用于提示 */
  charCount: number
  onClose: () => void
  onAttach: (remember: boolean) => void
  onInline: (remember: boolean) => void
}

export function LargeTextPasteDialog({ isOpen, charCount, onClose, onAttach, onInline }: LargeTextPasteDialogProps) {
  const { t } = useTranslation(['chat', 'common'])

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('inputBox.largePasteTitle', { defaultValue: '粘贴大段文本' })} width={420}>
      <div className="flex flex-col gap-3">
        <p className="text-ui-caption text-text-300">
          {t('inputBox.largePasteBody', {
            count: charCount,
            defaultValue: '粘贴的内容有 {{count}} 个字符，选择处理方式：',
          })}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onAttach(false)}
            className="flex items-start gap-3 rounded-lg border border-border-200 p-3 text-left transition-colors hover:bg-bg-200"
          >
            <span className="mt-0.5 text-text-400">
              <PaperclipIcon size={16} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-ui-caption font-medium text-text-100">
                {t('inputBox.largePasteAsAttachment', { defaultValue: '作为附件' })}
              </span>
              <span className="mt-0.5 block text-ui-sm text-text-400">
                {t('inputBox.largePasteAsAttachmentDesc', { defaultValue: '保存为文本附件，输入框保持整洁' })}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onInline(false)}
            className="flex items-start gap-3 rounded-lg border border-border-200 p-3 text-left transition-colors hover:bg-bg-200"
          >
            <span className="mt-0.5 text-text-400">
              <ReturnIcon size={16} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-ui-caption font-medium text-text-100">
                {t('inputBox.largePasteInline', { defaultValue: '内联到输入框' })}
              </span>
              <span className="mt-0.5 block text-ui-sm text-text-400">
                {t('inputBox.largePasteInlineDesc', { defaultValue: '按原样插入输入框' })}
              </span>
            </span>
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onAttach(true)}>
            {t('inputBox.largePasteAttachAlways', { defaultValue: '总是作为附件' })}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onInline(true)}>
            {t('inputBox.largePasteInlineAlways', { defaultValue: '总是内联' })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
