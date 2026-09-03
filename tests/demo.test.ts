/**
 * 内置示例的端到端测试。
 *
 * 这是全套测试里唯一一个**跑真实代码**的用例：其余用例喂的都是手写的小片段，
 * 这里喂的是本仓库自己的源码，一路走完 scan → extract → resolve → graph。
 *
 * 它同时是示例的护栏。示例只在用户点「看示例」时才执行，平时改坏了没人知道，
 * 而它偏偏是部署后大多数人**唯一**会看到的那条路径。
 */

import { describe, expect, it } from 'vitest'
import { scanDemo } from '../src/adapters/demo'
import { analyze } from '../src/core/analyze'
import { buildGraph, computeMetrics, impactOf } from '../src/core/graph'

const scanned = await scanDemo()
const result = await analyze({
  root: scanned.root,
  files: scanned.files,
  allPaths: scanned.allPaths,
  tsconfigs: scanned.tsconfigs,
})

describe('示例扫描', () => {
  it('扫到了源码文件', () => {
    expect(scanned.files.length).toBeGreaterThan(20)
  })

  it('根是合成的，路径都挂在根下面', () => {
    expect(scanned.root).toBe('/code-atlas')
    for (const f of scanned.files) expect(f.path.startsWith('/code-atlas/')).toBe(true)
  })

  it('收进了 tsconfig —— 少了它别名会被当成外部包（ADR-012）', () => {
    expect(scanned.tsconfigs.some((c) => c.path.endsWith('/tsconfig.json'))).toBe(true)
  })

  it('不打包 package-lock.json', () => {
    expect(scanned.files.some((f) => f.path.includes('package-lock'))).toBe(false)
    expect([...scanned.allPaths].some((p) => p.includes('package-lock'))).toBe(false)
  })

  it('文件内容读得出来', async () => {
    const graphTs = scanned.files.find((f) => f.path.endsWith('/core/graph.ts'))
    expect(graphTs).toBeDefined()
    expect(await graphTs!.read()).toContain('export function impactOf')
  })
})

describe('示例分析结果', () => {
  it('命中率 100% —— 自己的源码解析不了就没脸演示了', () => {
    const { resolved, failed } = result.stats
    const realFailures = Object.values(failed).reduce((a, b) => a + b, 0)
    expect(realFailures).toBe(0)
    expect(resolved).toBeGreaterThan(40)
  })

  it('没有疑似漏配别名', () => {
    expect(result.stats.externalAliasLike).toBe(0)
  })

  it('图是连通的，不是一堆孤岛', () => {
    const g = buildGraph(result.nodes, result.edges)
    const m = computeMetrics(g)
    expect(g.size).toBeGreaterThan(40)
    // 孤岛主要是配置文件和类型声明，不该占多数
    expect(m.islands.length).toBeLessThan(g.order / 2)
  })

  it('main.tsx 是入口点', () => {
    const g = buildGraph(result.nodes, result.edges)
    expect(computeMetrics(g).entryPoints).toContain('src/main.tsx')
  })

  it('core/graph.ts 被 UI 依赖，影响范围分层可见', () => {
    const g = buildGraph(result.nodes, result.edges)
    const impact = impactOf(g, 'src/core/graph.ts', 1)
    expect(impact.reached.size).toBeGreaterThan(0)
    // 演示的卖点就是分层。所有东西都挤在 1 跳的话，这个控件没东西可演示
    expect(impact.farthest).toBeGreaterThan(1)
  })

  it('抽出了导出符号，L2 才有东西可看', () => {
    expect(result.symbols.length).toBeGreaterThan(40)
    expect(result.symbolEdges.length).toBeGreaterThan(40)
  })
})
