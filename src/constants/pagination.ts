/** 初始消息加载数量（旧版按条数分页、本轮 diff 兜底等仍在用） */
export const INITIAL_MESSAGE_LIMIT = 50

/** 首屏默认加载的完整对话轮数 */
export const INITIAL_TURN_LIMIT = 3

/**
 * 上滑一次追加的完整对话轮次。
 *
 * 取 3 而非 5：上滑加载的字节数 ≈ 轮数 × 每轮消息数 × 单条大小。工具密集的
 * 会话每轮可达 30+ 条（实测某会话 4810 条消息只有 135 个用户轮次），5 轮就是
 * 近 1MB —— 经网关传输要 1.6 秒，用户会感到「卡一下」。3 轮把这一刀砍掉近一半，
 * 而用户上滑通常也就看个三四轮。
 */
export const HISTORY_TURN_BATCH_SIZE = 3

/**
 * 历史分页的页大小下限（条）。
 *
 * 服务端的 limit 是**消息条数**，而我们想要的是**轮次**。普通聊天一轮 2~4 条，
 * 工具密集的会话一轮可达 30+ 条（实测某会话 4810 条消息只有 135 个用户轮次
 * ≈ 35 条/轮）。固定一个页大小，要么多下载（普通会话为了 3 轮拉 200 条 =
 * 947KB），要么多翻页（密集会话凑不满轮次，来回次数翻倍）。
 */
export const HISTORY_PAGE_LIMIT_MIN = 20

/**
 * 历史分页的页大小上限（条）。
 *
 * 服务端硬上限是 200，超过即 400；但一次拉 200 条实测是 947KB —— 经网关时
 * 光传输就要 1.6 秒，用户会明显感到「卡一下」。这里封顶 120 条（约 560KB）。
 */
export const HISTORY_PAGE_LIMIT_MAX = 120

/** 轮次密度样本不足时使用的默认「每轮消息数」（普通聊天约 4~6 条） */
export const DEFAULT_MESSAGES_PER_TURN = 6

/**
 * 按「每轮平均消息数」估算一次要取多少条消息。
 *
 * 目标轮次 × 每轮消息数 × 1.2 余量，再夹到 [HISTORY_PAGE_LIMIT_MIN, HISTORY_PAGE_LIMIT_MAX]。
 *
 * 样本不足（用户消息少于 3 条）时用默认值 —— 首屏那 12 条常常一条用户消息
 * 都没有，据此算出的密度是 0 或离谱的值。
 */
export function estimateHistoryPageSize(messagesPerTurn: number, targetTurns: number): number {
  // 密度夹在 [2, 60]：低于 2 说明样本里几乎没有用户轮次（不可信），
  // 高于 60 说明这个会话是极端的「一轮几百条」，按它算会让页大小顶到上限。
  const raw = Number.isFinite(messagesPerTurn) && messagesPerTurn > 0 ? messagesPerTurn : DEFAULT_MESSAGES_PER_TURN
  const density = Math.min(60, Math.max(2, raw))
  const needed = Math.ceil(targetTurns * density * 1.2)
  return Math.min(HISTORY_PAGE_LIMIT_MAX, Math.max(HISTORY_PAGE_LIMIT_MIN, needed))
}

/**
 * 单次底层 message 请求的条数上限（轮次分页的内部粒度）。
 *
 * 取服务端允许的最大值 200：v2 对 message.list 的 limit 有硬校验
 * （>200 直接 400），而这里每多一页就是**一次完整的网络往返**。
 * 经隧道时单次往返约 1.1s，30 条/页会让「首屏 3 轮」常常要翻 3–4 页
 * （3–4 秒）；200 条/页基本一页就能覆盖首屏，直接省掉大部分串行等待。
 */
export const TURN_FETCH_MESSAGE_LIMIT = 200

/** 轮次分页内部最多连续请求几次，用于补齐轮次边界，避免病态循环 */
export const TURN_FETCH_MAX_PAGES = 4

/** 内存中保留完整过程（思考/工具输出）的最近轮数，更早的轮次压缩 */
export const RECENT_FULL_TURNS = 5

/**
 * 首屏第一段请求的条数上限。
 *
 * ⚠️ 这个值必须**很小**，因为它决定了首屏会不会撞上内联附件。
 *
 * 实测同一个会话（4288 条消息）：
 *   - limit=10  →  25KB，4ms；
 *   - limit=20  →  1.44MB，406ms  —— 因为第 20 条附近有一张 1358KB 的 inline 图片；
 *   - limit=60  →  1.54MB，421ms。
 * 也就是说，首屏只要拉到那张图，就要多付 1.4MB 的下载。经隧道按 ~150KB/s 计算，
 * 那是 9 秒以上 —— 用户看到的就是「打开要十几秒」。
 *
 * 所以第一段取 12 条：绝大多数会话能立刻显示最近 1–2 轮的正文，且几乎不可能
 * 撞上大附件。不足的轮次由后台补（见 rest），补的时候才付出图片的代价。
 */
export const FIRST_SCREEN_PAGE_LIMIT = 12