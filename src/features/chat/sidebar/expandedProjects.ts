// ============================================
// 项目行展开状态的合并
//
// 存储是全局单键（opencode-sidebar-expanded-projects），但项目列表按服务器
// 分区（每台服务器各自的 saved-directories）。因此写回时不能整体覆盖：切到
// B 服务器后写回会把 A 的展开项清掉，切回 A 时表现为「全部收起」；反之若不
// 区分新旧项目，切换服务器时整份列表都像「新增」，于是「全部展开」。
//
// 这里只替换「属于当前服务器」的那部分键，保留其它服务器的展开项。
// 键是 `serverId::项目名`（见 utils/projectExpandKeys），因此两台主机上的
// 同名项目不会再被当成同一项。
// ============================================

export function mergeExpandedProjectNames(
  storedNames: string[],
  currentServerNames: string[],
  nextServerNames: string[],
): string[] {
  const currentSet = new Set(currentServerNames)
  const otherNames = storedNames.filter(name => !currentSet.has(name))
  return [...otherNames, ...nextServerNames]
}
