/**
 * 详情栏 —— 选中文件的关键数字，压缩成底部单行。
 *
 * 之前是一整张卡片加一段说明文字；主视图要留给侧栏和画布，
 * 所以只保留路径和三个数字，导出符号明细挪进「分析」面板。
 */

import type { Impact } from '../core/graph'
import type { usageOf } from '../core/symbols'

export function DetailRail({
  selected,
  impact,
  usage,
  onClear,
  onOpenNotes,
}: {
  selected: string | null
  impact: Impact | null
  usage: ReturnType<typeof usageOf> | null
  onClear: () => void
  onOpenNotes: () => void
}) {
  const unused = usage?.filter((u) => u.users.length === 0).length ?? 0

  /**
   * 限了层级就必须同时说出总数，否则「12 个文件受影响」会被读成结论。
   * 层级足够覆盖全部时不加尾巴，免得每次都挂一句废话。
   */
  const truncated = impact !== null && impact.reached.size < impact.total

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
            <b>{impact?.reached.size ?? 0}</b> 个文件受影响
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
      ) : (
        <span className="muted">在侧栏或图上选择一个文件</span>
      )}

      <div className="detail-rail-right">
        {selected && (
          <button className="quiet" onClick={onClear}>
            取消选择
          </button>
        )}
        <button onClick={onOpenNotes}>分析</button>
      </div>
    </div>
  )
}
