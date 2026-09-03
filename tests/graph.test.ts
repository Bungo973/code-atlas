import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  computeMetrics,
  dependenciesOf,
  impactOf,
  topLevelDir,
} from '../src/core/graph'
import type { DepEdge, FileNode } from '../src/core/types'

const node = (id: string): FileNode => ({
  id,
  path: `/repo/${id}`,
  name: id.split('/').pop()!,
  ext: '.ts',
  size: 0,
  loc: 1,
  dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
})

const edge = (source: string, target: string): DepEdge => ({
  source,
  target,
  raw: `./${target}`,
  kind: 'static',
})

function make(ids: string[], links: [string, string][]) {
  return buildGraph(ids.map(node), links.map(([a, b]) => edge(a, b)))
}

describe('buildGraph', () => {
  it('丢弃指向图外节点的边', () => {
    const g = buildGraph([node('a.ts')], [edge('a.ts', 'not-scanned.ts')])
    expect(g.order).toBe(1)
    expect(g.size).toBe(0)
  })

  it('重复边不会产生平行边', () => {
    const g = buildGraph([node('a.ts'), node('b.ts')], [edge('a.ts', 'b.ts'), edge('a.ts', 'b.ts')])
    expect(g.size).toBe(1)
  })
})

describe('传递入度', () => {
  it('链式依赖会累加', () => {
    // a → b → c，c 被 a 和 b 共 2 个文件传递依赖
    const g = make(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
    const m = computeMetrics(g)
    expect(m.transitiveInDegree.get('c')).toBe(2)
    expect(m.transitiveInDegree.get('b')).toBe(1)
    expect(m.transitiveInDegree.get('a')).toBe(0)
  })

  it('直接入度与传递入度会分岔——这正是不能用直接入度做节点大小的理由', () => {
    // a→b, b→d, c→d ：d 直接入度 2，传递入度 3（a 也间接依赖它）
    const g = make(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'd'], ['c', 'd']])
    const m = computeMetrics(g)
    expect(m.inDegree.get('d')).toBe(2)
    expect(m.transitiveInDegree.get('d')).toBe(3)
  })

  it('菱形依赖不重复计数', () => {
    const g = make(
      ['a', 'b', 'c', 'd'],
      [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]
    )
    expect(computeMetrics(g).transitiveInDegree.get('d')).toBe(3)
  })
})

describe('循环依赖', () => {
  it('识别二元环', () => {
    const g = make(['a', 'b'], [['a', 'b'], ['b', 'a']])
    const m = computeMetrics(g)
    expect(m.cycles).toHaveLength(1)
    expect(m.cycles[0].sort()).toEqual(['a', 'b'])
    expect(m.inCycle.has('a')).toBe(true)
  })

  it('识别三元环，且环外节点不被标记', () => {
    const g = make(
      ['a', 'b', 'c', 'x'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'a']]
    )
    const m = computeMetrics(g)
    expect(m.inCycle.size).toBe(3)
    expect(m.inCycle.has('x')).toBe(false)
  })

  it('自环也算循环', () => {
    const g = make(['a'], [['a', 'a']])
    expect(computeMetrics(g).inCycle.has('a')).toBe(true)
  })

  it('无环图不产生误报', () => {
    const g = make(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['a', 'c']])
    expect(computeMetrics(g).cycles).toHaveLength(0)
  })
})

describe('入口点与孤岛', () => {
  it('无人依赖且有出边的是入口点', () => {
    const g = make(['main.ts', 'lib.ts'], [['main.ts', 'lib.ts']])
    const m = computeMetrics(g)
    expect(m.entryPoints).toEqual(['main.ts'])
    expect(m.islands).toEqual([])
  })

  it('无入无出的是孤岛，不算入口点', () => {
    const g = make(['a', 'b', 'lonely'], [['a', 'b']])
    const m = computeMetrics(g)
    expect(m.islands).toEqual(['lonely'])
    expect(m.entryPoints).not.toContain('lonely')
  })

  it('命名像入口的文件排在前面', () => {
    const g = make(
      ['zzz.ts', 'src/main.tsx', 'lib.ts'],
      [['zzz.ts', 'lib.ts'], ['src/main.tsx', 'lib.ts']]
    )
    expect(computeMetrics(g).entryPoints[0]).toBe('src/main.tsx')
  })
})

