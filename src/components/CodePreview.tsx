import { useSyncExternalStore } from 'react'
import { CodeMirrorReadonly } from './CodeMirrorReadonly'
import { codeLineHeight, type TargetLineRange } from './codeMirrorReadonlyExtensions'
import { useSyntaxHighlightRef } from '../hooks/useSyntaxHighlight'
import { themeStore } from '../store/themeStore'

interface CodePreviewProps {
  code: string
  language: string
  maxHeight?: number
  isResizing?: boolean
  isVisible?: boolean
  layoutVersion?: number
  wordWrap?: boolean
  targetLine?: number | null
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

export function CodePreview({
  code,
  language,
  maxHeight,
  isResizing = false,
  isVisible = true,
  layoutVersion,
  wordWrap,
  targetLine,
  targetKey,
  targetRanges,
}: CodePreviewProps) {
  const { codeWordWrap, codeFontScale } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  const resolvedWordWrap = wordWrap ?? codeWordWrap
  // 内容可能尚未就绪:归一化为字符串,避免下游 CodeMirror 拿到 undefined
  const source = typeof code === 'string' ? code : ''
  const { tokensRef, version } = useSyntaxHighlightRef(source, {
    lang: language,
    enabled: language !== 'text',
  })

  return (
    <CodeMirrorReadonly
      code={source}
      tokensRef={tokensRef}
      tokensVersion={version}
      wordWrap={resolvedWordWrap}
      lineHeight={codeLineHeight(codeFontScale)}
      maxHeight={maxHeight}
      isResizing={isResizing}
      isVisible={isVisible}
      layoutVersion={layoutVersion}
      targetLine={targetLine}
      targetKey={targetKey}
      targetRanges={targetRanges}
    />
  )
}
