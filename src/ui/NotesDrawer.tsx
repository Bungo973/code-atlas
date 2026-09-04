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
import { dependencyRankCount, FilePath, Metric, SectionHeading } from './Presentation'

export type SectionId = 'hubs' | 'entries' | 'cycles' | 'dead' | 'islands' | 'report'

export function NotesDrawer({
  metrics,
  deadCode,
  result,
  scan,
  concurrency,
  onConcurrencyChange,
  initialSection,
  onSelect,
  onClose,
}: {
  metrics: ReturnType<typeof computeMetrics>
  deadCode: ReturnType<typeof findSuspectedDeadSymbols> | null
  result: AnalyzeResult
  scan: BrowserScan
  concurrency: number
  onConcurrencyChange: (n: number) => void
  /** 从详情栏的摘要点进来时，直接落到对应小节 */
  initialSection: SectionId
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SectionId>(initialSection)

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

  // 真正被别人依赖过的文件数——排行表里也正是筛的这一批
  const hubCount = dependencyRankCount(metrics.inDegree)

  const nav: { id: SectionId; label: string; count?: number }[] = [
    // inDegree 每个节点都有条目，它的 size 是**全部文件数**，不是枢纽数。
    // 原来标成「枢纽文件 2209」，等于宣称这个仓库每个文件都是枢纽（I-06）。
    { id: 'hubs', label: '依赖排行', count: hubCount },
    { id: 'entries', label: '入口文件', count: metrics.entryPoints.length },
    {
      id: 'cycles',
      label: '循环依赖',
      // 单位是**组**，不是文件。画布图例数的是成员文件数，两处必须各自写清单位
      count: metrics.cycles.length,
    },
    {
      id: 'dead',
      label: '疑似死代码',
      count: deadCode?.suspects.length,
    },
    { id: 'islands', label: '孤岛文件', count: metrics.islands.length },
    { id: 'report', label: '解析报告' },
  ]

  return (
    <>
      <div className="notes-scrim" onClick={onClose} />
      <aside className="notes" role="dialog" aria-label="项目分析" aria-modal="true">
        <div className="notes-head">
          <h2>项目分析</h2>
          <span className="muted mono" title={scan.rootName}>{scan.rootName}</span>
          <button className="quiet" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="notes-main">
          <nav className="notes-nav" aria-label="分析分类">
            {nav.map((n) => (
              <button
                key={n.id}
                aria-current={section === n.id ? 'page' : undefined}
                onClick={() => setSection(n.id)}
              >
                {n.label}
                {n.count !== undefined && (
                  <em>{n.count}{n.id === 'cycles' ? ' 组' : n.id === 'dead' ? ' 符号' : ''}</em>
                )}
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
              <Report
                result={result}
                scan={scan}
                concurrency={concurrency}
                onConcurrencyChange={onConcurrencyChange}
              />
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
      <SectionHeading title="依赖排行" description="按直接依赖它的文件数量排序，帮助识别项目中的公共依赖。">
        <Metric value={dependencyRankCount(metrics.inDegree)} label="被依赖的文件" unit="文件" />
        <Metric value={rows.length} label="当前展示（最多 40）" unit="文件" />
      </SectionHeading>
      <table className="data-table">
        <thead>
          <tr>
            <th>文件</th>
            <th className="num">直接依赖它</th>
            <th className="num">含间接依赖</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, n]) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <FilePath path={id} />
              </td>
              <td className="num">{n}</td>
              <td className="num muted">{metrics.transitiveInDegree.get(id) ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="empty-message">当前仓库中没有被其他文件依赖的文件。</p>}
    </div>
  )
}

function Entries({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  return (
    <div className="card">
      <SectionHeading title="入口文件" description="没有其他仓库内文件依赖它们，可以作为阅读项目的起点。">
        <Metric value={metrics.entryPoints.length} label="入口文件" unit="文件" />
      </SectionHeading>
      <table className="data-table">
        <tbody>
          {metrics.entryPoints.map((id) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <FilePath path={id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {metrics.entryPoints.length === 0 && <p className="empty-message">当前规则下没有识别到入口文件。</p>}
    </div>
  )
}

function Cycles({ metrics, onJump }: { metrics: Metrics; onJump: (id: string) => void }) {
  return (
    <div className="card">
      <SectionHeading title="循环依赖" description="组内文件通过直接或间接依赖形成循环。点击任一成员可在图谱中定位。">
        <Metric value={metrics.cycles.length} label="循环依赖" unit="组" />
        <Metric value={metrics.inCycle.size} label="涉及文件" unit="文件" />
      </SectionHeading>
      {metrics.cycles.length === 0 && <p className="empty-message">没有检测到循环依赖。</p>}
      {metrics.cycles.map((cycle, i) => (
        <section className="cycle-group" key={i}>
          <div className="cycle-heading"><h4>循环组 {i + 1}</h4><span>{cycle.length} 个文件</span></div>
          {cycle.map((f) => (
            <button key={f} className="link-row" onClick={() => onJump(f)}>
              <FilePath path={f} />
            </button>
          ))}
        </section>
      ))}
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
        {/* 零结果也可能来自豁免，不能宣称每个导出都有显式引用 */}
        <SectionHeading title="疑似死代码" description="静态分析结果仅供排查，不代表可以直接删除。">
          <Metric value={0} label="疑似未引用导出" unit="符号" />
        </SectionHeading>
        <p className="empty-message">未发现符合当前规则的疑似死代码。</p>
      </div>
    )
  }
  return (
    <div className="card">
      <SectionHeading title="疑似死代码" description="当前规则下未发现仓库内引用的导出符号。请先确认动态引用与对外 API，再决定是否清理。">
        <Metric value={deadCode.suspects.length} label="疑似未引用导出" unit="符号" />
      </SectionHeading>
      <table className="data-table">
        <thead><tr><th>文件与导出符号</th><th className="num">符号数</th></tr></thead>
        <tbody>
          {groupByFile(deadCode.suspects).map((g) => (
            <tr key={g.file} className="clickable" onClick={() => onJump(g.file)}>
              <td>
                <FilePath path={g.file} />
                <div className="symbol-names">
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
      <SectionHeading title="孤岛文件" description="没有仓库内的导入或被导入关系；这不代表文件无用。">
        <Metric value={metrics.islands.length} label="孤岛文件" unit="文件" />
      </SectionHeading>
      <table className="data-table">
        <tbody>
          {metrics.islands.map((id) => (
            <tr key={id} className="clickable" onClick={() => onJump(id)}>
              <td>
                <FilePath path={id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {metrics.islands.length === 0 && <p className="empty-message">当前依赖图中没有孤岛文件。</p>}
    </div>
  )
}

function Report({
  result,
  scan,
  concurrency,
  onConcurrencyChange,
}: {
  result: AnalyzeResult
  scan: BrowserScan
  concurrency: number
  onConcurrencyChange: (n: number) => void
}) {
  const { stats, timing } = result
  const { rate, internal } = hitRate(stats)
  const excused =
    stats.failed['build-artifact'] + stats.failed['virtual-module'] + stats.failed['out-of-root']
  const wall = scan.scanMs + timing.total
  const realFailures = result.failures.filter((f) => f.reason === 'unresolved')
  const aliasScopeCount = result.aliasScopes.length

  return (
    <>
      <div className="card">
        <SectionHeading title="解析报告" description="查看本次本地分析的覆盖情况、耗时与解析诊断。" />
        <h3>概览</h3>
        <div className="figures">
          <Figure label="代码文件" value={result.nodes.length} />
          <Figure label="文件依赖" value={result.edges.length} />
          <Figure label="导出符号" value={result.symbols.length} />
          <Figure label="符号引用" value={result.symbolEdges.length} />
          <Figure
            label="解析命中率"
            value={`${rate.toFixed(1)}%`}
            tone={rate >= 90 ? 'ok' : rate >= 75 ? 'warn' : 'bad'}
          />
          <Figure label="总耗时" value={`${wall.toFixed(0)} ms`} />
        </div>
        <p className="hint">
          命中率 = {stats.resolved} / {internal}。构建产物、框架虚拟模块、超出所选目录的引用
          不计入分母——它们在设计上就无法解析。
        </p>
      </div>

      <div className="card">
        <h3>分析耗时</h3>
        <table className="data-table">
          <tbody>
            <Row label="目录遍历" value={`${scan.scanMs.toFixed(0)} ms`} />
            <Row label="读文件内容（并发累计）" value={`${timing.read.toFixed(0)} ms`} />
            <Row label="提取 import / export" value={`${timing.extract.toFixed(0)} ms`} />
            <Row label="路径解析" value={`${timing.resolve.toFixed(0)} ms`} />
          </tbody>
        </table>
        <p className="hint">后三项是并发下的累计值，相加会超过总耗时。</p>

        {/*
          并发数原来放在顶栏，紧挨着主操作按钮。它是做性能对比时加的调试旋钮，
          用户没有任何理由动它，却占着整个界面最贵的位置。
          挪到它影响的耗时数字旁边——要调的人在这儿找得到，不调的人再也看不见。
        */}
        <label className="inline-field">
          读文件并发
          <select
            value={concurrency}
            onChange={(e) => onConcurrencyChange(Number(e.target.value))}
          >
            {[1, 8, 16, 32, 64, 128].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="hint">改完需要重新分析才生效</span>
        </label>
      </div>

      <div className="card">
        <h3>依赖解析</h3>
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

      <section className="card">
        <h3>诊断信息</h3>
        <h4>提取器与别名配置</h4>
        <table className="data-table">
          <tbody>
            <Row label="es-module-lexer 直接解析" value={stats.lexerOk} />
            <Row label="回退到正则（JSX 等）" value={stats.lexerFallback} />
            <Row label="tsconfig 别名" value={`${result.aliasCount} 条 / ${result.aliasScopes.length} 份配置`} />
          </tbody>
        </table>

      {realFailures.length > 0 && (
        <div className="report-block">
          <h4>真实失败样本</h4>
          {/*
            两列都是可能很长的路径和 specifier，必须能折行。
            原来第二列挂的是 .num（它带 white-space: nowrap，本来是给数字用的），
            于是长 specifier 把表格撑得比卡片还宽，内容直接溢出圆角边框，
            再由抽屉整体横向滚动——卡片自己被推出视野。
            另外补上表头：只看两列裸路径，读的人分不出哪列是文件哪列是引用。
          */}
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th>文件</th>
                <th>解析不了的引用</th>
              </tr>
            </thead>
            <tbody>
              {realFailures.slice(0, 30).map((f, i) => (
                <tr key={i}>
                  <td>
                    <code>{f.source}</code>
                  </td>
                  <td>
                    <code>{f.raw}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {realFailures.length > 30 && (
            <p className="hint">共 {realFailures.length} 条，只列前 30 条。</p>
          )}
        </div>
      )}

      {result.aliasLikeExternals.length > 0 && (
        <div className="report-block">
          <h4>疑似漏配别名</h4>
          <p className="hint">
            这些 specifier 长得像路径别名（<code>@/</code> <code>~/</code> <code>#</code> 开头），
            但没匹配上任何 tsconfig 的 <code>paths</code>，所以被当成了外部包——
            <b>图上少了这些边</b>。
          </p>
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th>文件</th>
                <th>引用</th>
              </tr>
            </thead>
            <tbody>
              {result.aliasLikeExternals.slice(0, 30).map((f, i) => (
                <tr key={i}>
                  <td>
                    <code>{f.source}</code>
                  </td>
                  <td>
                    <code>{f.raw}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            成因有两种，对用户的意义完全不同，必须分开说：
            一种是我们该知道却没找到（tsconfig 漏读），一种是我们不可能知道
            （别名定义在 vite/webpack 的 JS 配置里，要执行代码才能拿到）。
            原来的文案笼统说「没匹配上 tsconfig」，暗示是用户配置有问题——不公平。
          */}
          <p className="hint">
            常见成因有两种：别名定义在 <b>vite / webpack 的配置</b>里（本工具只读 tsconfig，
            无法知道）；或者声明它的 tsconfig 不叫 <code>tsconfig.json</code>、
            或通过 <code>extends</code> 引入（本工具暂不跟随）。
            目前已读到 {aliasScopeCount} 份含别名的配置。
          </p>
        </div>
      )}
      </section>
    </>
  )
}

function Figure({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <Metric label={label} value={value} tone={tone} />
}

function Row({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <tr>
      <td className={tone}>{label}</td>
      <td className="num">{value}</td>
    </tr>
  )
}
