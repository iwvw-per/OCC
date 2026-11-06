import type { Attachment } from '../features/attachment'

// ============================================
// inputDraftStore - 按会话分桶的输入草稿
//
// 解决「预输入内容被切换会话/新建会话带过去」的问题：
// - 每个会话的草稿独立存储（Map<sessionId, { text, attachments }>）
// - 切回某会话时恢复该会话自己的草稿
// - 新建会话没有桶 → 输入框为空
// - 发送成功后清空对应桶，避免切回来又显示已发送内容
// 纯内存存储：同一应用会话内跨切换保留即可，不跨重启持久化
// （attachments 含 File/Blob 无法安全序列化进 localStorage）。
// ============================================

export interface InputDraft {
  text: string
  attachments: Attachment[]
}

class InputDraftStore {
  private drafts = new Map<string, InputDraft>()

  save(sessionId: string, draft: InputDraft) {
    this.drafts.set(sessionId, draft)
  }

  load(sessionId: string): InputDraft | undefined {
    return this.drafts.get(sessionId)
  }

  clear(sessionId: string) {
    this.drafts.delete(sessionId)
  }

  /**
   * 是否存在任何未发送的草稿。
   *
   * 自动更新重启前用它做闸门：用户可能停在一轮对话之后正在输入下一条，
   * 此时重启会把未发送的内容一起丢掉。只要还有草稿，就一直等到发出去或清空。
   *
   * 空草稿（没有正文也没有附件）不算：输入框失焦时也会 save 一个空壳，
   * 若把它当成「有内容」就永远等不到重启时机。
   */
  hasAnyDraft(): boolean {
    for (const draft of this.drafts.values()) {
      if (draft.text.trim().length > 0 || draft.attachments.length > 0) return true
    }
    return false
  }
}

export const inputDraftStore = new InputDraftStore()
