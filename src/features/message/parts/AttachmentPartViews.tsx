import { memo } from 'react'
import { AttachmentItem, fromTextPart } from '../../attachment'
import type { TextPart } from '../../../types/message'

// ============================================
// Synthetic Text Part View (系统上下文)
// ============================================

interface SyntheticTextPartViewProps {
  part: TextPart
}

export const SyntheticTextPartView = memo(function SyntheticTextPartView({ part }: SyntheticTextPartViewProps) {
  if (!part.synthetic) return null

  // 转换为 Attachment 类型
  const attachment = fromTextPart(part)

  return <AttachmentItem attachment={attachment} expandable size="sm" />
})
