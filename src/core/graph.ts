/**
 * 图指标层。纯函数，不依赖渲染库，可单测。
 *
 * 这里算的四个指标直接对应 ADR-005 从 CodeGraph 工具清单借鉴来的功能：
 *   传递入度 → find_hot_paths     （决定节点大小）
 *   循环依赖 → find_circular_deps （图上高亮环）
 *   入口点   → find_entry_points  （「从这里开始看」的导航起点）
 *   影响范围 → analyze_impact     （点击节点高亮 blast radius）
 */

import Graph from 'graphology'
import { stronglyConnectedComponents } from 'graphology-components'
import { basename } from './path'
import type { DepEdge, FileNode } from './types'

export type GraphMetrics = {
  /** 直接入度：多少个文件直接 import 了它 */
  inDegree: Map<string, number>
  /** 传递入度：多少个文件（含间接）最终依赖到它。节点大小用这个，不用 LOC */
  transitiveInDegree: Map<string, number>
  /** 循环依赖：每个环是一组互相可达的节点 id（size > 1 的强连通分量） */
  cycles: string[][]
  /** 参与循环的所有节点，供渲染层 O(1) 判定 */
  inCycle: Set<string>
  /** 入口点：没有任何文件依赖它，且不是孤岛 */
  entryPoints: string[]
  /** 孤岛：既不依赖别人也不被依赖 */
  islands: string[]
}

const ENTRY_NAMES = /^(main|index|app|server|cli|entry|mod)\.[cm]?[jt]sx?$/i

export function buildGraph(nodes: FileNode[], edges: DepEdge[]): Graph {
  const g = new Graph({ type: 'directed', multi: false, allowSelfLoops: true })
  for (const n of nodes) g.mergeNode(n.id, n)
  for (const e of edges) {
    // 只保留两端都在图里的边。target 可能指向被扫描规则排除的文件
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.mergeDirectedEdge(e.source, e.target, { raw: e.raw, kind: e.kind })
    }
  }
  return g
}

/**
 * 传递入度。
 *
 * 用反向 BFS 逐节点算，复杂度 O(V·E)。在 vite 规模（1598 节点 / 2032 边）下
 * 完全够用；如果将来节点数上万再换成基于 SCC 缩点的近似算法。
 * **先测量再优化**——不预先为不存在的规模买单。
 */
function computeTransitiveInDegree(g: Graph): Map<string, number> {
  const result = new Map<string, number>()
  const visited = new Set<string>()
  const queue: string[] = []

  g.forEachNode((node) => {
    visited.clear()
    queue.length = 0
    queue.push(node)
    visited.add(node)

    for (let i = 0; i < queue.length; i++) {
      g.forEachInNeighbor(queue[i], (pred) => {
        if (!visited.has(pred)) {
          visited.add(pred)
          queue.push(pred)
        }
      })
    }
    // 减去自身
    result.set(node, visited.size - 1)
  })

  return result
}

export function computeMetrics(g: Graph): GraphMetrics {
  const inDegree = new Map<string, number>()
  g.forEachNode((node) => inDegree.set(node, g.inDegree(node)))

  const transitiveInDegree = computeTransitiveInDegree(g)

  // 强连通分量中 size > 1 的即为循环依赖；自环单独算
  const cycles: string[][] = []
  for (const comp of stronglyConnectedComponents(g)) {
    if (comp.length > 1) cycles.push(comp)
    else if (g.hasDirectedEdge(comp[0], comp[0])) cycles.push(comp)
  }
  const inCycle = new Set(cycles.flat())

  const entryPoints: string[] = []
  const islands: string[] = []

  g.forEachNode((node) => {
    const inD = g.inDegree(node)
    const outD = g.outDegree(node)
    if (inD === 0 && outD === 0) {
      islands.push(node)
    } else if (inD === 0) {
      entryPoints.push(node)
    }
  })

  // 命名像入口的文件排前面：main.tsx / index.ts / server.ts …
  entryPoints.sort((a, b) => {
    const sa = ENTRY_NAMES.test(basename(a)) ? 0 : 1
    const sb = ENTRY_NAMES.test(basename(b)) ? 0 : 1
    if (sa !== sb) return sa - sb
    return (transitiveInDegree.get(b) ?? 0) - (transitiveInDegree.get(a) ?? 0)
  })

  return { inDegree, transitiveInDegree, cycles, inCycle, entryPoints, islands }
}

export type Impact = {
  /** 起点文件 */
  root: string
  /** 受影响文件 → 跳数。1 = 直接 import 起点。不含起点自身 */
  depth: Map<string, number>
  /** 当前层级上限内到达的文件，供渲染层 O(1) 判定 */
  reached: Set<string>
  /** 不限层级时能到达的总数 */
  total: number
  /** 当前生效的层级上限，Infinity 表示不限 */
  maxDepth: number
  /** 不限层级时最远的跳数 */
  farthest: number
}

export const DEPTH_UNLIMITED = Infinity

/**
 * 影响范围（blast radius）：改动 node 之后，沿反向边可达的全部文件。
 *
 * **必须分层。** 无限传播在强连通的大仓库里没有信息量——excalidraw 的
 * 668 个文件里有一个 346 个节点的强连通分量，只要选中的文件沾上这个分量，
 * 反向可达就直接饱和到 509，几乎每次点击都高亮同一片。跳数才是有区分度的量：
 * 1 跳是「谁直接用我」，2 跳是「改坏了谁会先炸」，全量只适合看总量。
 *
 * 一次 BFS 把**全部**跳数都算出来（复杂度与不分层时相同），层级上限只是筛选，
 * 所以 `total` 始终可得——UI 要能同时说清「这一层有几个」和「一共有几个」，
 * 否则限制层级就变成了瞒报。
 */
export function impactOf(g: Graph, node: string, maxDepth: number = DEPTH_UNLIMITED): Impact {
  const depth = new Map<string, number>()
  const seen = new Set<string>([node])
  let level = [node]
  let d = 0
  let farthest = 0

  while (level.length > 0) {
    d++
    const next: string[] = []
    for (const cur of level) {
      g.forEachInNeighbor(cur, (pred) => {
        if (seen.has(pred)) return
        seen.add(pred)
        depth.set(pred, d)
        next.push(pred)
      })
    }
    if (next.length > 0) farthest = d
    level = next
  }

  const reached = new Set<string>()
  for (const [id, hops] of depth) if (hops <= maxDepth) reached.add(id)

  return { root: node, depth, reached, total: depth.size, maxDepth, farthest }
}

/** 依赖范围：node 直接和间接依赖的全部文件（沿正向边） */
export function dependenciesOf(g: Graph, node: string): Set<string> {
  const seen = new Set<string>([node])
  const queue = [node]
  for (let i = 0; i < queue.length; i++) {
    g.forEachOutNeighbor(queue[i], (succ) => {
      if (!seen.has(succ)) {
        seen.add(succ)
        queue.push(succ)
      }
    })
  }
  seen.delete(node)
  return seen
}

/** 顶层目录，用于着色 */
export function topLevelDir(id: string): string {
  const i = id.indexOf('/')
  return i < 0 ? '(root)' : id.slice(0, i)
}
