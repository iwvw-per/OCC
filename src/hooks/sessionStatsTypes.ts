export interface SessionStats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  totalCost: number
  /**
   * 上下文占用（token）。**没有任何服务端实测值时是 null**。
   *
   * 前端不再用字符数估算它：估算系统性偏低（图片/附件完全不计入、中英混排
   * 按固定系数折算），而用户会拿这个数字决定要不要压缩。给不出准确值时就
   * 说「不知道」，消费方必须处理 null（显示 `—`），不能当成 0。
   */
  contextUsed: number | null
  /**
   * 该模型声明的上下文窗口。**未知时为 0**，不是猜出来的默认值。
   *
   * 早期各处兜底成 200000，实测某模型真实窗口是 1000000 —— 分母错 5 倍，
   * 百分比随之虚高 5 倍。错误的分母比不显示更糟：用户会以为快满了。
   */
  contextLimit: number
  /**
   * 上下文占用百分比；`contextLimit <= 0`（窗口未知）或占用未知时为 **null**。
   *
   * 消费方必须处理 null（显示 `--`），不能当成 0 —— 0% 会被读成「几乎空」。
   */
  contextPercent: number | null
  contextEstimated: boolean
}