describe('影响范围与依赖范围', () => {
  const g = make(
    ['app', 'page', 'util', 'unrelated'],
    [['app', 'page'], ['page', 'util']]
  )

  it('impactOf 沿反向边：改 util 会波及 page 和 app', () => {
    expect([...impactOf(g, 'util').reached].sort()).toEqual(['app', 'page'])
  })

  it('dependenciesOf 沿正向边：app 依赖 page 和 util', () => {
    expect([...dependenciesOf(g, 'app').reached].sort()).toEqual(['page', 'util'])
  })

  it('不包含自身，不波及无关节点', () => {
    const r = impactOf(g, 'util').reached
    expect(r.has('util')).toBe(false)
    expect(r.has('unrelated')).toBe(false)
  })

  it('环中节点不会导致无限循环', () => {
    const cyc = make(['a', 'b'], [['a', 'b'], ['b', 'a']])
    expect([...impactOf(cyc, 'a').reached]).toEqual(['b'])
  })
})

describe('影响范围的层级', () => {
  // d → c → b → a：a 被改动，波及面沿反向边逐跳扩散
  const chain = make(['a', 'b', 'c', 'd'], [['b', 'a'], ['c', 'b'], ['d', 'c']])

  it('跳数是最短反向路径长度', () => {
    const r = impactOf(chain, 'a')
    expect(r.depth.get('b')).toBe(1)
    expect(r.depth.get('c')).toBe(2)
    expect(r.depth.get('d')).toBe(3)
  })

  it('起点自身不在跳数表里', () => {
    expect(impactOf(chain, 'a').depth.has('a')).toBe(false)
  })

  it('限层只影响 reached，不影响 total —— 限了层也要能说出总数', () => {
    const r = impactOf(chain, 'a', 2)
    expect([...r.reached].sort()).toEqual(['b', 'c'])
    expect(r.total).toBe(3)
    expect(r.farthest).toBe(3)
  })

  it('层级上限大于实际深度时，reached 等于 total', () => {
    const r = impactOf(chain, 'a', 99)
    expect(r.reached.size).toBe(r.total)
  })

  it('默认不限层级', () => {
    expect(impactOf(chain, 'a').reached.size).toBe(3)
  })

  it('多条路径取最短的那条跳数', () => {
    // hub 既直接依赖 a，又经 mid 间接依赖 a
    const g2 = make(['a', 'mid', 'hub'], [['mid', 'a'], ['hub', 'a'], ['hub', 'mid']])
    expect(impactOf(g2, 'a').depth.get('hub')).toBe(1)
  })

  it('环里的节点跳数有限，且 1 跳只拿到直接引用方', () => {
    // a ↔ b 互相引用，c 引用 b
    const cyc = make(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['c', 'b']])
    const r = impactOf(cyc, 'b', 1)
    expect([...r.reached].sort()).toEqual(['a', 'c'])
    expect(r.total).toBe(2)
  })

  it('孤岛的影响范围为空', () => {
    const r = impactOf(chain, 'd')
    expect(r.total).toBe(0)
    expect(r.farthest).toBe(0)
  })
})

describe('topLevelDir', () => {
  it.each([
    ['src/core/graph.ts', 'src'],
    ['packages/vite/x.ts', 'packages'],
    ['vite.config.ts', '(root)'],
  ])('%s → %s', (id, expected) => {
    expect(topLevelDir(id)).toBe(expected)
  })
})

/**
 * I-09：只有「谁依赖它」时，从入口点出发永远是 0，用户卡在「0 个文件受影响」上——
 * 而入口点恰恰是最该用来往下读的起点。两个方向必须对称可用。
 */
describe('关系方向', () => {
  // d → c → b → a
  const chain = make(['a', 'b', 'c', 'd'], [['b', 'a'], ['c', 'b'], ['d', 'c']])

  it('默认是 dependents，结果里带方向标记', () => {
    const r = impactOf(chain, 'b')
    expect(r.direction).toBe('dependents')
    expect([...r.reached].sort()).toEqual(['c', 'd'])
  })

  it('dependencies 沿正向边，跳数语义一致', () => {
    const r = dependenciesOf(chain, 'c')
    expect(r.direction).toBe('dependencies')
    expect(r.depth.get('b')).toBe(1)
    expect(r.depth.get('a')).toBe(2)
  })

  it('两个方向互为镜像：a 在 b 的下游，b 就在 a 的上游', () => {
    expect(impactOf(chain, 'a').reached.has('d')).toBe(true)
    expect(dependenciesOf(chain, 'd').reached.has('a')).toBe(true)
  })

  it('入口点的影响范围为空，但依赖范围不空', () => {
    expect(impactOf(chain, 'd').total).toBe(0)
    expect(dependenciesOf(chain, 'd').total).toBe(3)
  })

  it('限层对两个方向同样生效', () => {
    const r = dependenciesOf(chain, 'd', 1)
    expect([...r.reached]).toEqual(['c'])
    expect(r.total).toBe(3)
  })
})
