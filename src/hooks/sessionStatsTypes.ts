export interface SessionStats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  totalCost: number
  contextUsed: number
  /**
   * 该模型声明的上下文窗口。**未知时为 0**，不是猜出来的默认值。
   *
   * 早期各处兜底成 200000，实测某模型真实窗口是 1000000 —— 分母错 5 倍，
   * 百分比随之虚高 5 倍。错误的分母比不显示更糟：用户会以为快满了。
   */
  contextLimit: number
  /**
   * 上下文占用百分比；`contextLimit <= 0`（窗口未知）时为 **null**。
   *
   * 消费方必须处理 null（显示 `--`），不能当成 0 —— 0% 会被读成「几乎空」。
   */
  contextPercent: number | null
  contextEstimated: boolean
}
