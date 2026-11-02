/**
 * 会话里「重型内联内容」的检测与预警。
 *
 * 背景（真实故障，2026-10-21）：
 * 用户在一个会话里只发了「继续」两个字，却收到
 * `API Error (413) http: request body too large`。
 *
 * 查证链条：
 *   1. agent 用 `read` 工具读了自己截的 5 张 PNG（每张 1.8~2.5MB）；
 *   2. 这些图以 base64 内联进工具结果（`content[].uri = "data:image/png;base64,..."`），
 *      一直留在**服务端**会话上下文里，累计约 11MB；
 *   3. 服务端把上下文转发给模型时，请求体超过上游网关上限 → 413。
 *
 * 上限数值以 `constants/requestLimits.ts` 为准：**8MiB（8388608 字节）**，
 * 2026-11-02 对网关实测确认。此前这里写的「16MB / GeneralMaxSize」是旧值，
 * 会让预警阈值等于「已经超限」，等于不预警。
 *
 * 为什么不能用上下文 token 百分比预警：
 * 413 发生在那一次模型请求上，此前并没有成功的 token 统计；而且图片折算成
 * token 的比例与字节数不成正比。那个圆环在这类故障下不会提前变红。
 *
 * 所以改成统计**确定的事实**：工具结果里被丢弃的内联文件体积。
 * 适配层（api/v2/message.ts）在解析时把图片字节丢掉、只记一个数字
 * （`state.omittedFileBytes`），这里把它汇总起来。
 *
 * 我们无法在前端减小请求体（那些字节只存在于服务端），所以这个预警的价值是
 * 解释「为什么会 413」并给出脱困路径，而不是阻止发送。
 */

import type { Message } from '../../types/message'

/**
 * 累计超过这个体积就预警。
 *
 * 网关请求体上限是 8MiB（实测，见 constants/requestLimits.ts）。请求体里还有
 * 工具定义、文本、JSON 结构等开销，所以预警线必须**明显低于**上限才有意义：
 * 取 6MiB（上限的 3/4），命中时用户还剩约一个回合的缓冲。
 *
 * 此前的 8MiB 等于「已经超限才提示」，等于不预警。
 */
const WARN_TOTAL_BYTES = 6 * 1024 * 1024

/** 单次超过这个量才计入（过滤掉几 KB 的普通文件附件噪音） */
const MIN_PER_TOOL_BYTES = 256 * 1024

export interface HeavyContentSummary {
  /** 命中「带大内联文件」的工具调用次数 */
  toolCount: number
  /** 估算的内联字节总量 */
  totalBytes: number
  /** 是否值得提示用户 */
  shouldWarn: boolean
}

const EMPTY: HeavyContentSummary = { toolCount: 0, totalBytes: 0, shouldWarn: false }

/**
 * 汇总已加载消息里被丢弃的内联文件体积。
 *
 * 只扫内存中的消息（虚拟化 + 历史裁剪后通常就是最近若干轮），
 * 因此它给出的是**下界**：命中说明「确实堆积了大量图片」，
 * 没命中不代表一定安全。提示语按「可能」措辞，不制造误报。
 */
export function summarizeHeavyContent(messages: Message[]): HeavyContentSummary {
  let toolCount = 0
  let totalBytes = 0

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool') continue
      const bytes = (part.state as { omittedFileBytes?: number })?.omittedFileBytes
      if (typeof bytes !== 'number' || bytes < MIN_PER_TOOL_BYTES) continue
      toolCount += 1
      totalBytes += bytes
    }
  }

  if (toolCount === 0) return EMPTY
  return { toolCount, totalBytes, shouldWarn: totalBytes >= WARN_TOTAL_BYTES }
}

/** 人类可读体积，用于提示文案 */
export function formatHeavyBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
