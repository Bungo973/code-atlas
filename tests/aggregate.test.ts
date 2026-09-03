import { describe, expect, it } from 'vitest'
import { aggregate, groupOf } from '../src/core/aggregate'

describe('groupOf', () => {
  it.each([
    ['src/core/graph.ts', 1, 'src'],
    ['src/core/graph.ts', 2, 'src/core'],
    ['src/core/graph.ts', 3, 'src/core'],
    ['src/main.tsx', 1, 'src'],
    ['src/main.tsx', 2, 'src'],
    ['vite.config.ts', 1, '(root)'],
    ['vite.config.ts', 9, '(root)'],
    ['packages/a/src/b/c.ts', 2, 'packages/a'],
  ])('%s @ depth %i → %s', (id, depth, expected) => {
    expect(groupOf(id as string, depth as number)).toBe(expected)
  })

  it('depth 超过实际层数时停在文件所在目录，不会把文件名当目录', () => {
    expect(groupOf('src/main.tsx', 99)).toBe('src')
  })
})

describe('aggregate', () => {
  const FILES = [
    'src/core/a.ts',
    'src/core/b.ts',
    'src/ui/c.tsx',
    'tests/a.test.ts',
    'vite.config.ts',
  ]
  const EDGES = [
    { source: 'src/core/b.ts', target: 'src/core/a.ts' },
    { source: 'src/ui/c.tsx', target: 'src/core/a.ts' },
    { source: 'tests/a.test.ts', target: 'src/core/a.ts' },
    { source: 'tests/a.test.ts', target: 'src/core/b.ts' },
    { source: 'vite.config.ts', target: 'src/ui/c.tsx' },
  ]

  it('depth 1 按顶层目录分组，文件数正确', () => {
    const { nodes } = aggregate(FILES, EDGES, 1)
    expect(nodes.map((n) => [n.id, n.files])).toEqual([
      ['src', 3],
      ['(root)', 1],
      ['tests', 1],
    ])
  })

  it('同一对目录之间的多条依赖合并成一条带权重的边', () => {
    const { edges } = aggregate(FILES, EDGES, 1)
    expect(edges.find((e) => e.source === 'tests' && e.target === 'src')?.weight).toBe(2)
  })

  it('组内依赖不产生边，单独计数', () => {
    const { nodes, edges } = aggregate(FILES, EDGES, 1)
    expect(edges.some((e) => e.source === e.target)).toBe(false)
    expect(nodes.find((n) => n.id === 'src')?.internal).toBe(2)
  })

  it('depth 2 把 src 拆开，原来的组内依赖变成跨组边', () => {
    const { nodes, edges } = aggregate(FILES, EDGES, 2)
    expect(nodes.map((n) => n.id).sort()).toEqual(['(root)', 'src/core', 'src/ui', 'tests'])
    expect(edges.find((e) => e.source === 'src/ui' && e.target === 'src/core')?.weight).toBe(1)
    expect(nodes.find((n) => n.id === 'src/core')?.internal).toBe(1)
  })

  it('节点按文件数降序，方便直接读出最大的几块', () => {
    const { nodes } = aggregate(FILES, EDGES, 1)
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].files).toBeGreaterThanOrEqual(nodes[i].files)
    }
  })

  it('端点不在集合里的边被丢弃，隔离视图下会出现', () => {
    const { edges } = aggregate(['src/a.ts'], [{ source: 'src/a.ts', target: 'gone/x.ts' }], 1)
    expect(edges).toEqual([])
  })

  it('守恒：跨组边权重之和 + 组内之和 = 总边数', () => {
    const { nodes, edges } = aggregate(FILES, EDGES, 2)
    const cross = edges.reduce((n, e) => n + e.weight, 0)
    const inside = nodes.reduce((n, g) => n + g.internal, 0)
    expect(cross + inside).toBe(EDGES.length)
  })
})
