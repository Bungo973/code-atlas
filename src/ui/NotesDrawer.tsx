/**
 * 分析面板 —— 所有卡片的统一入口，从右侧滑出。
 *
 * 主视图只留侧栏和画布；枢纽、入口点、循环依赖、疑似死代码、孤岛、解析报告
 * 全部收进这里，左侧一列导航切换。
 *
 * 同时承担无障碍职责：**图之外必须有等价的表格表述**，身份不能只靠颜色传达（ADR-011）。
 */

import { useEffect, useState } from 'react'
import type { BrowserScan } from '../adapters/browser'
import { hitRate, type AnalyzeResult } from '../core/analyze'
import type { computeMetrics } from '../core/graph'
import { groupByFile, type findSuspectedDeadSymbols } from '../core/symbols'

type SectionId = 'hubs' | 'entries' | 'cycles' | 'dead' | 'islands' | 'report'

export function NotesDrawer({
  metrics,
  deadCode,
  result,
  scan,
  concurrency,
  onSelect,
  onClose,
}: {
  metrics: ReturnType<typeof computeMetrics>
  deadCode: ReturnType<typeof findSuspectedDeadSymbols> | null
  result: AnalyzeResult
  scan: BrowserScan
  concurrency: number
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SectionId>('hubs')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const jump = (id: string) => {
    onSelect(id)
    onClose()
  }

  const nav: { id: SectionId; label: string; count?: number; tone?: string }[] = [
    { id: 'hubs', label: '枢纽文件', count: metrics.inDegree.size },
    { id: 'entries', label: '入口点', count: metrics.entryPoints.length },
    {
      id: 'cycles',
      label: '循环依赖',
      count: metrics.cycles.length,
      tone: metrics.cycles.length ? 'bad' : undefined,
    },
    {
      id: 'dead',
      label: '疑似死代码',
      count: deadCode?.suspects.length,
      tone: deadCode?.suspects.length ? 'warn' : undefined,
    },
    { id: 'islands', label: '孤岛', count: metrics.islands.length },
    { id: 'report', label: '解析报告' },
  ]

  return (
    <>
      <div className="notes-scrim" onClick={onClose} />
      <aside className="notes" role="dialog" aria-label="分析">
        <div className="notes-head">
          <h2>分析</h2>
          <span className="muted mono">{scan.rootName}</span>
          <button className="quiet" style={{ marginLeft: 'auto' }} onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="notes-main">
          <nav className="notes-nav">
            {nav.map((n) => (
              <button
                key={n.id}
                aria-selected={section === n.id}
                onClick={() => setSection(n.id)}
              >
                {n.label}
                {n.count !== undefined && <em className={n.tone}>{n.count}</em>}
              </button>
            ))}
          </nav>

          <div className="notes-body">
            {section === 'hubs' && <Hubs metrics={metrics} onJump={jump} />}
            {section === 'entries' && <Entries metrics={metrics} onJump={jump} />}
            {section === 'cycles' && <Cycles metrics={metrics} onJump={jump} />}
            {section === 'dead' && <DeadCode deadCode={deadCode} onJump={jump} />}
            {section === 'islands' && <Islands metrics={metrics} onJump={jump} />}
            {section === 'report' && (
              <Report result={result} scan={scan} concurrency={concurrency} />
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

type Metrics = ReturnType<typeof computeMetrics>

/**
 * 排序必须用**直接入度**。
 *
 * 原来按传递入度排：excalidraw 上前几十行全是 509，等于按并列第一随机取 40 个，
 * 「被依赖最多」这个标题就成了假的。传递入度作为一列留着——并排看得出它饱和了，
 * 当排序键才有害。见 ADR-021。
 */
function Hubs({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  const rows = [...metrics.inDegree.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)

  return (
    <div className="card">
      <h3>被依赖最多的文件</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>文件</th>
            <th className="num">直接</th>
            <th className="num">含间接</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, n]) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <code>{id}</code>
              </td>
              <td className="num">{n}</td>
              <td className="num muted">{metrics.transitiveInDegree.get(id) ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Entries({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  return (
    <div className="card">
      <h3>没有任何文件依赖它们，适合作为阅读起点</h3>
      <table className="data-table">
        <tbody>
          {metrics.entryPoints.map((id) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <code>{id}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cycles({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  if (metrics.cycles.length === 0) {
    return (
      <div className="card">
        <h3>没有检测到循环依赖</h3>
      </div>
    )
  }
  return (
    <div className="card">
      <h3>互相依赖、无法单独抽离的文件组</h3>
      <table className="data-table">
        <tbody>
          {metrics.cycles.map((cycle, i) => (
            <tr key={i} className="clickable" onClick={() => onJump(cycle[0])}>
              <td>
                {cycle.map((f) => (
                  <div key={f}>
                    <code>{f}</code>
                  </div>
                ))}
              </td>
              <td className="num">{cycle.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DeadCode({
  deadCode,
  onJump,
}: {
  deadCode: ReturnType<typeof findSuspectedDeadSymbols> | null
  onJump: (id: string) => void
}) {
  if (!deadCode || deadCode.suspects.length === 0) {
    return (
      <div className="card">
        <h3>所有导出符号在仓库内都有引用</h3>
      </div>
    )
  }
  return (
    <div className="card">
      <h3>仓库内找不到引用的导出符号</h3>
      <table className="data-table">
        <tbody>
          {groupByFile(deadCode.suspects).map((g) => (
            <tr key={g.file} className="clickable" onClick={() => onJump(g.file)}>
              <td>
                <code>{g.file}</code>
                <div className="muted mono" style={{ marginTop: 2 }}>
                  {g.names.join('  ')}
                </div>
              </td>
              <td className="num">{g.names.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        是「疑似」而非「未使用」——可能被动态引用、被仓库外的消费方引用，或本身就是公开 API。
        已排除 {deadCode.excused.hasImporter} 个有引用、{deadCode.excused.namespaceImported}{' '}
        个被整体导入、{deadCode.excused.entryPoint} 个属于入口点。
      </p>
    </div>
  )
}

function Islands({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  return (
    <div className="card">
      <h3>既不依赖别人也不被依赖</h3>
      <table className="data-table">
        <tbody>
          {metrics.islands.map((id) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <code>{id}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Report({
  result,
  scan,
  concurrency,
}: {
  result: AnalyzeResult
  scan: BrowserScan
  concurrency: number
}) {
  const { stats, timing } = result
  const { rate, internal } = hitRate(stats)
  const excused =
    stats.failed['build-artifact'] + stats.failed['virtual-module'] + stats.failed['out-of-root']
  const wall = scan.scanMs + timing.total
  const realFailures = result.failures.filter((f) => f.reason === 'unresolved')

  return (
    <>
      <div className="card">
        <div className="figures">
          <Figure label="代码文件" value={result.nodes.length} />
          <Figure label="依赖边" value={result.edges.length} />
          <Figure label="导出符号" value={result.symbols.length} />
          <Figure label="符号引用" value={result.symbolEdges.length} />
          <Figure
            label="解析命中率"
            value={`${rate.toFixed(1)}%`}
            tone={rate >= 90 ? 'ok' : rate >= 75 ? 'warn' : 'bad'}
          />
          <Figure label="总耗时" value={`${wall.toFixed(0)}ms`} />
        </div>
        <p className="hint">
          命中率 = {stats.resolved} / {internal}。构建产物、框架虚拟模块、超出所选目录的引用
          不计入分母——它们在设计上就无法解析。
        </p>
      </div>

      <div className="card">
        <h3>耗时分解</h3>
        <table className="data-table">
          <tbody>
            <Row label="目录遍历" value={`${scan.scanMs.toFixed(0)} ms`} />
            <Row label="读文件内容（并发累计）" value={`${timing.read.toFixed(0)} ms`} />
            <Row label="提取 import / export" value={`${timing.extract.toFixed(0)} ms`} />
            <Row label="路径解析" value={`${timing.resolve.toFixed(0)} ms`} />
          </tbody>
        </table>
        <p className="hint">并发 {concurrency}。后三项是并发下的累计值，相加会超过总耗时。</p>
      </div>

      <div className="card">
        <h3>import 分类</h3>
        <table className="data-table">
          <tbody>
            <Row label="总计" value={stats.total} />
            <Row label="外部包" value={stats.external} />
            {stats.externalAliasLike > 0 && (
              <Row
                label="其中疑似漏配别名"
                value={stats.externalAliasLike}
                tone="warn"
              />
            )}
            <Row label="静态资源" value={stats.asset} />
            <Row label="成功解析" value={stats.resolved} />
            <Row label="设计上无法解析" value={excused} />
            <Row label="真实失败" value={stats.failed.unresolved} />
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>提取器</h3>
        <table className="data-table">
          <tbody>
            <Row label="es-module-lexer 直接解析" value={stats.lexerOk} />
            <Row label="回退到正则（JSX 等）" value={stats.lexerFallback} />
            <Row label="tsconfig 别名" value={`${result.aliasCount} 条 / ${result.aliasScopes.length} 份配置`} />
          </tbody>
        </table>
      </div>

      {realFailures.length > 0 && (
        <div className="card">
          <h3>真实失败样本</h3>
          <table className="data-table">
            <tbody>
              {realFailures.slice(0, 30).map((f, i) => (
                <tr key={i}>
                  <td>
                    <code>{f.source}</code>
                  </td>
                  <td className="num">
                    <code>{f.raw}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function Figure({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="figure">
      <b className={tone}>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <tr>
      <td className={tone}>{label}</td>
      <td className="num">{value}</td>
    </tr>
  )
}
