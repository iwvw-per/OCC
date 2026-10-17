import type { ReactNode } from 'react'
import type { ToolPart } from '../../../types/message'
import type { ToolConfig, ToolRegistry, ExtractedToolData, DiagnosticInfo } from './types'
import { BashRenderer, QuestionRenderer } from './renderers'
import {
  FileReadIcon,
  FileWriteIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  BrainIcon,
  ChecklistIcon,
  QuestionIcon,
  TaskIcon,
  WrenchIcon,
} from './icons'
import { detectLanguage } from '../../../utils/languageUtils'

// ============================================
// Tool Matchers (复用的匹配函数)
// ============================================

const includes =
  (...keywords: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return keywords.some(k => lower.includes(k))
  }

const exact =
  (...names: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return names.some(n => lower === n)
  }

interface MetadataFileEntry {
  filePath?: string
  file?: string
  diff?: string
  patch?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
}

interface MetadataDiagnosticEntry {
  severity?: number
  message?: string
  range?: {
    start?: {
      line?: number
      character?: number
    }
  }
}

// ============================================
// Default Data Extractor
// ============================================

export function defaultExtractData(part: ToolPart): ExtractedToolData {
  const { state } = part
  const inputObj = state.input as Record<string, unknown> | undefined
  const metadata = state.metadata as Record<string, unknown> | undefined

  const result: ExtractedToolData = {}

  // Input
  if (inputObj && Object.keys(inputObj).length > 0) {
    result.input = JSON.stringify(inputObj, null, 2)
    result.inputLang = 'json'
  }

  // Error
  if (state.error) {
    result.error = String(state.error)
  }

  // FilePath
  if (metadata && typeof metadata.filepath === 'string') {
    result.filePath = metadata.filepath
  }
  if (!result.filePath && inputObj?.filePath) {
    result.filePath = String(inputObj.filePath)
  }
  // v2 write/save 工具把目标路径放在 input.path（而非 filePath）。不读取会导致
  // collectChangedFiles 用工具名（如 "write"）兜底当文件路径，变更列表显示错乱。
  if (!result.filePath && inputObj && typeof inputObj.path === 'string') {
    result.filePath = inputObj.path
  }

  // Exit code
  if (metadata && typeof metadata.exit === 'number') {
    result.exitCode = metadata.exit
  }

  // Diff / Files (from metadata)
  if (metadata) {
    if (Array.isArray(metadata.files) && metadata.files.length > 0) {
      result.files = (metadata.files as MetadataFileEntry[]).map(file => ({
        filePath: file.filePath || file.file || 'unknown',
        diff: file.diff,
        patch: file.patch,
        before: file.before,
        after: file.after,
        additions: file.additions,
        deletions: file.deletions,
      }))
    } else if (typeof metadata.diff === 'string') {
      // 优先使用 unified diff
      result.diff = metadata.diff
      // 从 filediff 获取统计
      if (metadata.filediff && typeof metadata.filediff === 'object') {
        const fd = metadata.filediff as { additions?: number; deletions?: number }
        if (fd.additions !== undefined || fd.deletions !== undefined) {
          result.diffStats = {
            additions: fd.additions || 0,
            deletions: fd.deletions || 0,
          }
        }
      }
    } else if (metadata.filediff && typeof metadata.filediff === 'object') {
      const fd = metadata.filediff as {
        patch?: string
        before?: string
        after?: string
        additions?: number
        deletions?: number
      }
      // 上游 v1.4.0+ metadata.filediff 用 patch 格式
      if (fd.patch) {
        result.diff = fd.patch
      } else if (fd.before !== undefined && fd.after !== undefined) {
        result.diff = { before: fd.before, after: fd.after }
      }
      if (fd.additions !== undefined || fd.deletions !== undefined) {
        result.diffStats = {
          additions: fd.additions || 0,
          deletions: fd.deletions || 0,
        }
      }
    }

    // 提取 diagnostics
    if (metadata.diagnostics && typeof metadata.diagnostics === 'object') {
      const diagMap = metadata.diagnostics as Record<string, MetadataDiagnosticEntry[]>
      const diagnostics: DiagnosticInfo[] = []

      for (const [file, items] of Object.entries(diagMap)) {
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          // severity: 1=error, 2=warning, 3=info, 4=hint
          const severityMap: Record<number, DiagnosticInfo['severity']> = {
            1: 'error',
            2: 'warning',
            3: 'info',
            4: 'hint',
          }
          diagnostics.push({
            file: file.split(/[/\\]/).pop() || file,
            severity: typeof item.severity === 'number' ? (severityMap[item.severity] ?? 'info') : 'info',
            message: item.message || '',
            line: item.range?.start?.line ?? 0,
            column: item.range?.start?.character ?? 0,
          })
        }
      }

      // 只保留 error 和 warning
      const filtered = diagnostics.filter(d => d.severity === 'error' || d.severity === 'warning')
      if (filtered.length > 0) {
        result.diagnostics = filtered
      }
    }
  }

  // Output language from filePath
  if (result.filePath) {
    result.outputLang = detectLanguage(result.filePath)
  }

  // Output: 分运行状态取不同的字段
  const stateOutput = 'output' in state ? state.output : undefined
  const runningOutput = state.status === 'running' && typeof metadata?.output === 'string' ? metadata.output : undefined
  const interruptedOutput = metadata?.interrupted === true && typeof metadata.output === 'string' ? metadata.output : undefined
  const output = stateOutput ?? runningOutput ?? interruptedOutput
  if (!result.files && !result.diff && output) {
    result.output = typeof output === 'string' ? output : JSON.stringify(output, null, 2)

    // 推断语言
    if (!result.outputLang && result.output) {
      const trimmed = result.output.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        result.outputLang = 'json'
      }
    }
  }

  return result
}

