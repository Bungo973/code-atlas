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
import {
  activeFacetCount,
  EMPTY_FILTER,
  type Facet,
  type FileFilter,
  type MatchSet,
  toggleFacet,
} from '../core/search'
import { ancestorsOf, buildTree, defaultExpanded, flattenVisible, type TreeNode } from '../core/tree'
import { STATUS } from './palette'

export function ProjectSidebar({
  fileIds,
  selected,
  onSelect,
  metrics,
  colorOf,
  highlight,
  filter,
  onFilterChange,
  facets,
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
   * 筛选状态由 App 持有，**不是这里的私有 state**。
   * 画布要用同一份命中集合，各存各的迟早会出现「侧栏说 3 个匹配、画布亮 5 个」。
   */
  filter: FileFilter
  onFilterChange: (f: FileFilter) => void
  /** 可选的筛选项，只含真实存在的目录和扩展名 */
  facets: { dirs: Facet[]; exts: Facet[] }
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
        /**
         * **只有文本搜索才强制全展开。**
         *
         * 原来是「只要有任何筛选就全展开」，于是按目录分面筛选时整棵树被摊平，
         * 用户点折叠没有任何反应——因为下一次渲染又被强制展开了（I-10）。
         * 目录筛选是「缩小浏览范围」，树本身还应该正常可折叠；
         * 只有搜索需要展开，否则命中项藏在折叠目录里根本看不到。
         */
        filter.query.trim() ? allDirIds(root) : expanded,
        matches ? (n) => matches.has(n.id) : undefined
      ),
    [root, expanded, matches, filter.query]
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
          value={filter.query}
          onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
          // Esc 清空是搜索框的通用约定，没有它只能一个字一个字退
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter.query) {
              e.stopPropagation()
              onFilterChange({ ...filter, query: '' })
            }
          }}
        />
        {filter.query && (
          <button
            className="sidebar-search-clear"
            onClick={() => onFilterChange({ ...filter, query: '' })}
            title="清空"
          >
            ×
          </button>
        )}
      </div>

      <FilterBar filter={filter} onChange={onFilterChange} facets={facets} />

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

/**
 * 筛选条。**默认折叠**——268px 宽的侧栏里，十几个筛选项换行铺开会把文件树挤没，
 * 而大多数时候用户只是想看看目录结构。折叠时把生效条件数显示在按钮上，
 * 否则收起来之后没人知道当前还筛着东西。
 */
function FilterBar({
  filter,
  onChange,
  facets,
}: {
  filter: FileFilter
  onChange: (f: FileFilter) => void
  facets: { dirs: Facet[]; exts: Facet[] }
}) {
  const [open, setOpen] = useState(false)
  const active = activeFacetCount(filter)

  return (
    <div className="sidebar-filters">
      <div className="sidebar-filters-head">
        <button className="quiet" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} 筛选
          {active > 0 && <b className="filter-count">{active}</b>}
        </button>
        {active > 0 && (
          <button className="quiet" onClick={() => onChange(EMPTY_FILTER)}>
            清空
          </button>
        )}
      </div>

      {/*
        生效中的条件**始终显示**，不管筛选面板开没开。
        原来只在展开时才画出分面按钮，于是从聚合视图下钻进 packages/components
        之后：条件生效了，但那个多级路径根本不在顶层目录的按钮列表里——
        用户看不见自己在筛什么，也没法单独取消，只能整个「清空」。
        这里改成直接渲染 filter 里的值，而不是渲染「可选项里被选中的那些」。
      */}
      {active > 0 && (
        <div className="active-facets">
          {filter.query.trim() && (
            <button
              className="chip chip--on"
              onClick={() => onChange({ ...filter, query: '' })}
              title="移除这个条件"
            >
              搜索 {filter.query.trim()} <i>×</i>
            </button>
          )}
          {filter.dirs.map((d) => (
            <button
              key={d}
              className="chip chip--on"
              onClick={() => onChange({ ...filter, dirs: toggleFacet(filter.dirs, d) })}
              title="移除这个条件"
            >
              {d} <i>×</i>
            </button>
          ))}
          {filter.exts.map((e) => (
            <button
              key={e}
              className="chip chip--on"
              onClick={() => onChange({ ...filter, exts: toggleFacet(filter.exts, e) })}
              title="移除这个条件"
            >
              {e} <i>×</i>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="sidebar-filters-body">
          <FacetGroup
            label="目录"
            items={facets.dirs}
            picked={filter.dirs}
            onToggle={(v) => onChange({ ...filter, dirs: toggleFacet(filter.dirs, v) })}
          />
          <FacetGroup
            label="类型"
            items={facets.exts}
            picked={filter.exts}
            onToggle={(v) => onChange({ ...filter, exts: toggleFacet(filter.exts, v) })}
          />
        </div>
      )}
    </div>
  )
}

function FacetGroup({
  label,
  items,
  picked,
  onToggle,
}: {
  label: string
  items: Facet[]
  picked: string[]
  onToggle: (value: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="facet-group">
      <span className="facet-label">{label}</span>
      <div className="facet-chips">
        {items.map((f) => (
          <button
            key={f.value}
            className={`chip${picked.includes(f.value) ? ' chip--on' : ''}`}
            onClick={() => onToggle(f.value)}
            title={`${f.value} · ${f.count} 个文件`}
          >
            {f.value} <i>{f.count}</i>
          </button>
        ))}
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
