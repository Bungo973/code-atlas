/**
 * 详情栏 —— 底部单行，随选中状态切换内容。
 *
 * **选中文件时**：这个文件的关键数字。
 * **没选中时**：仓库级摘要，每一项都是分析面板对应小节的入口。
 *
 * 原来没选中时整行只写一句「请选择一个文件」——48px 高的一整行拿去说一句废话，
 * 而右边那个「分析」按钮其实放错了地方：详情栏是「选中文件」的信息，
 * 分析面板却是**仓库级**的，跟选中什么无关。它在这儿只是因为有空位。
 * 现在改成：没选中时这行就是仓库摘要，点哪个数字进哪一节。
 */

import type { GraphMetrics, Impact } from '../core/graph'
import type { usageOf } from '../core/symbols'

/** 与 NotesDrawer 的小节 id 一一对应 */
export type NotesSection = 'hubs' | 'entries' | 'cycles' | 'dead' | 'islands' | 'report'

export function DetailRail({
  selected,
  impact,
  usage,
  metrics,
  deadCount,
  onClear,
  onOpenNotes,
}: {
  selected: string | null
  impact: Impact | null
  usage: ReturnType<typeof usageOf> | null
  metrics: GraphMetrics | null
  deadCount: number
  onClear: () => void
  /** 打开分析面板并直接落到某一节 */
  onOpenNotes: (section: NotesSection) => void
}) {
  const unused = usage?.filter((u) => u.users.length === 0).length ?? 0

  /**
   * 限了层级就必须同时说出总数，否则「12 个文件受影响」会被读成结论。
   * 层级足够覆盖全部时不加尾巴，免得每次都挂一句废话。
   */
  const truncated = impact !== null && impact.reached.size < impact.total

  /**
   * 仓库摘要。数字全部来自和分析面板**同一份** metrics / deadCode——
   * 摘要和明细对不上是这个项目栽过两次的坑（ADR-013、ADR-024）。
   */
  const summary: { section: NotesSection; label: string; value: number; tone?: string }[] = metrics
    ? [
        { section: 'hubs', label: '枢纽文件', value: metrics.inDegree.size },
        { section: 'entries', label: '入口点', value: metrics.entryPoints.length },
        {
          section: 'cycles',
          label: '循环依赖',
          value: metrics.cycles.length,
          tone: metrics.cycles.length ? 'warn' : undefined,
        },
        {
          section: 'dead',
          label: '疑似死代码',
          value: deadCount,
          tone: deadCount ? 'warn' : undefined,
        },
        { section: 'islands', label: '孤岛', value: metrics.islands.length },
      ]
    : []

  return (
    <div className="detail-rail">
      {selected ? (
        <>
          <span className="detail-rail-path" title={selected}>
            {selected}
          </span>
          <span
            className="detail-field"
            title={truncated ? `沿反向依赖最远 ${impact!.farthest} 跳` : undefined}
          >
            {/* 措辞必须随方向变——同一个数字在两个方向下含义完全不同，不可比 */}
            <b>{impact?.reached.size ?? 0}</b>{' '}
            {impact?.direction === 'dependencies' ? '个文件被它依赖' : '个文件受影响'}
            {truncated && <i className="muted"> / 全部 {impact!.total}</i>}
          </span>
          <span className="detail-field">
            <b>{usage?.length ?? 0}</b> 个导出
          </span>
          {unused > 0 && (
            <span className="detail-field">
              <b className="warn">{unused}</b> 个无人引用
            </span>
          )}
        </>
      ) : summary.length > 0 ? (
        summary.map((s) => (
          <button
            key={s.section}
            className="detail-summary"
            onClick={() => onOpenNotes(s.section)}
            title={`在分析面板中查看${s.label}`}
          >
            <b className={s.tone}>{s.value}</b> {s.label}
          </button>
        ))
      ) : (
        <span className="muted">在侧栏或图上选择一个文件</span>
      )}

      <div className="detail-rail-right">
        {selected && (
          <button className="quiet" onClick={onClear}>
            取消选择
          </button>
        )}
        <button onClick={() => onOpenNotes('hubs')}>分析</button>
      </div>
    </div>
  )
}
