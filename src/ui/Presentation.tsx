import type { ReactNode } from 'react'
import type { Direction } from '../core/graph'

/** 左侧看当前文件的依赖，右侧看依赖当前文件的文件；文案和方向绑定。 */
export const DIRECTION_OPTIONS: { value: Direction; label: string; description: string }[] = [
  { value: 'dependencies', label: '依赖', description: '当前文件依赖的文件' },
  { value: 'dependents', label: '被依赖', description: '依赖当前文件的文件' },
]

/** 文件身份始终先读文件名，再读路径；不改变对应的跳转行为。 */
export function FilePath({ path, full = false }: { path: string; full?: boolean }) {
  const slash = path.lastIndexOf('/')
  return (
    <span className="file-path" title={path}>
      <span className="file-path-name">{path.slice(slash + 1)}</span>
      {(full || slash >= 0) && (
        <span className="file-path-directory">{full ? path : path.slice(0, slash + 1)}</span>
      )}
    </span>
  )
}

export function Metric({ label, value, unit, tone }: {
  label: string
  value: ReactNode
  unit?: string
  tone?: string
}) {
  return (
    <span className="stat">
      <span className="stat-value">
        <b className={tone}>{value}</b>
        {unit && <span>{unit}</span>}
      </span>
      <span className="stat-label">{label}</span>
    </span>
  )
}

export function SectionHeading({ title, description, children }: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <header className="section-heading">
      <h3>{title}</h3>
      <p>{description}</p>
      {children && <div className="section-metrics">{children}</div>}
    </header>
  )
}

export function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="control-group">
      <span className="control-label">{label}</span>
      {children}
    </div>
  )
}

/** 只统一展示口径：排行收录直接入度大于 0 的文件，而不是全部节点。 */
export function dependencyRankCount(inDegree: ReadonlyMap<string, number>) {
  let count = 0
  for (const degree of inDegree.values()) if (degree > 0) count++
  return count
}