// ============================================
// Tool-Specific Data Extractors
// ============================================

function bashExtractData(part: ToolPart): ExtractedToolData {
  const base = defaultExtractData(part)
  const inputObj = part.state.input as Record<string, unknown> | undefined
  const metadata = part.state.metadata as Record<string, unknown> | undefined

  if (inputObj?.command) {
    base.input = String(inputObj.command)
    base.inputLang = 'bash'
  }

  const cwd = inputObj?.workdir ?? inputObj?.cwd ?? metadata?.workdir ?? metadata?.cwd
  if (typeof cwd === 'string' && cwd.trim()) {
    base.cwd = cwd.trim()
  }

  return base
}

function readExtractData(part: ToolPart): ExtractedToolData {
  const base = defaultExtractData(part)

  if (part.state.output) {
    const str = String(part.state.output)
    const match = str.match(/<file[^>]*>([\s\S]*?)<\/file>/i)
    base.output = match ? match[1] : str
  }

  return base
}

function writeExtractData(part: ToolPart): ExtractedToolData {
  const base = defaultExtractData(part)
  const inputObj = part.state.input as Record<string, unknown> | undefined

  // 从 input.content 构造 diff（和 editExtractData 一致）
  // 状态控制由渲染层（OutputBlock）统一处理，extractData 只做数据转换
  if (!base.files && !base.diff && inputObj?.content && typeof inputObj.content === 'string') {
    base.diff = {
      before: '',
      after: inputObj.content,
    }
  }

  return base
}

function editExtractData(part: ToolPart): ExtractedToolData {
  const base = defaultExtractData(part)
  const inputObj = part.state.input as Record<string, unknown> | undefined

  // 如果 metadata 没有 diff，从 input 构造
  if (!base.files && !base.diff && inputObj?.oldString && inputObj?.newString) {
    base.diff = {
      before: String(inputObj.oldString),
      after: String(inputObj.newString),
    }
  }

  return base
}

// ============================================
// Tool Registry
// 按优先级排列，第一个匹配的配置生效
// ============================================

export const toolRegistry: ToolRegistry = [
  // Bash / Terminal
  {
    match: (name: string) => includes('bash', 'cmd', 'terminal', 'shell')(name) || exact('sh')(name),
    icon: <TerminalIcon />,
    colorClass: 'tool-color-exec',
    extractData: bashExtractData,
    renderer: BashRenderer,
  },

  // Todo (must be before write/read to avoid TodoWrite matching "write")
  {
    match: includes('todo'),
    icon: <ChecklistIcon />,
    colorClass: 'tool-color-todo',
  },

  // Task (子 agent)：v1 叫 task，v2/OMO 叫 subagent
  {
    match: exact('task', 'subagent', 'sub_agent', 'task_agent'),
    icon: <TaskIcon />,
    colorClass: 'tool-color-task',
  },

  // Read file
  {
    match: includes('read', 'cat'),
    icon: <FileReadIcon />,
    colorClass: 'tool-color-read',
    extractData: readExtractData,
  },

  // Write file
  {
    match: includes('write', 'save'),
    icon: <FileWriteIcon />,
    colorClass: 'tool-color-write',
    extractData: writeExtractData,
  },

  // Edit file
  {
    match: includes('edit', 'replace', 'patch'),
    icon: <FileWriteIcon />,
    colorClass: 'tool-color-write',
    extractData: editExtractData,
  },

  // Search
  {
    match: includes('search', 'find', 'grep', 'glob'),
    icon: <SearchIcon />,
    colorClass: 'tool-color-search',
  },

  // Web / Network
  {
    match: includes('web', 'fetch', 'http', 'browse', 'network', 'exa'),
    icon: <GlobeIcon />,
    colorClass: 'tool-color-network',
  },

  // Think / Reasoning
  {
    match: includes('think', 'reason', 'plan'),
    icon: <BrainIcon />,
    colorClass: 'tool-color-think',
  },

  // Question
  {
    match: includes('question', 'ask'),
    icon: <QuestionIcon />,
    colorClass: 'tool-color-question',
    renderer: QuestionRenderer,
  },
]

// ============================================
// Registry Helpers
// ============================================

/**
 * 获取工具配置
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return toolRegistry.find(config => config.match(toolName))
}

/**
 * 获取工具图标
 */
export function getToolIcon(toolName: string): ReactNode {
  const config = getToolConfig(toolName)
  return config?.icon ?? <WrenchIcon />
}

/**
 * 获取工具图标的配色 class（见 index.css 的 .tool-color-*）。
 * 未登记的工具回退到中性灰。
 */
export function getToolColorClass(toolName: string): string {
  const config = getToolConfig(toolName)
  return config?.colorClass ?? 'tool-color-default'
}

/**
 * 提取工具数据
 */
export function extractToolData(part: ToolPart): ExtractedToolData {
  const config = getToolConfig(part.tool)
  if (config?.extractData) {
    return config.extractData(part)
  }
  return defaultExtractData(part)
}
