/**
 * 应用编排。
 *
 * 只做三件事：状态编排、数据加工（useMemo）、区域组装。
 * **不包含任何具体区域的渲染细节**——要改某个区域，直接打开 src/ui 下对应的文件。
 * 区域划分与命名见 docs/UI-VOCABULARY.md。
 */

import { useCallback, useMemo, useState } from 'react'
import { isSupported, pickDirectory, scanDirectory, type BrowserScan } from './adapters/browser'
import { demoFileCount, scanDemo } from './adapters/demo'
import { analyze, type AnalyzeResult } from './core/analyze'
import {
  buildGraph,
  computeMetrics,
  impactOf,
  topLevelDir,
  type Direction,
} from './core/graph'
import { applyFilter, EMPTY_FILTER, facetsOf, type FileFilter } from './core/search'
import { findSuspectedDeadSymbols, usageOf } from './core/symbols'
import { DetailRail, type NotesSection } from './ui/DetailRail'
import { GraphCanvas } from './ui/GraphCanvas'
import { NotesDrawer } from './ui/NotesDrawer'
import { ProjectSidebar } from './ui/ProjectSidebar'
import { buildDirColors } from './ui/palette'
import { useResizableWidth } from './ui/useResizableWidth'

export function App() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [scan, setScan] = useState<BrowserScan | null>(null)
  /** 当前这份结果来自内置示例。必须让用户看得见，否则「本地分析」的说法就成了含糊话 */
  const [isDemo, setIsDemo] = useState(false)
  const [result, setResult] = useState<AnalyzeResult | null>(null)
  const [concurrency, setConcurrency] = useState(32)
  const [notesOpen, setNotesOpen] = useState(false)
  /** 分析面板打开时先落到哪一节。从详情栏的摘要点进来时会指定 */
  const [notesSection, setNotesSection] = useState<NotesSection>('hubs')
  /** 疑似漏配别名的告警是否已被关掉。换仓库时重置——新仓库的情况是新的 */
  const [aliasWarnDismissed, setAliasWarnDismissed] = useState(false)
  /** 侧栏、画布、分析面板共享的选中文件——双向联动的单一数据源 */
  const [selected, setSelected] = useState<string | null>(null)
  /**
   * 影响范围的层级上限。默认 2 跳而不是不限：在强连通的大仓库里不限层级会饱和，
   * 每次点击都高亮同一片（见 ADR-020）。总数照常显示，不会因为限层而瞒报。
   */
  const [impactDepth, setImpactDepth] = useState<number>(2)
  /**
   * 关系方向。默认「被依赖」——最常见的问题是「改这个会波及谁」。
   * 但从入口点出发时那个答案恒为 0，所以必须能切到「依赖」（I-09）。
   */
  const [direction, setDirection] = useState<Direction>('dependents')
  /** 筛选条件提到这里：侧栏和画布必须用同一份命中判定，否则两边数字会对不上 */
  const [filter, setFilter] = useState<FileFilter>(EMPTY_FILTER)

  const sidebar = useResizableWidth({
    storageKey: 'code-atlas.sidebar-width',
    initial: 280,
    min: 190,
    max: 560,
  })

  /**
   * 真实目录和内置示例走**同一条**加载→分析路径，只有「文件从哪来」这一步不同。
   * 示例一旦分叉出自己的流水线，它就会慢慢和真实路径失去同步（ADR-022）。
   */
  const runScan = useCallback(
    async (load: () => Promise<BrowserScan>, demo: boolean) => {
      setError(null)
      setResult(null)
      setScan(null)
      setProgress(null)
      setNotesOpen(false)
      setAliasWarnDismissed(false)
      // 换仓库必须清筛选：上一个仓库的目录名在新仓库里通常一个都不存在，
      // 留着就是打开后看到一片空
      setFilter(EMPTY_FILTER)
      setIsDemo(demo)
      setBusy(true)
      try {
        const s = await load()
        setScan(s)
        setProgress({ done: 0, total: s.files.length })

        const r = await analyze({
          root: s.root,
          files: s.files,
          allPaths: s.allPaths,
          tsconfigs: s.tsconfigs,
          packageJsons: s.packageJsons,
          concurrency,
          onProgress: (done, total) => {
            if (done % 40 === 0 || done === total) setProgress({ done, total })
          },
        })
        setResult(r)
        setSelected(null)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
        setProgress(null)
      }
    },
    [concurrency]
  )

  const run = useCallback(async () => {
    setError(null)
    let handle: FileSystemDirectoryHandle | null
    try {
      handle = await pickDirectory()
    } catch (e) {
      setError((e as Error).message)
      return
    }
    if (!handle) return
    await runScan(() => scanDirectory(handle!), false)
  }, [runScan])

  const runDemo = useCallback(() => runScan(scanDemo, true), [runScan])

  const graphBundle = useMemo(() => {
    if (!result) return null
    const graph = buildGraph(result.nodes, result.edges)
    const metrics = computeMetrics(graph)
    const { color, legend } = buildDirColors(result.nodes.map((n) => topLevelDir(n.id)))
    return { graph, metrics, colorOf: (id: string) => color(topLevelDir(id)), legend }
  }, [result])

  /** 选中文件的影响范围：改动它会波及谁。侧栏、画布、详情栏共用这一份 */
  const impact = useMemo(
    () =>
      graphBundle && selected
        ? impactOf(graphBundle.graph, selected, impactDepth, direction)
        : null,
    [graphBundle, selected, impactDepth, direction]
  )

  const deadCode = useMemo(() => {
    if (!result || !graphBundle) return null
    return findSuspectedDeadSymbols({
      symbols: result.symbols,
      symbolEdges: result.symbolEdges,
      namespaceImported: result.namespaceImported,
      entryPoints: new Set(graphBundle.metrics.entryPoints),
    })
  }, [result, graphBundle])

  const selectedUsage = useMemo(
    () => (result && selected ? usageOf(selected, result.symbols, result.symbolEdges) : null),
    [result, selected]
  )

  /**
   * 必须 memo。写成 `result.nodes.map(...)` 内联传给侧栏的话，每次 App 重渲染
   * 都会产生新数组身份，导致侧栏里 buildTree 的 useMemo 失效、
   * `useEffect([root])` 重新触发 setExpanded——**展开状态会在每次选中/拖拽时被重置**，
   * 树也白重建一次。
   */
  const fileIds = useMemo(() => result?.nodes.map((n) => n.id) ?? [], [result])

  /** null = 没在筛选（全部正常显示），空集合 = 筛了但一个没中（全部淡出） */
  const matches = useMemo(() => applyFilter(fileIds, filter), [fileIds, filter])

  /** 可选的筛选项，只列真实存在的 */
  const facets = useMemo(() => facetsOf(fileIds), [fileIds])

  const ready = result && scan && graphBundle

  return (
    <div className="app">
      <header className="app-bar">
        <h1>Code Atlas</h1>

        {scan && (
          <div className="app-bar-project">
            <b className="mono project-name" title={scan.rootName}>
              {scan.rootName}
            </b>
            {isDemo && <span className="tag">示例</span>}
          </div>
        )}

        {progress && (
          <div className="progress" title={`${progress.done} / ${progress.total}`}>
            <i style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
        )}

        {/*
          这里只放主操作。并发数是做性能对比时加的调试旋钮，已挪进
          「分析 → 解析报告」，和它影响的耗时数字放在一起。
        */}
        <div className="app-bar-right">
          {ready && (
            <button onClick={() => {
              setNotesSection('hubs')
              setNotesOpen(true)
            }}>
              项目分析
            </button>
          )}
          <button className="primary" onClick={run} disabled={busy || !isSupported()}>
            {busy ? '分析中' : scan ? '切换目录' : '选择目录'}
          </button>
        </div>
      </header>

      <div className="board" style={{ ['--sidebar-w' as string]: `${sidebar.width}px` }}>
        {/* 单一容器，无警告时高度为 0，不会打乱 board 的行序 */}
        <div className="banners">
          {error && <div className="banner bad">{error}</div>}

          {/* 不支持时不再只是通知坏消息——示例在任何浏览器里都能跑 */}
          {!isSupported() && !scan && (
            <div className="banner">
              打开本地目录需要 File System Access API（Chrome / Edge）。
              当前浏览器可以先看内置示例。
            </div>
          )}

          {/*
            可关闭。这条告警是**信息**不是**故障**——图能用，只是可能缺几条边。
            让它常驻在主视图顶上，等于把一条低优先级的信息永久占住一整行，
            而用户第一眼看完之后它再也不提供新东西。
            关掉之后完整清单还在「分析 → 解析报告」里，随时能查。
          */}
          {ready && result.stats.externalAliasLike > 0 && !aliasWarnDismissed && (
            <div className="banner">
              <span className="warn">⚠</span>
              {result.stats.externalAliasLike} 个导入长得像路径别名，但没匹配上任何 tsconfig
              的 paths，图可能缺这些边。
              <button className="quiet" onClick={() => setNotesOpen(true)}>
                查看清单
              </button>
              <button
                className="quiet banner-close"
                onClick={() => setAliasWarnDismissed(true)}
                title="关闭"
              >
                ×
              </button>
            </div>
          )}
        </div>

        <main className={`workspace${ready ? '' : ' workspace--empty'}`}>
          {ready && (
            <ProjectSidebar
              fileIds={fileIds}
              selected={selected}
              onSelect={setSelected}
              metrics={graphBundle.metrics}
              colorOf={graphBundle.colorOf}
              highlight={impact?.reached ?? null}
              filter={filter}
              onFilterChange={setFilter}
              facets={facets}
              matches={matches}
            />
          )}

          {ready && (
            <div
              {...sidebar.handleProps}
              className={`resize-handle${sidebar.dragging ? ' resize-handle--dragging' : ''}`}
            />
          )}

          {ready ? (
            <section className="panel graph-panel" aria-label="依赖图谱">
              <DetailRail
                selected={selected}
                impact={impact}
                usage={selectedUsage}
                metrics={graphBundle.metrics}
                deadCount={deadCode?.suspects.length ?? 0}
                onClear={() => setSelected(null)}
                onOpenNotes={(section) => {
                  setNotesSection(section)
                  setNotesOpen(true)
                }}
              />
              <GraphCanvas
                graph={graphBundle.graph}
                metrics={graphBundle.metrics}
                nodes={result.nodes}
                selected={selected}
                onSelect={setSelected}
                impact={impact}
                depth={impactDepth}
                onDepthChange={setImpactDepth}
                direction={direction}
                onDirectionChange={setDirection}
                matches={matches}
                /* 聚合视图点一个目录：换成「只看这个目录」的筛选，画布自己切回文件级 */
                onDrillDown={(dir) => setFilter({ ...EMPTY_FILTER, dirs: [dir] })}
                colorOf={graphBundle.colorOf}
                legend={graphBundle.legend}
              />
            </section>
          ) : (
            <div className="welcome">
              <div className="canvas-empty">
                <span className="welcome-eyebrow">CODE ATLAS / 本地代码分析</span>
                <h2>看清项目结构与文件依赖</h2>
                <p>选择本地代码仓库，浏览文件关系与分析结果。</p>
                <div className="canvas-empty-actions">
                  <button className="primary" onClick={run} disabled={busy || !isSupported()}>
                    {busy ? '分析中' : '选择目录'}
                  </button>
                  <button onClick={runDemo} disabled={busy}>
                    查看演示
                  </button>
                </div>
                <p className="hint">
                  演示以 Code Atlas 自身源码为例，包含 {demoFileCount()} 个项目文件。
                </p>
                <p className="hint">全程在本机完成，代码不会离开浏览器</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {notesOpen && ready && (
        <NotesDrawer
          metrics={graphBundle.metrics}
          deadCode={deadCode}
          result={result}
          scan={scan}
          concurrency={concurrency}
          onConcurrencyChange={setConcurrency}
          initialSection={notesSection}
          onSelect={setSelected}
          onClose={() => setNotesOpen(false)}
        />
      )}
    </div>
  )
}
