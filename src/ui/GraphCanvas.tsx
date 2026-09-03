/**
 * 画布 —— 依赖图图幅（plate）。区域词汇见 docs/UI-VOCABULARY.md。
 *
 * 视觉编码：
 *   节点大小 = 传递入度（不用 LOC，见 ADR-005）
 *   节点颜色 = 顶层目录，前 3 个具名 + 其他（all-pairs 形态的色觉分离上限，ADR-011）
 *   红色描边 = 循环依赖（状态色配描边作二级编码，不靠颜色单独承载语义）
 *
 * 右下角是位置索引图（locator）：全图缩略 + 当前视口矩形，点击即可跳转。
 */

import { forceCollide, forceX, forceY } from 'd3-force'
import type Graph from 'graphology'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import type { Direction, GraphMetrics, Impact } from '../core/graph'
import { aggregate } from '../core/aggregate'
import { DEPTH_UNLIMITED, topLevelDir } from '../core/graph'
import { isMatch, type MatchSet } from '../core/search'
import type { FileNode } from '../core/types'
import { ACCENT, HAIRLINE, INK, STATUS, SURFACE } from './palette'

type CanvasNode = {
  id: string
  name: string
  dir: string
  color: string
  /** 绘制半径（像素）。预先算好，碰撞力和命中区域都直接用它 */
  r: number
  /** 直接入度：多少个文件直接 import 它。决定节点大小 */
  direct: number
  /**
   * 出度：它自己 import 了几个仓库内的文件。
   *
   * 这里**故意不放传递入度**。它在强连通的大仓库里会饱和（excalidraw 上几乎
   * 每个文件都是 509），悬停时挂一个几乎恒定的数字既没信息量，又和详情栏里
   * 分层后的影响范围互相打架。入度配出度才是这个圆的局部形状。见 ADR-021。
   */
  out: number
  loc: number
  inCycle: boolean
  /** 聚合模式下这个节点代表一个目录，不是一个文件 */
  isGroup: boolean
  /** 组内文件数（聚合模式）。文件节点恒为 1 */
  files: number
  /** 组内部的依赖条数（聚合模式）。目录内部 300 条和 3 条是完全不同的东西 */
  internal: number
  x?: number
  y?: number
}

type CanvasLink = {
  source: string | CanvasNode
  target: string | CanvasNode
  /** 聚合模式下：这条目录间依赖由多少条文件级依赖构成 */
  weight: number
}

const LOCATOR_W = 156
const LOCATOR_H = 108

/**
 * 聚合粒度。0 = 不聚合，看文件本身。
 *
 * 超过 200 个节点，力导向图就只剩「这仓库很大」一个信息了，
 * 所以大仓库默认从目录级看起——先看 15 个，再钻进去。
 */
const GRAIN_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '文件' },
  { value: 1, label: '1 层' },
  { value: 2, label: '2 层' },
  { value: 3, label: '3 层' },
]

/** 超过这个规模，文件级视图不再有可读性，默认折叠到目录 */
const GRAIN_AUTO_THRESHOLD = 200

/**
 * 没有拴在主体上的节点：不属于**最大弱连通分量**的那些。
 *
 * 判据不能是「有没有边」——两个互相连接、但不连到主体的点，
 * 在布局上和一个孤立点是完全同一类东西。
 * 也不能用 metrics 里的全仓库口径：连通性必须按**当前画面上的边**算，
 * 隔离和聚合都会改变它。
 */
function detachedOf(
  nodes: { id: string }[],
  edges: { source: string; target: string }[]
): Set<string> {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.source)?.push(e.target)
    adj.get(e.target)?.push(e.source)
  }

  const seen = new Set<string>()
  let biggest: string[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    const comp: string[] = []
    const queue = [n.id]
    seen.add(n.id)
    for (let i = 0; i < queue.length; i++) {
      comp.push(queue[i])
      for (const next of adj.get(queue[i]) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    if (comp.length > biggest.length) biggest = comp
  }

  const main = new Set(biggest)
  return new Set(nodes.map((n) => n.id).filter((id) => !main.has(id)))
}

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: 'dependents', label: '谁依赖它' },
  { value: 'dependencies', label: '它依赖谁' },
]

const DEPTH_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 跳' },
  { value: 2, label: '2 跳' },
  { value: 3, label: '3 跳' },
  { value: DEPTH_UNLIMITED, label: '全部' },
]

/**
 * 取景用的稳健包围盒：丢掉最外侧 1.5% 的点。
 *
 * 「排除孤岛」只解决了一半——**只有一两条边的叶子节点同样会被斥力甩很远**，
 * 而它们是有连线的，排除不掉。与其逐类去猜谁是离群点，不如直接按分位数裁：
 * 个别枝杈不该决定整图的缩放级别。
 *
 * 裁 1.5% 而不是更多：真实存在的独立小簇只要超过总量的 1.5% 就仍然会被框进去，
 * 不会因为「看起来在外面」就被裁掉。
 */
