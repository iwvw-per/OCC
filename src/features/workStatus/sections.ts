// ============================================
// workStatus sections — 板块元数据
// ============================================
//
// 一份列表同时驱动面板与配置弹窗：板块不可能只存在于面板里而无法开关，
// 也不可能只出现在弹窗里而没有对应实现。
//
// id 会被持久化；改名等于静默重置用户的该项选择。

export const WORK_STATUS_SECTION_IDS = [
  'session',
  'project',
  'turnStats',
  'subagents',
  'backgroundJobs',
  'todos',
  'mcp',
  'pinnedMessages',
] as const

export type WorkStatusSectionId = (typeof WORK_STATUS_SECTION_IDS)[number]

const KNOWN_IDS = new Set<string>(WORK_STATUS_SECTION_IDS)

export function isWorkStatusSectionId(value: unknown): value is WorkStatusSectionId {
  return typeof value === 'string' && KNOWN_IDS.has(value)
}

/** 保留用户选择的顺序，剔除失效 id，并把新增板块追加到末尾 */
export function sanitizeWorkStatusSectionOrder(
  value: readonly string[] | null | undefined,
): WorkStatusSectionId[] {
  const ordered = new Set<WorkStatusSectionId>()
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isWorkStatusSectionId(entry)) ordered.add(entry)
    }
  }
  for (const id of WORK_STATUS_SECTION_IDS) ordered.add(id)
  return [...ordered]
}

/** 存的是隐藏集合而非可见集合：默认全开，新增板块才会自动对所有人可见 */
export function sanitizeWorkStatusHiddenSections(value: unknown): WorkStatusSectionId[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<WorkStatusSectionId>()
  for (const entry of value) {
    if (isWorkStatusSectionId(entry)) seen.add(entry)
  }
  return [...seen]
}

export function isWorkStatusSectionVisible(
  hidden: readonly string[] | null | undefined,
  id: WorkStatusSectionId,
): boolean {
  return !hidden?.includes(id)
}

/** 用 every 而非长度比较，避免遗留的失效 id 把计数撑过当前列表长度 */
export function areAllWorkStatusSectionsHidden(hidden: readonly string[] | null | undefined): boolean {
  return hidden != null && WORK_STATUS_SECTION_IDS.every(id => hidden.includes(id))
}
