import { z } from 'zod'
import { createStore } from '../storage/createStore'

/**
 * 自动批准相关的持久化开关。
 *
 * 原先三个字段各自 `serverStorage.get/set` 一次，读写路径分散且没有校验；
 * 这里收敛成一个 store，一次 commit 落盘，且带 schema 兜底。
 */
const QUESTION_TIMEOUT_VALUES = [0, 60, 120] as const

const schema = z.object({
  /** true = 前端临时记住规则；false = 交给后端始终允许 */
  enabled: z.boolean().default(true),
  /** Full Auto 开启时是否追补已经等待中的权限（危险操作，默认关闭） */
  approvePendingOnFullAuto: z.boolean().default(false),
  /** 提问超时自动选推荐项（秒，0 = 关闭） */
  questionAutoSelectTimeout: z.union([z.literal(0), z.literal(60), z.literal(120)]).default(0),
})

export type AutoApproveSettings = z.infer<typeof schema>

export type QuestionAutoSelectTimeout = (typeof QUESTION_TIMEOUT_VALUES)[number]

export const autoApproveSettingsStore = createStore({
  key: 'opencode-auto-approve-settings',
  scope: { kind: 'server', serverId: 'local' },
  schema,
  defaultValue: schema.parse({}),
})

/** 兼容旧值：非法秒数回落为 0 */
export function parseQuestionAutoSelectTimeout(raw: string | null | undefined): QuestionAutoSelectTimeout {
  const parsed = Number(raw)
  return (QUESTION_TIMEOUT_VALUES as readonly number[]).includes(parsed)
    ? (parsed as QuestionAutoSelectTimeout)
    : 0
}

export { QUESTION_TIMEOUT_VALUES }