function coreBoxFilter(
  nodes: CanvasNode[],
  linked: Set<string>
): ((n: CanvasNode) => boolean) | null {
  const pts = nodes.filter((n) => linked.has(n.id) && n.x != null && n.y != null)
  if (pts.length < 12) return null

  const xs = pts.map((p) => p.x!).sort((a, b) => a - b)
  const ys = pts.map((p) => p.y!).sort((a, b) => a - b)
  const at = (arr: number[], t: number) =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * t)))]

  const x0 = at(xs, 0.015)
  const x1 = at(xs, 0.985)
  const y0 = at(ys, 0.015)
  const y1 = at(ys, 0.985)

  return (n) =>
    linked.has(n.id) &&
    n.x != null &&
    n.y != null &&
    n.x >= x0 &&
    n.x <= x1 &&
    n.y >= y0 &&
    n.y <= y1
}

/** 跳数越远越淡，让「先炸的」和「最终波及的」在一张图上分得开 */
const RING_ALPHA = [1, 1, 0.72, 0.5]
const ringAlpha = (hops: number) => RING_ALPHA[Math.min(hops, RING_ALPHA.length - 1)]

/**
 * 两种淡化不是同一件事，所以不能用同一个透明度。
 *
 * **筛掉的**（搜索没命中）＝「这不是你要找的」，应该几乎消失，只留一点位置感；
 * **失焦的**（不在影响范围内）＝「它仍然是这张图的一部分」，必须看得见结构，
 * 否则一选中就等于把图删了。
 *
 * 两者叠加时取更狠的那个：筛选是硬条件，聚焦是软强调。
 */
const ALPHA_FILTERED = 0.08
const ALPHA_UNFOCUSED = 0.28

/**
 * 模拟要跑够收敛所需的帧数。
 *
 * 这个数不能拍脑袋定，它由 alphaDecay 决定：alpha 从 1 衰减到 d3 的默认下限
 * 0.001 需要 `ln(0.001) / ln(1 - 0.035) ≈ 194` 帧。
 * 原来写的 120 **在收敛前就停了**——大图上那些只有一两条边的叶子节点
 * 还在往回飞的半路上就被定格，于是画面上留下一根根长刺，
 * 而取景又必须把这些刺框进去，核心结构就被压成中间一小坨。
 *
 * 小图看不出来（几十个节点几十帧就稳了），所以内置示例上一直是好的。
 */
const COOLDOWN_TICKS = 200

/** 自动取景允许的最大缩放。少量节点时宁可留白，也不要一个填满屏幕的巨圆 */
const MAX_AUTO_ZOOM = 4

