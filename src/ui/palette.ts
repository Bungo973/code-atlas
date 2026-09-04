/**
 * 可视化配色。
 *
 * 扩为 8 个目录槽位，减少不同目录折叠为灰色的情况，保留原有前三色。
 * 色板针对深色画布选择；颜色只是辅助，目录身份仍由图例和文件路径说明。
 * 不把更多颜色等同于所有色觉条件下都能区分；循环状态仍单独使用红色描边。
 */

/** 分类槽位（深色步进）。顺序固定，永不循环使用 */
export const SERIES = [
  '#3987e5', // 蓝
  '#d95926', // 橙
  '#199e70', // 绿
  '#a78bfa', // 紫
  '#d6b75a', // 金
  '#48b8c4', // 青
  '#d685aa', // 粉
  '#9caab8', // 蓝灰
] as const

/** 超出分类槽位的目录统一折叠为此色 */
export const OTHER = '#898781'

export const SURFACE = '#1a1a19'
/** 选中/影响范围的强调色，与分类槽位 1 同源 */
export const ACCENT = '#3987e5'
export const PLANE = '#0d0d0d'
export const INK = '#ffffff'
export const INK_2 = '#c3c2b7'
export const INK_MUTED = '#898781'
export const HAIRLINE = '#2c2c2a'

/** 状态色，固定不参与分类。循环依赖用 critical */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

export type DirColorMap = {
  /** 顶层目录 → 颜色 */
  color: (dir: string) => string
  /** 图例条目，按节点数降序；最多 9 条（8 个具名 + Other） */
  legend: { label: string; color: string; count: number }[]
}

/**
 * 按全仓库文件数取前 8 个顶层目录着色，其余折叠为 Other。
 * App 为每份分析结果分配一次映射；筛选和聚合复用映射，不重新排名换色。
 */
export function buildDirColors(dirs: string[]): DirColorMap {
  const counts = new Map<string, number>()
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1)

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const named = ranked.slice(0, SERIES.length)
  const rest = ranked.slice(SERIES.length)

  const assigned = new Map<string, string>()
  named.forEach(([dir], i) => assigned.set(dir, SERIES[i]))

  const legend: { label: string; color: string; count: number }[] = named.map(
    ([label, count], i) => ({ label, color: SERIES[i] as string, count })
  )
  if (rest.length > 0) {
    legend.push({
      label: `其他 ${rest.length} 个目录`,
      color: OTHER,
      count: rest.reduce((s, [, c]) => s + c, 0),
    })
  }

  return { color: (dir) => assigned.get(dir) ?? OTHER, legend }
}
