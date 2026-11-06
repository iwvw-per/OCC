import { z } from 'zod'
import { createStore } from '../storage/createStore'

/**
 * 桌面端自动更新的持久化开关。
 *
 * 为什么单独一个 store：这项设置属于**应用**而不是某台服务器（更新的是客户端
 * 本体），所以用 global scope。放进 updateStore 会让备份导入/导出把它一并覆盖，
 * 而后者的语义是「最近一次检查结果」，不是用户偏好。
 */

/** 检查间隔候选项（分钟）。30 分钟约 2 次/小时，远低于 GitHub 未认证 60 次/小时的限额。 */
export const AUTO_UPDATE_INTERVAL_OPTIONS = [30, 60, 180, 720] as const
export type AutoUpdateIntervalMinutes = (typeof AUTO_UPDATE_INTERVAL_OPTIONS)[number]

const intervalSchema = z
  .number()
  .int()
  .refine((value): value is AutoUpdateIntervalMinutes =>
    (AUTO_UPDATE_INTERVAL_OPTIONS as readonly number[]).includes(value),
  )
  .default(30)

const schema = z.object({
  /**
   * 是否在桌面端自动下载并安装更新。默认开启：这是「更新」这件事的默认预期，
   * 关掉是显式选择。移动端不受影响（见 desktopAutoUpdateCoordinator 的可用性判断）。
   */
  enabled: z.boolean().default(true),
  /** 定时检测间隔 */
  intervalMinutes: intervalSchema,
})

export type AutoUpdateSettings = z.infer<typeof schema>

export const autoUpdateSettingsStore = createStore({
  key: 'opencode-auto-update-settings',
  scope: { kind: 'global' },
  schema,
  defaultValue: schema.parse({}),
})
