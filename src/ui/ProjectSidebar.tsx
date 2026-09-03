/**
 * 侧栏 —— 工程目录树。区域词汇见 docs/UI-VOCABULARY.md。
 *
 * 联动的难点在「从画布定位到侧栏」：被选中的文件可能藏在若干层折叠目录里，
 * 需要先展开全部祖先、再滚动到对应行。树的构建与展平是纯函数（core/tree.ts），
 * 这里只负责渲染与滚动。
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphMetrics } from '../core/graph'
import type { MatchSet } from '../core/search'
import { ancestorsOf, buildTree, defaultExpanded, flattenVisible, type TreeNode } from '../core/tree'
import { STATUS } from './palette'

export function ProjectSidebar({
  fileIds,
  selected,
  onSelect,
  metrics,
  colorOf,
  highlight,
  query,
  onQueryChange,
  matches,
}: {
  fileIds: string[]
  selected: string | null
  onSelect: (id: string | null) => void
  metrics: GraphMetrics
  colorOf: (id: string) => string
  /** 影响范围高亮集合，与画布共享同一份选择状态 */
  highlight: Set<string> | null
  /**
   * 搜索状态由 App 持有，**不是这里的私有 state**。
   * 画布要用同一份命中集合，各存各的迟早会出现「侧栏说 3 个匹配、画布亮 5 个」。
   */
  query: string
  onQueryChange: (q: string) => void
  /** null = 没在筛选。判定逻辑在 core/search.ts，两边共用 */
  matches: MatchSet
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  const root = useMemo(() => buildTree(fileIds), [fileIds])
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(root))

  // 换了仓库就重置展开状态
  useEffect(() => setExpanded(defaultExpanded(root)), [root])

  const rows = useMemo(
    () =>
      flattenVisible(
        root,
        // 搜索时强制全展开，否则命中项还是藏在折叠的目录里
        matches ? allDirIds(root) : expanded,
        matches ? (n) => matches.has(n.id) : undefined
      ),
    [root, expanded, matches]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => 24,
    overscan: 12,
  })

  // 画布上选中某个节点 → 展开它的祖先
  useEffect(() => {
    if (!selected) return
    setExpanded((prev) => {
      const missing = ancestorsOf(selected).filter((a) => !prev.has(a))
      if (missing.length === 0) return prev
      const next = new Set(prev)
      for (const a of missing) next.add(a)
      return next
    })
  }, [selected])

  // 祖先展开后行号才稳定，所以滚动要等 rows 更新完再做
  useEffect(() => {
    if (!selected) return
    const i = rows.findIndex((r) => r.node.id === selected)
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' })
  }, [selected, rows, virtualizer])

  const matchCount = rows.filter((r) => !r.node.isDir).length

  return (
    <div className="panel sidebar">
      <div className="sidebar-search-box">
        <input
          className="sidebar-search"
          placeholder="搜索文件…　空格分词"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          // Esc 清空是搜索框的通用约定，没有它只能一个字一个字退
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              onQueryChange('')
            }
          }}
        />
        {query && (
          <button className="sidebar-search-clear" onClick={() => onQueryChange('')} title="清空">
            ×
          </button>
        )}
      </div>

      <div className="sidebar-body" ref={bodyRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const { node, expanded: isOpen } = rows[v.index]
            const isSelected = node.id === selected
            const dimmed =
              highlight !== null && !node.isDir && !isSelected && !highlight.has(node.id)
            // 用直接入度：传递入度在大仓库里会饱和（excalidraw 里几乎每个文件都是 509），
            // 一列相同的数字没有任何信息量
            const direct = metrics.inDegree.get(node.id) ?? 0

            const cls = [
              'sidebar-row',
              isSelected && 'sidebar-row--selected',
              dimmed && 'sidebar-row--dimmed',
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <div
                key={node.id}
                className={cls}
                style={{
                  position: 'absolute',
                  top: 0,
                  // 左右留出内缩，圆角的选中态才不会贴着面板边
                  left: 6,
                  right: 6,
                  height: v.size,
                  transform: `translateY(${v.start}px)`,
                  paddingLeft: 4 + node.depth * 13,
                }}
                onClick={() => {
                  if (node.isDir) {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(node.id)) next.delete(node.id)
                      else next.add(node.id)
                      return next
                    })
                  } else {
                    onSelect(isSelected ? null : node.id)
                  }
                }}
                title={node.id}
              >
                {node.isDir ? (
                  <span className="sidebar-caret">{isOpen ? '▾' : '▸'}</span>
                ) : (
                  <span
                    className="sidebar-dot"
                    style={{
                      background: colorOf(node.id),
                      outline: metrics.inCycle.has(node.id)
                        ? `1.5px solid ${STATUS.critical}`
                        : undefined,
                    }}
                  />
                )}
                <span className="sidebar-label">{node.name}</span>
                <span className="sidebar-meta">
                  {node.isDir ? node.count : direct > 0 ? direct : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="sidebar-footer">
        {matches ? `${matchCount} / ${fileIds.length} 个文件` : `${fileIds.length} 个文件`}
      </div>
    </div>
  )
}

function allDirIds(root: TreeNode): Set<string> {
  const out = new Set<string>()
  const walk = (n: TreeNode) => {
    for (const c of n.children) {
      if (c.isDir) {
        out.add(c.id)
        walk(c)
      }
    }
  }
  walk(root)
  return out
}
