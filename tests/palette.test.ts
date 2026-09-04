import { describe, expect, it } from 'vitest'
import { buildDirColors, OTHER, SERIES, STATUS, SURFACE } from '../src/ui/palette'

describe('目录分类配色', () => {
  it('提供八种不同目录色，保留原前三色，不占用其他或循环状态色', () => {
    expect(SERIES).toHaveLength(8)
    expect(new Set(SERIES).size).toBe(8)
    expect(SERIES.slice(0, 3)).toEqual(['#3987e5', '#d95926', '#199e70'])
    expect(SERIES).not.toContain(OTHER)
    expect(SERIES).not.toContain(STATUS.critical)
  })

  it('八个顶层目录全部具名，不再将后五个合并成灰色', () => {
    const dirs = ['packages', 'docs', 'ssr-testing', 'scripts', 'tests', 'internal', 'play', 'typings']
    const colors = buildDirColors(dirs)
    expect(colors.legend).toHaveLength(8)
    expect(new Set(dirs.map(colors.color)).size).toBe(8)
    expect(colors.legend.every(item => item.count === 1 && item.color !== OTHER)).toBe(true)
    expect(colors.legend.map(item => item.label).sort()).toEqual([...dirs].sort())
  })

  it('按文件数分配颜色，图例与查色使用同一映射', () => {
    const colors = buildDirColors(['packages', 'docs', 'packages', 'ssr-testing', 'packages', 'docs'])
    expect(colors.legend).toEqual([
      { label: 'packages', color: SERIES[0], count: 3 },
      { label: 'docs', color: SERIES[1], count: 2 },
      { label: 'ssr-testing', color: SERIES[2], count: 1 },
    ])
    for (const item of colors.legend) expect(colors.color(item.label)).toBe(item.color)
  })

  it('只将超过八个槽位的目录合并，其他计数和总数正确', () => {
    const dirs = Array.from({ length: 10 }, (_, i) => Array(10 - i).fill(`dir-${i}`) as string[]).flat()
    const colors = buildDirColors(dirs)
    expect(colors.legend).toHaveLength(9)
    expect(colors.legend[8]).toEqual({ label: '其他 2 个目录', color: OTHER, count: 3 })
    expect(colors.color('dir-8')).toBe(OTHER)
    expect(colors.color('dir-9')).toBe(OTHER)
    expect(colors.legend.reduce((sum, item) => sum + item.count, 0)).toBe(dirs.length)
  })

  it('输入遍历顺序不影响同一仓库的颜色分配', () => {
    const dirs = ['c', 'b', 'a', 'd', 'e', 'f', 'g', 'h', 'i', 'c', 'b']
    const original = buildDirColors(dirs)
    const reversed = buildDirColors([...dirs].reverse())
    expect(reversed.legend).toEqual(original.legend)
    for (const dir of dirs) expect(reversed.color(dir)).toBe(original.color(dir))
  })

  it('空仓库没有图例，未知目录使用兜底色', () => {
    const colors = buildDirColors([])
    expect(colors.legend).toEqual([])
    expect(colors.color('unknown')).toBe(OTHER)
  })

  it('目录色在深色画布上至少达到 3:1 对比度', () => {
    const luminance = (hex: string) => {
      const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    }
    for (const color of [...SERIES, OTHER]) {
      expect((luminance(color) + 0.05) / (luminance(SURFACE) + 0.05), color).toBeGreaterThanOrEqual(3)
    }
  })
})
