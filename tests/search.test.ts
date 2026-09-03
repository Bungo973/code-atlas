import { describe, expect, it } from 'vitest'
import {
  activeFacetCount,
  applyFilter,
  EMPTY_FILTER,
  facetsOf,
  isFilterActive,
  isMatch,
  matchFiles,
  toggleFacet,
} from '../src/core/search'

const FILES = [
  'src/core/graph.ts',
  'src/core/tree.ts',
  'src/ui/GraphCanvas.tsx',
  'src/types/fsa.d.ts',
  'tests/graph.test.ts',
  'vite.config.ts',
  'README.md',
]

const f = (over: Partial<typeof EMPTY_FILTER>) => ({ ...EMPTY_FILTER, ...over })

describe('matchFiles', () => {
  it('空查询返回 null，不是空集合', () => {
    expect(matchFiles(FILES, '')).toBeNull()
    expect(matchFiles(FILES, '   ')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(matchFiles(FILES, 'graphcanvas')).toEqual(new Set(['src/ui/GraphCanvas.tsx']))
  })

  it('匹配整条路径，不只是文件名', () => {
    expect(matchFiles(FILES, 'ui/')).toEqual(new Set(['src/ui/GraphCanvas.tsx']))
  })

  it('空格分词，词之间是与关系', () => {
    expect(matchFiles(FILES, 'graph')?.size).toBe(3)
    expect(matchFiles(FILES, 'core graph')).toEqual(new Set(['src/core/graph.ts']))
  })

  it('分词顺序无关，多余空格无影响', () => {
    expect(matchFiles(FILES, 'graph core')).toEqual(matchFiles(FILES, 'core graph'))
    expect(matchFiles(FILES, '  core   graph  ')).toEqual(matchFiles(FILES, 'core graph'))
  })

  it('一个都没命中时返回空集合，不是 null —— 渲染层靠这个区分', () => {
    const r = matchFiles(FILES, 'zzz')
    expect(r).not.toBeNull()
    expect(r?.size).toBe(0)
  })
})

describe('isMatch', () => {
  it('null 表示没在筛选，一律算命中', () => {
    expect(isMatch(null, 'anything')).toBe(true)
  })

  it('空集合表示筛了但没命中，一律算不命中', () => {
    expect(isMatch(new Set(), 'src/core/graph.ts')).toBe(false)
  })

  it('集合内为命中', () => {
    const m = new Set(['src/core/graph.ts'])
    expect(isMatch(m, 'src/core/graph.ts')).toBe(true)
    expect(isMatch(m, 'src/core/tree.ts')).toBe(false)
  })
})

describe('分面筛选：同类取并集，跨类取交集', () => {
  it('没有任何条件时返回 null', () => {
    expect(applyFilter(FILES, EMPTY_FILTER)).toBeNull()
    expect(isFilterActive(EMPTY_FILTER)).toBe(false)
  })

  it('单个目录', () => {
    expect(applyFilter(FILES, f({ dirs: ['tests'] }))).toEqual(new Set(['tests/graph.test.ts']))
  })

  it('根目录下的文件归到 (root)', () => {
    expect(applyFilter(FILES, f({ dirs: ['(root)'] }))).toEqual(
      new Set(['vite.config.ts', 'README.md'])
    )
  })

  it('两个目录之间是「或」——勾得越多结果越宽', () => {
    const one = applyFilter(FILES, f({ dirs: ['tests'] }))!
    const two = applyFilter(FILES, f({ dirs: ['tests', 'src'] }))!
    expect(two.size).toBeGreaterThan(one.size)
    expect([...one].every((id) => two.has(id))).toBe(true)
  })

  it('扩展名能区分 .ts 和 .tsx', () => {
    expect(applyFilter(FILES, f({ exts: ['.tsx'] }))).toEqual(new Set(['src/ui/GraphCanvas.tsx']))
  })

  it('.d.ts 是独立的扩展名，不会被当成 .ts', () => {
    const ts = applyFilter(FILES, f({ exts: ['.ts'] }))!
    expect(ts.has('src/types/fsa.d.ts')).toBe(false)
    expect(applyFilter(FILES, f({ exts: ['.d.ts'] }))).toEqual(new Set(['src/types/fsa.d.ts']))
  })

  it('目录与扩展名之间是「与」——勾得越多结果越窄', () => {
    const dirOnly = applyFilter(FILES, f({ dirs: ['src'] }))!
    const both = applyFilter(FILES, f({ dirs: ['src'], exts: ['.tsx'] }))!
    expect(both.size).toBeLessThan(dirOnly.size)
    expect([...both].every((id) => dirOnly.has(id))).toBe(true)
  })

  it('搜索词与分面同时生效', () => {
    expect(applyFilter(FILES, f({ dirs: ['src'], query: 'tree' }))).toEqual(
      new Set(['src/core/tree.ts'])
    )
  })

  it('条件互斥时是空集合，不是 null', () => {
    const r = applyFilter(FILES, f({ dirs: ['tests'], exts: ['.tsx'] }))
    expect(r).not.toBeNull()
    expect(r?.size).toBe(0)
  })
})

describe('facetsOf', () => {
  it('只列真实存在的目录和扩展名', () => {
    const { dirs, exts } = facetsOf(FILES)
    expect(dirs.map((d) => d.value)).toEqual(['src', '(root)', 'tests'])
    expect(exts.map((e) => e.value)).toContain('.tsx')
    expect(exts.map((e) => e.value)).not.toContain('.vue')
  })

  it('按文件数降序', () => {
    const { dirs } = facetsOf(FILES)
    expect(dirs[0]).toEqual({ value: 'src', count: 4 })
    for (let i = 1; i < dirs.length; i++) {
      expect(dirs[i - 1].count).toBeGreaterThanOrEqual(dirs[i].count)
    }
  })

  it('每个分面的计数与实际筛出来的数量一致', () => {
    // 图例、分面按钮、筛选结果三处的数字必须对得上，否则又是 ADR-013 那类问题
    for (const d of facetsOf(FILES).dirs) {
      expect(applyFilter(FILES, f({ dirs: [d.value] }))?.size).toBe(d.count)
    }
  })
})

describe('toggleFacet 与计数', () => {
  it('未选中则加入，已选中则移除', () => {
    expect(toggleFacet([], 'src')).toEqual(['src'])
    expect(toggleFacet(['src', 'tests'], 'src')).toEqual(['tests'])
  })

  it('activeFacetCount 把搜索词算作一个条件', () => {
    expect(activeFacetCount(EMPTY_FILTER)).toBe(0)
    expect(activeFacetCount(f({ query: 'a' }))).toBe(1)
    expect(activeFacetCount(f({ query: '   ' }))).toBe(0)
    expect(activeFacetCount(f({ query: 'a', dirs: ['src'], exts: ['.ts', '.tsx'] }))).toBe(4)
  })
})
