// ============================================
// 项目行展开状态的存储键
// ============================================
//
// 格式：`${serverId}::${项目名}`。
//
// 为什么必须带 serverId：展开状态是全局单键（opencode-sidebar-expanded-projects），
// 而项目列表按服务器分桶。只存项目名时，两台主机上同名的项目（比如都叫 "OCC"）
// 会共用一份状态 —— 在 A 上展开，B 上的同名项目也跟着展开、一起收起。
// 加上 serverId 后各主机互不影响，同时仍能跨设备同步（aiagent 实例的 serverId
// 由面板下发，在各端一致）。
//
// 旧版本只存裸项目名。裸名无法判断属于哪台主机；升级时用户正在使用的主机
// 是最合理的归属，因此 adoptLegacyProjectExpandKeys 把它归给当前活动主机。
// ============================================

const SEPARATOR = '::'

/** 合成某台主机上某个项目的展开键。 */
export function makeProjectExpandKey(serverId: string, projectName: string): string {
  return `${serverId}${SEPARATOR}${projectName}`
}

/**
 * 是否已是带主机前缀的键。
 *
 * 旧版数据只有项目名，不含分隔符。项目名里出现 `::` 属于极端情况，
 * 即便误判也只是迁移时不再给它补前缀（结果是不匹配任何项目），不会串到别的
 * 主机上。
 */
export function isScopedProjectExpandKey(value: string): boolean {
  return value.includes(SEPARATOR)
}

/**
 * 把旧版裸项目名归到指定主机，并去重、保序。
 *
 * 只用于迁移：新写入的值一律由 makeProjectExpandKey 生成。
 */
export function adoptLegacyProjectExpandKeys(values: readonly string[], serverId: string): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value) continue
    const key = isScopedProjectExpandKey(value) ? value : makeProjectExpandKey(serverId, value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

/**
 * 迁移并报告是否发生变化，供调用方决定要不要回写存储。
 *
 * 迁移必须是幂等的：已带前缀的值原样保留，重复执行不会叠加前缀。
 */
export function migrateProjectExpandKeys(
  values: readonly string[],
  serverId: string,
): { values: string[]; changed: boolean } {
  const migrated = adoptLegacyProjectExpandKeys(values, serverId)
  const changed =
    migrated.length !== values.length || migrated.some((value, index) => value !== values[index])
  return { values: migrated, changed }
}