export function GraphCanvas({
  graph,
  metrics,
  nodes,
  selected,
  onSelect,
  impact,
  depth,
  onDepthChange,
  direction,
  onDirectionChange,
  matches,
  onDrillDown,
  colorOf,
  legend,
}: {
  graph: Graph
  metrics: GraphMetrics
  nodes: FileNode[]
  selected: string | null
  onSelect: (id: string | null) => void
  impact: Impact | null
  depth: number
  onDepthChange: (d: number) => void
  direction: Direction
  onDirectionChange: (d: Direction) => void
  /** 搜索命中集合，与侧栏共用同一份判定（core/search.ts）。null = 没在筛选 */
  matches: MatchSet
  /** 从聚合视图点进一个目录：由 App 改筛选条件，画布只负责发出意图 */
  onDrillDown: (dir: string) => void
  colorOf: (id: string) => string
  legend: { label: string; color: string; count: number }[]
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const locatorRef = useRef<HTMLCanvasElement>(null)
  const fgRef = useRef<ForceGraphMethods<CanvasNode, CanvasLink> | undefined>(undefined)
  /** 位置索引图的图坐标 → 索引图坐标变换，点击时用来反算 */
  const locatorTf = useRef<{ minX: number; minY: number; s: number; ox: number; oy: number } | null>(
    null
  )
  const frame = useRef(0)

  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hovered, setHovered] = useState<CanvasNode | null>(null)
  /**
   * 提示框跟随光标。
   *
   * 位置**必须始终记录在 ref 里**，不能只在悬停时记录——否则从空白处移到节点上的那一刻，
   * 位置还是初始的 {0,0}，提示框会渲染在画布左上角。ref 每次移动都更新（不触发重渲染），
   * state 只在悬停中更新。
   */
  const pointerRef = useRef({ x: 0, y: 0 })
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const hoveredRef = useRef(false)
  const [showCycles, setShowCycles] = useState(true)
  /**
   * 已经为哪一份数据自动适应过窗口。
   *
   * 存的是 data 的**引用**而不是布尔值：换仓库时 data 换身份，自动重置；
   * 而拖动节点、悬停这些会让引擎重新收敛的操作不会换身份，也就不会再次自动缩放——
   * **用户手动调过的视角不能被抢走**。
   */
  const fittedFor = useRef<unknown>(null)
  /**
   * 隔离视图：只把筛选命中的节点交给力导向图，重新布局。
   *
   * 淡化解决不了毛线球——被调暗的节点仍然参与布局，命中项照样散落在
   * 668 个点的乱麻里。**要让子集变清楚，必须让它自己重新收敛。**
   */
  const [isolate, setIsolate] = useState(false)
  /** 聚合粒度：0 = 文件级，1/2 = 折叠到第 N 层目录 */
  const [grain, setGrain] = useState(0)

  /**
   * 大仓库默认从目录级看起。
   *
   * 和「循环占比过高就默认关掉红圈」是同一条纪律：**默认值要让第一眼是可读的**，
   * 而不是把「这张图没法看」的成本转嫁给用户去找按钮。
   */
  useEffect(() => {
    setGrain(nodes.length > GRAIN_AUTO_THRESHOLD ? 1 : 0)
  }, [nodes])

  /**
   * 聚合态下选中一个文件时，自动切回文件级。
   *
   * 不做的话：详情栏更新了，侧栏定位了，**而画布上根本不存在这个节点**——
   * data.nodes 装的是目录，find(n => n.id === selected) 必然落空。
   * 「焦点对象必须可见」是最底线的一条，宁可换视图也不能只更新半边（I-01）。
   */
  useEffect(() => {
    if (selected) setGrain(0)
  }, [selected])

  /**
   * 筛选清空时自动退出隔离。
   * 不做的话用户点了「清空」会得到一张空画布，然后完全不知道发生了什么。
   */
  useEffect(() => {
    if (!matches) setIsolate(false)
  }, [matches])

  /**
   * 循环依赖占比过高时（excalidraw 是 346/668），给一半以上的节点画红圈
   * 等于没有标注，只剩噪音。这种情况默认关掉，用户想看再自己打开。
   */
  useEffect(() => {
    const share = metrics.inCycle.size / Math.max(graph.order, 1)
    setShowCycles(share <= 0.25)
  }, [metrics, graph])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: Math.max(280, r.width), h: Math.max(280, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const data = useMemo(() => {
    const shown = isolate && matches ? matches : null
    const present = nodes.filter((n) => graph.hasNode(n.id) && (!shown || shown.has(n.id)))

    /**
     * 节点大小改用**直接入度**，且半径映射到固定像素区间。
     *
     * 传递入度在强连通的大仓库里会饱和——excalidraw 的 668 个文件里几乎每个的
     * 传递入度都是 509 上下，既没有区分度，`1+√509≈23.6` 再乘 1.5 得到 35px 半径，
     * 668 个这么大的圆必然糊成一团。
     *
     * 直接入度不饱和，且「多少人直接 import 我」本来就是「枢纽」的字面含义。
     * 再按**当前视图**的最大值归一化，半径恒定落在 [2.5, 11]px——
     * 隔离时按子集重新归一化是有意的：全仓库的最大值会把子集里的差异压平。
     * 入度本身仍然是全仓库口径（「10 个文件 import 我」是客观事实，不随视图变），
     * **无论仓库多大，画面密度都可控**。传递入度保留在提示框和影响范围里，那里它才有意义。
     */
    let maxDirect = 1
    for (const n of present) maxDirect = Math.max(maxDirect, metrics.inDegree.get(n.id) ?? 0)

    const fileEdges: { source: string; target: string }[] = []
    graph.forEachDirectedEdge((_e, _a, source, target) => {
      if (shown && !(shown.has(source) && shown.has(target))) return
      fileEdges.push({ source, target })
    })

    /**
     * 聚合模式：节点是目录，边是带权重的目录间依赖。
     *
     * 半径区间 [3.5, 13.5]，比文件级略大但不夸张。
     *
     * 「节点看起来太大」的根因**不是半径，是间距**：zoomToFit 永远把图铺满画布，
     * 所以屏幕上的观感只取决于**半径 ÷ 图的跨度**这个比值。
     * 十几个节点挤在很小的范围里，缩放就会拉到很高，半径再小也显得巨大。
     * 真正的修法在下面的力参数里——聚合模式用大得多的连线长度和斥力。
     */
    if (grain > 0) {
      const agg = aggregate(
        present.map((n) => n.id),
        fileEdges,
        grain
      )

      let maxFiles = 1
      for (const g of agg.nodes) maxFiles = Math.max(maxFiles, g.files)

      const groupNodes: CanvasNode[] = agg.nodes.map((g) => ({
        id: g.id,
        // 只显示最后一段：packages/components 在画面上叫 components 就够了
        name: g.id.slice(g.id.lastIndexOf('/') + 1),
        dir: topLevelDir(g.id),
        color: colorOf(g.id),
        r: 3.5 + 10 * Math.sqrt(g.files / maxFiles),
        // 目录的入度/出度按**依赖条数**算，不是按目录个数——
        // 「47 条依赖指向这里」比「3 个目录依赖这里」更能说明耦合强度
        direct: 0,
        out: 0,
        loc: 0,
        inCycle: false,
        isGroup: true,
        files: g.files,
        internal: g.internal,
      }))

      const byId = new Map(groupNodes.map((n) => [n.id, n]))
      for (const e of agg.edges) {
        const t = byId.get(e.target)
        const src = byId.get(e.source)
        if (t) t.direct += e.weight
        if (src) src.out += e.weight
      }

      groupNodes.sort((a, b) => b.files - a.files)

      const linked = new Set<string>()
      for (const e of agg.edges) {
        linked.add(e.source)
        linked.add(e.target)
      }

      let maxWeight = 1
      for (const e of agg.edges) maxWeight = Math.max(maxWeight, e.weight)

      return {
        nodes: groupNodes,
        links: agg.edges.map((e) => ({
          source: e.source,
          target: e.target,
          weight: e.weight,
        })) as CanvasLink[],
        linked,
        detached: detachedOf(groupNodes, agg.edges),
        dense: false,
        grouped: true,
        maxWeight,
      }
    }

    const canvasNodes: CanvasNode[] = present.map((n) => {
      const direct = metrics.inDegree.get(n.id) ?? 0
      return {
        id: n.id,
        name: n.name,
        dir: topLevelDir(n.id),
        color: colorOf(n.id),
        r: 2.5 + 8.5 * Math.sqrt(direct / maxDirect),
        direct,
        out: graph.outDegree(n.id),
        loc: n.loc,
        inCycle: metrics.inCycle.has(n.id),
        isGroup: false,
        files: 1,
        internal: 0,
      }
    })

    // 大节点先画，小节点覆盖在上面，不会被埋掉
    canvasNodes.sort((a, b) => b.direct - a.direct)

    const links: CanvasLink[] = []
    /**
     * 当前视图里**有连线**的节点。
     *
     * 用它而不是 metrics.islands：隔离视图下一个节点可能全仓库有依赖、
     * 在这个子集里却一条边都不剩，那它在这张图上就是孤岛。
     * 「是不是孤岛」必须按画面上的边算。
     */
    const linked = new Set<string>()
    graph.forEachDirectedEdge((_e, _a, source, target) => {
      // 隔离时只保留两端都在子集里的边——力导向图收到指向不存在节点的边会直接崩
      if (shown && !(shown.has(source) && shown.has(target))) return
      links.push({ source, target, weight: 1 })
      linked.add(source)
      linked.add(target)
    })

    const detached = detachedOf(
      canvasNodes,
      links as unknown as { source: string; target: string }[]
    )

    return {
      nodes: canvasNodes,
      links,
      linked,
      detached,
      dense: canvasNodes.length > 220,
      grouped: false,
      maxWeight: 1,
    }
    // grain 必须在依赖里。漏掉它的话聚合分支永远不会重新执行——
    // 段控件点了有高亮，画面纹丝不动，而且不报任何错
  }, [graph, metrics, nodes, colorOf, isolate, matches, grain])

  /**
   * 力的参数。
   *
   * 力导向图只有三种力，边缘节点飞得太远是前两种力的**平衡点**决定的，
   * 不是没算完：
   *
   *   斥力 charge  每个节点排斥**其他所有节点**，按 1/d² 衰减 —— 注意是全局的
   *   弹簧 link    只作用在有边的两点之间，把距离拉向 distance
   *   居中 center  只是平移整个坐标系让质心回到原点，**对单个节点不施加任何力**
   *
   * 第三条最反直觉：forceCenter 救不了离群点，一个点飞到天边，
   * 它只会把整张图跟着挪过去。
   *
   * 一个只连一条边的叶子，受力平衡时：
   *   核心斥力 ≈ 630 × 208 / d²   弹簧拉力 ≈ (d − 36) / d
   *   两者相等 → d ≈ 360，而 630 个节点的核心半径才 ~100。
   * 所以叶子稳定停在核心外 3.6 倍处，取景被迫拉远，核心压成一小坨。
   *
   * 更糟的是「两个互相连接、但不连到主体」的点对：它们之间的弹簧只管彼此，
   * 整对被核心持续推开，而**没有任何力把这一对拉回来**。
   */
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const n = data.nodes.length

    /**
     * 聚合模式要**大得多**的间距。
     *
     * zoomToFit 永远把图铺满画布，所以节点在屏幕上的观感只取决于
     * **半径 ÷ 图的跨度**。十几个目录节点如果按文件级的力参数排布，
     * 跨度只有一百来个单位，缩放会拉到十倍，半径再小也是一坨巨球。
     *
     * 所以修法不是继续调小半径，是把图**撑开**：连线长度和斥力都拉高一个数量级，
     * 跨度上去了，同样的半径看起来就正常了。
     */
    fg.d3Force('charge')?.strength(data.grouped ? -1400 : -38 - Math.min(170, n / 3))

    /**
     * **不要用 charge.distanceMax。** 试过，会让拖动时整张图不规则跳动。
     *
     * 原因在 Barnes-Hut：斥力用四叉树近似，一整个象限被当成一个超级节点。
     * 当那个超级节点的质心距离跨过 distanceMax 时，
     * **几百个节点的斥力会一次性整体消失或出现**——是阶跃，不是渐变。
     * 拖动时模拟一直保持高 alpha，节点在边界两侧反复穿越，斥力就来回开关，
     * 形成肉眼可见的抖动。
     *
     * 向心力是线性连续的，没有这个毛病，所以边界问题交给它解决。
     */
    fg.d3Force('link')?.distance(data.grouped ? 150 : data.dense ? 36 : 26)
    fg.d3Force(
      'collide',
      forceCollide<CanvasNode>((node) => node.r + 1.5).iterations(2)
    )

    /**
     * 分档向心力：整张图的边界全靠它。
     *
     * 力是线性的（拉力 ∝ 距离），所以处处连续，不会像 distanceMax 那样抖。
     * 平衡点可以直接解出来——斥力 630×208/d² = 拉力 s·d：
     *
     *   s = 0.02  →  d ≈ 187      s = 0.08  →  d ≈ 118
     *
     * 而核心本身的半径约 100。所以：
     *
     * - **主体内的节点** 用 0.02。够把「只连一条边、被推到 360 外」的叶子
     *   拉回到 187 附近，同时弱到不会把核心压密——核心一密就更糊，
     *   而当初把斥力调这么高正是为了让它散开。
     * - **没拴在主体上的碎片** 用 0.08。它们没有弹簧可以抵抗，
     *   需要更强的拉力才能收到核心外围一圈，落在 118 左右。
     */
    /**
     * 聚合模式下向心力要**同步调弱一个数量级**。
     *
     * 它和斥力是一对：平衡点 d 满足「n·|charge|/d² = s·d」。
     * 上面把斥力拉到 -1400 是为了把图撑开，如果 s 还留在 0.02，
     * 平衡点会被摁回 100 左右——等于一边踩油门一边踩刹车，图照样是一小坨。
     */
    const [sMain, sDetached] = data.grouped ? [0.004, 0.02] : [0.02, 0.08]
    const pull = (node: CanvasNode) => (data.detached.has(node.id) ? sDetached : sMain)
    fg.d3Force('centerX', forceX<CanvasNode>(0).strength(pull))
    fg.d3Force('centerY', forceY<CanvasNode>(0).strength(pull))

    fg.d3ReheatSimulation()
  }, [data])

  /**
   * 选中项跑到视口外时把它带回来。
   *
   * 联动本来是缺一半的：从画布点节点会展开侧栏目录并滚动过去，
   * 反方向——从侧栏点一个文件——画布却纹丝不动。668 个节点的图上，
   * 那个节点可能在屏幕外三屏远的地方，"选中了" 却看不见。
   *
   * 只在**确实跑到视口外**时才移动。选中一个本来就看得见的节点还要平移一下，
   * 画面会在光标底下乱跳，比不动更糟。
   */
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !selected) return
    const node = data.nodes.find((n) => n.id === selected)
    if (!node || node.x == null || node.y == null) return

    const p = fg.graph2ScreenCoords(node.x, node.y)
    const margin = 72
    const outside = p.x < margin || p.y < margin || p.x > size.w - margin || p.y > size.h - margin
    if (outside) fg.centerAt(node.x, node.y, 480)
  }, [selected, data.nodes, size.w, size.h])

  /**
   * 该文件到选中文件的跳数。0 = 选中项自身，null = 不在当前层级范围内。
   * 无选中时全部按 0 处理（等于不淡化任何东西）。
   */
  const hopsOf = (id: string): number | null => {
    if (impact === null) return 0
    if (id === impact.root) return 0
    const h = impact.depth.get(id)
    return h != null && h <= impact.maxDepth ? h : null
  }

  const focused = (id: string) => hopsOf(id) !== null

  /**
   * 只高亮**传播步**，不是「两端都在范围内」的所有边。
   *
   * 边的方向是 source import target，影响沿反向传播，所以一条边参与传播
   * 当且仅当 `跳数(source) === 跳数(target) + 1`。强连通分量里同层之间还有大量
   * 横向边，一并点亮就是原来那团糊住的线。
   */
  const isStep = (sourceId: string, targetId: string) => {
    if (impact === null) return false
    const hs = hopsOf(sourceId)
    const ht = hopsOf(targetId)
    if (hs === null || ht === null) return false
    /**
     * 边的方向是 source import target，两种关系模式下传播方向相反：
     *   谁依赖它  影响沿反向传播 → 跳数(source) = 跳数(target) + 1
     *   它依赖谁  阅读沿正向推进 → 跳数(target) = 跳数(source) + 1
     * 用错方向的话高亮出来的是一棵朝相反方向张开的树，看着「有反应」却全是错的。
     */
    return impact.direction === 'dependents' ? hs === ht + 1 : ht === hs + 1
  }

  /** 一个节点最终画多淡：筛选优先，其次聚焦 */
  const alphaOf = (id: string) => {
    if (!isMatch(matches, id)) return ALPHA_FILTERED
    return focused(id) ? 1 : ALPHA_UNFOCUSED
  }

  /**
   * 图例的计数按**画面上真实存在的节点**重算，不用 App 传来的全仓库计数。
   * 隔离时画面上只剩 10 个点，图例却写着「src 22」，就是又一处
   * 「同一个东西在两处显示两个数字」（ADR-013 踩过一次）。
   */
  const legendCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of data.nodes) m.set(n.color, (m.get(n.color) ?? 0) + 1)
    return m
  }, [data.nodes])

  /** 位置索引图：全图缩略 + 当前视口矩形 */
  const drawLocator = useCallback(() => {
    const canvas = locatorRef.current
    const fg = fgRef.current
    if (!canvas || !fg) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== LOCATOR_W * dpr) {
      canvas.width = LOCATOR_W * dpr
      canvas.height = LOCATOR_H * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, LOCATOR_W, LOCATOR_H)

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of data.nodes) {
      if (n.x == null || n.y == null) continue
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    if (!Number.isFinite(minX)) return

    const pad = 7
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    const s = Math.min((LOCATOR_W - pad * 2) / spanX, (LOCATOR_H - pad * 2) / spanY)
    const ox = pad + (LOCATOR_W - pad * 2 - spanX * s) / 2
    const oy = pad + (LOCATOR_H - pad * 2 - spanY * s) / 2
    locatorTf.current = { minX, minY, s, ox, oy }

    const toX = (gx: number) => ox + (gx - minX) * s
    const toY = (gy: number) => oy + (gy - minY) * s

    for (const n of data.nodes) {
      if (n.x == null || n.y == null) continue
      const isSel = n.id === selected
      // 小地图跟随主图的淡化规则，否则筛选后两处显示的密度对不上
      ctx.globalAlpha = isSel ? 1 : Math.min(0.6, alphaOf(n.id))
      ctx.beginPath()
      ctx.arc(toX(n.x), toY(n.y), isSel ? 2.4 : Math.min(2.2, 0.6 + n.r / 6), 0, 2 * Math.PI)
      ctx.fillStyle = isSel ? INK : n.color
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // 当前视口矩形
    const tl = fg.screen2GraphCoords(0, 0)
    const br = fg.screen2GraphCoords(size.w, size.h)
    ctx.strokeStyle = 'rgba(242,241,236,0.85)'
    ctx.lineWidth = 1
    ctx.strokeRect(
      Math.round(toX(tl.x)) + 0.5,
      Math.round(toY(tl.y)) + 0.5,
      Math.max(3, (br.x - tl.x) * s),
      Math.max(3, (br.y - tl.y) * s)
    )
    // alphaOf 闭包了 matches / impact / selected，三者都必须在依赖里，
    // 否则筛选变了小地图还在按旧集合画
  }, [data.nodes, selected, impact, matches, size.w, size.h])

  const onLocatorClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const tf = locatorTf.current
    const fg = fgRef.current
    if (!tf || !fg) return
    const rect = e.currentTarget.getBoundingClientRect()
    const gx = tf.minX + (e.clientX - rect.left - tf.ox) / tf.s
    const gy = tf.minY + (e.clientY - rect.top - tf.oy) / tf.s
    fg.centerAt(gx, gy, 320)
  }, [])

  return (
    <div className="panel canvas">
      <div
        className="canvas-stage"
        ref={stageRef}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          const p = { x: e.clientX - box.left, y: e.clientY - box.top }
          pointerRef.current = p
          // 只有悬停中才写 state，空白处移动不触发重渲染
          if (hoveredRef.current) setPointer(p)
        }}
      >
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor={SURFACE}
          /**
           * 关掉内置提示框。
           *
           * react-force-graph 的 nodeLabel 默认取节点的 `name` 属性，而 CanvasNode 正好有
           * 这个字段，于是它会自动渲染一个跟随光标的 HTML 提示——固定在光标右下方，
           * 正好被鼠标指针挡住，而且和我们自己的 canvas-chip 重复。
           * 返回空串即不渲染。
           */
          nodeLabel={() => ''}
          nodeRelSize={3}
          cooldownTicks={COOLDOWN_TICKS}
          /**
           * 自动取景的缩放上限。
           *
           * zoomToFit 只管铺满画布：图上只剩一个节点时它会把那个圆放大到几百像素，
           * 既认不出是什么，也丢掉了「它在整张图的哪里」这个信息。
           * 少量节点时宁可留白，也不要一个填满屏幕的巨圆（I-12）。
           */
          maxZoom={MAX_AUTO_ZOOM}
          /**
           * 布局收敛后自动适应窗口。
           *
           * 没有这一步的话，力导向图收敛在哪儿就停在哪儿——画面上往往是一坨挤在角落的点
           * 加半屏黑，而「适应窗口」按钮就在右上角，等于把第一印象的成本转嫁给用户。
           * 每份数据只做一次，之后的收敛（拖动节点会触发）不再抢用户的视角。
           */
          onEngineStop={() => {
            if (fittedFor.current === data) return
            fittedFor.current = data
            const fg = fgRef.current
            if (!fg) return
            /**
             * **自动取景只框「主体」**：有连线、且落在稳健包围盒内的节点。
             *
             * 取景要回答的是「这个仓库长什么样」。孤岛在依赖图上什么都不说明，
             * 个别被甩出去的枝杈也一样——让噪音决定缩放级别，核心就被压成一小坨。
             * 被裁掉的节点一个都没丢：侧栏、分析面板、小地图里都还在，
             * 「适应窗口」按钮也仍然框全部。
             */
            const fit = coreBoxFilter(data.nodes, data.linked)
            if (fit) fg.zoomToFit(500, 48, fit)
            else fg.zoomToFit(500, 48)
          }}
          d3AlphaDecay={0.035}
          onRenderFramePost={() => {
            // 隔帧重绘索引图，避免与主图争用绘制预算
            if (++frame.current % 2 === 0) drawLocator()
          }}
          linkColor={(l) => {
            const s = (l as CanvasLink).source as CanvasNode
            const t = (l as CanvasLink).target as CanvasNode
            /**
             * 筛选时只保留**两端都命中**的边。
             *
             * 留着通向被筛掉节点的边，画面上就是一堆连向虚无的线头——
             * 比全部保留更难看，也更难读。
             */
            if (matches && !(matches.has(s.id) && matches.has(t.id))) {
              return 'rgba(255,255,255,0.02)'
            }
            // 边多时压低不透明度，否则几千条线会糊成一片灰
            if (!impact) return data.dense ? 'rgba(255,255,255,0.055)' : HAIRLINE
            return isStep(s.id, t.id) ? ACCENT : 'rgba(255,255,255,0.03)'
          }}
          linkDirectionalArrowLength={data.dense ? 0 : 2.5}
          linkDirectionalArrowRelPos={1}
          linkWidth={(l) => {
            const link = l as CanvasLink
            const s = link.source as CanvasNode
            const t = link.target as CanvasNode
            if (impact) return isStep(s.id, t.id) ? 2 : 1
            /**
             * 聚合模式下线宽编码依赖条数，但**必须有上界**。
             *
             * 目录之间「3 条依赖」和「470 条依赖」在架构上是两回事，
             * 画成一样粗等于把最关键的信息扔了。但裸的对数映射没有上界——
             * element-plus 上权重最大 900+，直接算出来是 9px 的粗管子，
             * 一条边糊住半张图。这和节点半径犯的是同一个错（ADR-019），
             * 而半径早就改成「按当前视图归一化到固定区间」了，边宽漏了。
             *
             * 所以同样两步：先取对数压掉量级差，再按**当前视图的最大权重**
             * 归一化到 [0.5, 3.2]px。无论仓库多大，最粗的边就那么粗。
             */
            if (!data.grouped) return 1
            const t01 = Math.log2(1 + link.weight) / Math.log2(1 + data.maxWeight)
            return 0.5 + 2.7 * t01
          }}
          /**
           * 点目录节点 = **下钻**，不是选中。
           *
           * 「先看 15 个，再钻进去」——点进去才有意义，选中一个目录没有对应的详情。
           * 一次动作完成三件事：切回文件级、把筛选设成这个目录、打开隔离。
           * 少任何一步，用户都得再手动点两下才能看到目录内部。
           */
          onNodeClick={(n) => {
            if (n.isGroup) {
              setGrain(0)
              setIsolate(true)
              onDrillDown(n.id)
              return
            }
            onSelect(n.id === selected ? null : n.id)
          }}
          onNodeHover={(n) => {
            hoveredRef.current = Boolean(n)
            // 进入节点的瞬间用 ref 里的最新位置播种，否则第一帧会画在旧位置
            if (n) setPointer(pointerRef.current)
            setHovered(n ?? null)
          }}
          nodeCanvasObject={(node, ctx) => {
            const r = node.r
            const hops = hopsOf(node.id)
            const isSel = node.id === selected
            /**
             * 基准透明度，**所有描边都要乘上它**。
             * 早先版本里各个环各自 `globalAlpha = 1`，结果被筛掉的节点主体几乎不可见、
             * 红色循环环却还是满不透明——一圈没有圆心的红环浮在画面上。
             */
            const alpha = alphaOf(node.id)

            ctx.globalAlpha = alpha

            ctx.beginPath()
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
            ctx.fillStyle = node.color
            ctx.fill()

            // 表面色描边：重叠节点之间留出视觉间隙
            ctx.lineWidth = 0.6
            ctx.strokeStyle = SURFACE
            ctx.stroke()

            // 影响范围主动加亮，而不是只靠别人变暗。环的深浅编码跳数
            if (impact && hops !== null && !isSel) {
              ctx.beginPath()
              ctx.arc(node.x!, node.y!, r + 2.2, 0, 2 * Math.PI)
              ctx.lineWidth = 1.4
              ctx.globalAlpha = alpha * ringAlpha(hops)
              ctx.strokeStyle = ACCENT
              ctx.stroke()
              ctx.globalAlpha = alpha
            }

            if (showCycles && node.inCycle) {
              ctx.beginPath()
              ctx.arc(node.x!, node.y!, r + 1.6, 0, 2 * Math.PI)
              ctx.lineWidth = 1.2
              ctx.strokeStyle = STATUS.critical
              ctx.stroke()
            }

            if (isSel) {
              ctx.beginPath()
              ctx.arc(node.x!, node.y!, r + 3.5, 0, 2 * Math.PI)
              ctx.lineWidth = 2
              // 选中环永远画满：选中项被自己的搜索词筛掉时，也得看得见它在哪
              ctx.globalAlpha = 1
              ctx.strokeStyle = INK
              ctx.stroke()
            }

            // 画布上不画文件名：悬停有提示框、选中有详情栏、侧栏有完整路径，
            // 三处已经覆盖识别需求。在图上再挂一层文字只会遮挡结构，
            // 而且力导向布局不保证节点不重叠，标签必然互相打架。
            ctx.globalAlpha = 1
          }}
          nodePointerAreaPaint={(node, paintColor, ctx) => {
            ctx.fillStyle = paintColor
            ctx.beginPath()
            // 命中区域比标记大，小节点也点得中
            ctx.arc(node.x!, node.y!, Math.max(5, node.r + 2), 0, 2 * Math.PI)
            ctx.fill()
          }}
        />
      </div>

      {/* 面板自身的圆角边框就是图幅内框线，不再单独画一层 */}
      <div className="canvas-tools">
        <div
          className="segmented"
          role="radiogroup"
          aria-label="聚合粒度"
          title="把文件折叠到第几层目录"
        >
          {GRAIN_OPTIONS.map((o) => (
            <button
              key={o.label}
              role="radio"
              aria-checked={grain === o.value}
              className={grain === o.value ? 'is-on' : undefined}
              onClick={() => setGrain(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/*
          关系方向。放在跳数控件前面——先问「看哪个方向」，再问「看几跳」，
          这个顺序和用户脑子里的顺序一致。
          没选中文件时禁用：两个控件都只作用于焦点文件，
          让它们在无焦点时仍可点击，用户会以为点了没生效（I-11）。
        */}
        <div
          className={`segmented${selected ? '' : ' is-disabled'}`}
          role="radiogroup"
          aria-label="关系方向"
          title={selected ? '看这个文件的哪一侧' : '先选中一个文件'}
        >
          {DIRECTION_OPTIONS.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={direction === o.value}
              disabled={!selected}
              className={direction === o.value ? 'is-on' : undefined}
              onClick={() => onDirectionChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div
          className={`segmented${selected ? '' : ' is-disabled'}`}
          role="radiogroup"
          aria-label="关系跳数"
          title={selected ? '关系向外传播几跳' : '先选中一个文件'}
        >
          {DEPTH_OPTIONS.map((o) => (
            <button
              key={o.label}
              role="radio"
              aria-checked={depth === o.value}
              disabled={!selected}
              className={depth === o.value ? 'is-on' : undefined}
              onClick={() => onDepthChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className={matches ? undefined : 'is-disabled'}>
          <input
            type="checkbox"
            checked={isolate}
            disabled={!matches}
            onChange={(e) => setIsolate(e.target.checked)}
          />
          <span title={matches ? '只保留筛选命中的节点，重新布局' : '先筛选再隔离'}>隔离</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showCycles}
            onChange={(e) => setShowCycles(e.target.checked)}
          />
          循环依赖
        </label>
        {/* 自动取景只框结构，这个按钮框全部——两种意图，各有各的场合 */}
        <button
          className="quiet"
          onClick={() => fgRef.current?.zoomToFit(400, 60)}
          title="框住全部节点，含孤岛"
        >
          适应窗口
        </button>
      </div>

      {hovered && (
        <>
          <NodeChip node={hovered} pointer={pointer} bounds={size} />
          <NodeDetails node={hovered} impact={impact} />
        </>
      )}

      <div className="canvas-legend">
        {matches && (
          <span className="legend-item legend-filter">
            {isolate ? '隔离中' : '筛选中'} <b>{matches.size}</b> / {nodes.length}
          </span>
        )}
        {legend.map((l) => {
          const n = legendCounts.get(l.color) ?? 0
          // 画面上一个都不剩的目录，图例里也不该占位置
          if (n === 0) return null
          return (
            <span key={l.label} className="legend-item">
              <i style={{ background: l.color }} />
              {l.label} <b>{n}</b>
            </span>
          )
        })}
        {metrics.cycles.length > 0 && showCycles && (
          <span className="legend-item">
            <i className="legend-ring" style={{ borderColor: STATUS.critical }} />
            {/* 单位是文件数，不是循环组数——抽屉导航里那个才是组数 */}
            循环中 <b>{metrics.inCycle.size}</b> 个文件
          </span>
        )}
      </div>

      <canvas
        ref={locatorRef}
        className="canvas-locator"
        style={{ width: LOCATOR_W, height: LOCATOR_H }}
        onClick={onLocatorClick}
        title="点击跳转"
      />
    </div>
  )
}

/**
 * 跟随光标的文件名小标——只有文件名，**显示在光标正上方**。
 * 放下方会被鼠标指针本身挡住。靠近上边缘时翻到下方。
 */
function NodeChip({
  node,
  pointer,
  bounds,
}: {
  node: CanvasNode
  pointer: { x: number; y: number }
  bounds: { w: number; h: number }
}) {
  const below = pointer.y < 34
  return (
    <div
      className="canvas-chip"
      style={{
        left: Math.min(Math.max(pointer.x, 60), Math.max(bounds.w - 60, 60)),
        top: below ? pointer.y + 22 : pointer.y - 14,
        transform: `translate(-50%, ${below ? '0' : '-100%'})`,
      }}
    >
      {node.name}
    </div>
  )
}

/**
 * 详细信息固定在画布左上角。
 * 跟着光标走会一直抖，而这块信息是要读的，不是要瞟的——位置稳定更重要。
 */
function NodeDetails({ node, impact }: { node: CanvasNode; impact: Impact | null }) {
  const slash = node.id.lastIndexOf('/')
  // 目录节点显示完整路径；文件节点显示所在目录（文件名已经在上面一行了）
  const dir = node.isGroup ? node.id : slash < 0 ? '' : node.id.slice(0, slash + 1)

  return (
    <div className="canvas-tooltip">
      <b>{node.name}</b>
      {dir && <i>{dir}</i>}
      {node.isGroup ? (
        <span>
          <b>{node.files}</b> 个文件 · 内部 <b>{node.internal}</b> 条依赖 · 被外部引用{' '}
          <b>{node.direct}</b> 次 · 向外引用 <b>{node.out}</b> 次
        </span>
      ) : (
        <span>
          <b>{node.direct}</b> 个文件直接引用 · 引用了 <b>{node.out}</b> 个 · <b>{node.loc}</b> 行
          {node.inCycle ? ' · 在循环中' : ''}
        </span>
      )}
      {node.isGroup && <em>点击展开这个目录</em>}
      {impact && <RelationToSelection node={node} impact={impact} />}
    </div>
  )
}

/**
 * 有选中项时，说清这个节点为什么亮着（或为什么没亮）。
 * 画面上的明暗差别本身不解释自己——不写这一行，用户只能猜层级是怎么算的。
 */
function RelationToSelection({ node, impact }: { node: CanvasNode; impact: Impact }) {
  const root = impact.root.slice(impact.root.lastIndexOf('/') + 1)

  if (node.id === impact.root) return <em>当前选中</em>

  const hops = impact.depth.get(node.id)
  if (hops == null) return <em className="muted">不受 {root} 影响</em>

  return (
    <em className={hops <= impact.maxDepth ? undefined : 'muted'}>
      距 {root} {hops} 跳
      {hops > impact.maxDepth && `（超出当前 ${impact.maxDepth} 跳，已淡出）`}
    </em>
  )
}
