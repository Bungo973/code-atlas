/**
 * 可视化配色。
 *
 * 力导向图属于「all-pairs」形态——任意两个颜色都可能相邻，
 * 所以分类色**只能用前 3 个槽位**，第 4 个及以后折叠成 Other。
 * 这不是省事，是 8 个槽位在 all-pairs 下无法同时满足色觉分离下限。
 *
 * 已验证（深色表面 #1a1a19，--pairs all --mode dark）：
 *   亮度带 PASS · 彩度下限 PASS · 色觉分离 ΔE 9.4 PASS
 *   常视分离 ΔE 20.9 PASS · 对比度 ≥3:1 PASS
 */

/** 分类槽位（深色步进）。顺序固定，永不循环使用 */
export const SERIES = ['#3987e5', '#d95926', '#199e70'] as const

/** 第 4 个及以后的目录统一折叠为此色 */
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
  /** 图例条目，按节点数降序；最多 4 条（3 个具名 + Other） */
  legend: { label: string; color: string; count: number }[]
}

/**
 * 按节点数取前 3 个顶层目录着色，其余折叠为 Other。
 * 颜色跟随实体（目录名）而非排名——筛选导致目录消失时，
 * 存活目录的颜色不能被重新分配。
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
