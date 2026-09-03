/**
 * 文件筛选。纯函数，侧栏和画布**共用同一份命中判定**。
 *
 * 分开实现的话两边迟早会不一致——侧栏说 3 个匹配、画布亮起 5 个，
 * 而这种偏差没有任何指标会报警。
 *
 * 按目录/扩展名筛选将来也落在这里：筛选和搜索本质是同一个「子集」机制，
 * 只是条件来源不同。
 */

export type MatchSet = Set<string> | null

/**
 * 命中的文件 id 集合。
 *
 * 返回 `null` 表示**没有生效的筛选条件**，和「筛选了但一个都没命中」的空集合
 * 是两回事：前者应该全部正常显示，后者应该全部淡出。渲染层靠这个区分，
 * 所以不能图省事统一返回空集合。
 *
 * 空格分词，词之间是**与**关系：`core graph` 能命中 `src/core/graph.ts`。
 * 路径里本来就有分隔符，逐词匹配比整串子串匹配好用得多。
 */
export function matchFiles(fileIds: string[], query: string): MatchSet {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null

  const out = new Set<string>()
  for (const id of fileIds) {
    const haystack = id.toLowerCase()
    if (terms.every((t) => haystack.includes(t))) out.add(id)
  }
  return out
}

/** 渲染层的统一问法：这个文件在当前筛选下该正常显示吗 */
export function isMatch(matches: MatchSet, id: string): boolean {
  return matches === null || matches.has(id)
}
