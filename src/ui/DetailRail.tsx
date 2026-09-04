/** 主图区上下文：文件详情或仓库摘要，沿用原详情栏的选择与分析入口。 */
import type { GraphMetrics, Impact } from '../core/graph'
import type { usageOf } from '../core/symbols'
import { dependencyRankCount, FilePath, Metric } from './Presentation'

export type NotesSection = 'hubs' | 'entries' | 'cycles' | 'dead' | 'islands' | 'report'

export function DetailRail({ selected, impact, usage, metrics, deadCount, onClear, onOpenNotes }: {
  selected: string | null
  impact: Impact | null
  usage: ReturnType<typeof usageOf> | null
  metrics: GraphMetrics | null
  deadCount: number
  onClear: () => void
  onOpenNotes: (section: NotesSection) => void
}) {
  const unused = usage?.filter((u) => u.users.length === 0).length ?? 0
  const summary: { section: NotesSection; label: string; value: number; unit: string }[] = metrics
    ? [
        { section: 'hubs', label: '依赖排行', value: dependencyRankCount(metrics.inDegree), unit: '文件' },
        { section: 'entries', label: '入口文件', value: metrics.entryPoints.length, unit: '文件' },
        { section: 'cycles', label: '循环依赖', value: metrics.cycles.length, unit: '组' },
        { section: 'dead', label: '疑似死代码', value: deadCount, unit: '符号' },
        { section: 'islands', label: '孤岛文件', value: metrics.islands.length, unit: '文件' },
      ]
    : []

  return (
    <header className={`detail-rail${selected ? ' detail-rail--selected' : ''}`}>
      <div className="detail-identity">
        {selected ? (
          <h2><FilePath path={selected} full /></h2>
        ) : (
          <><h2>依赖图谱</h2><p>项目结构与文件关系</p></>
        )}
      </div>
      {selected ? (
        <>
          <div className="detail-fields">
            <div className="detail-relation">
              <Metric
                value={impact?.reached.size ?? 0}
                unit="文件"
                label={impact?.direction === 'dependencies' ? '它依赖的文件' : '受它影响的文件'}
              />
              <span className="detail-scope">
                {impact && Number.isFinite(impact.maxDepth) ? `当前 ${impact.maxDepth} 跳` : '不限跳数'}
                {' · 全部可达 '}{impact?.total ?? 0}
              </span>
            </div>
            <Metric value={usage?.length ?? 0} label="导出符号" />
            {unused > 0 && <Metric value={unused} label="未发现仓库内引用" />}
          </div>
          <button className="quiet detail-clear" onClick={onClear}>取消选择</button>
        </>
      ) : (
        <div className="detail-summaries">
          {summary.map((item) => (
            <button
              key={item.section}
              className="detail-summary"
              onClick={() => onOpenNotes(item.section)}
              title={`在项目分析中查看${item.label}`}
            >
              <Metric value={item.value} label={item.label} unit={item.unit} />
            </button>
          ))}
        </div>
      )}
    </header>
  )
}
