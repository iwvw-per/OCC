/** 初始消息加载数量（旧版按条数分页、本轮 diff 兜底等仍在用） */
export const INITIAL_MESSAGE_LIMIT = 50

/** 首屏默认加载的完整对话轮数 */
export const INITIAL_TURN_LIMIT = 3

/** 上滑一次追加的完整对话轮数 */
export const HISTORY_TURN_BATCH_SIZE = 5

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