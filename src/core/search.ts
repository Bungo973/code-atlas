/**
 * 文件筛选。纯函数，侧栏和画布**共用同一份命中判定**。
 *
 * 分开实现的话两边迟早会不一致——侧栏说 3 个匹配、画布亮起 5 个，
 * 而这种偏差没有任何指标会报警。
 *
 * 搜索、按目录筛、按扩展名筛本质是同一个「子集」机制，只是条件来源不同，
 * 所以它们共用一个 FileFilter，而不是各做各的。
 */

import { extname, topLevelDir } from './path'

export type MatchSet = Set<string> | null

export type FileFilter = {
  /** 路径搜索，空格分词 */
  query: string
  /** 顶层目录名，如 `src`、`packages`、`(root)` */
  dirs: string[]
  /** 扩展名，带点，如 `.ts`、`.d.ts` */
  exts: string[]
}

export const EMPTY_FILTER: FileFilter = { query: '', dirs: [], exts: [] }

export function isFilterActive(f: FileFilter): boolean {
  return f.query.trim().length > 0 || f.dirs.length > 0 || f.exts.length > 0
}

/** 当前生效了几个条件，用于在折叠状态下显示个数 */
export function activeFacetCount(f: FileFilter): number {
  return (f.query.trim() ? 1 : 0) + f.dirs.length + f.exts.length
}

/**
 * 命中的文件 id 集合。
 *
 * 返回 `null` 表示**没有生效的筛选条件**，和「筛选了但一个都没命中」的空集合
 * 是两回事：前者应该全部正常显示，后者应该全部淡出。渲染层靠这个区分，
 * 所以不能图省事统一返回空集合。
 *
 * 语义：**同类条件之间是「或」，不同类之间是「与」**。
 * 勾了 `src` 和 `tests` 两个目录是「这两个目录里的」；再勾 `.tsx`
 * 就变成「这两个目录里的 .tsx 文件」。这是分面筛选的通行约定——
 * 同类取并集是在放宽，跨类取交集是在收紧，两者方向相反才好用。
 */
export function applyFilter(fileIds: string[], f: FileFilter): MatchSet {
  if (!isFilterActive(f)) return null

  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  const dirs = new Set(f.dirs)
  const exts = new Set(f.exts)

  const out = new Set<string>()
  for (const id of fileIds) {
    if (dirs.size > 0 && !dirs.has(topLevelDir(id))) continue
    if (exts.size > 0 && !exts.has(extname(id))) continue
    if (terms.length > 0) {
      const haystack = id.toLowerCase()
      if (!terms.every((t) => haystack.includes(t))) continue
    }
    out.add(id)
  }
  return out
}

/**
 * 只按搜索词筛。
 * 保留独立入口是因为它在概念上是「搜索」而不是「筛选」，
 * 而且单测直接打它比构造整个 FileFilter 清楚。
 */
export function matchFiles(fileIds: string[], query: string): MatchSet {
  return applyFilter(fileIds, { ...EMPTY_FILTER, query })
}

/** 渲染层的统一问法：这个文件在当前筛选下该正常显示吗 */
export function isMatch(matches: MatchSet, id: string): boolean {
  return matches === null || matches.has(id)
}

export type Facet = { value: string; count: number }

/**
 * 从文件列表里算出可选的筛选项，各自按文件数降序。
 *
 * **只列真实存在的**：给 excalidraw 显示一个 `.vue` 选项，或者给一个纯 TS 项目
 * 显示 `.jsx`，都是在让用户点一个必然筛出 0 个结果的按钮。
 */
export function facetsOf(fileIds: string[]): { dirs: Facet[]; exts: Facet[] } {
  const dirs = new Map<string, number>()
  const exts = new Map<string, number>()

  for (const id of fileIds) {
    const d = topLevelDir(id)
    dirs.set(d, (dirs.get(d) ?? 0) + 1)
    const e = extname(id)
    if (e) exts.set(e, (exts.get(e) ?? 0) + 1)
  }

  const rank = (m: Map<string, number>): Facet[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

  return { dirs: rank(dirs), exts: rank(exts) }
}

/** 切换一个筛选项的选中状态 */
export function toggleFacet(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}
