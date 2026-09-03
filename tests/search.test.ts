import { describe, expect, it } from 'vitest'
import { isMatch, matchFiles } from '../src/core/search'

const FILES = [
  'src/core/graph.ts',
  'src/core/tree.ts',
  'src/ui/GraphCanvas.tsx',
  'tests/graph.test.ts',
  'README.md',
]

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
    // 「graph」单独会命中 3 个，加上「core」只剩 1 个
    expect(matchFiles(FILES, 'graph')?.size).toBe(3)
    expect(matchFiles(FILES, 'core graph')).toEqual(new Set(['src/core/graph.ts']))
  })

  it('分词顺序无关', () => {
    expect(matchFiles(FILES, 'graph core')).toEqual(matchFiles(FILES, 'core graph'))
  })

  it('多余空格不影响结果', () => {
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
