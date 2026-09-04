import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import Graph from 'graphology'
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze'
import { scanDemo } from '../src/adapters/demo'
import { buildGraph, computeMetrics, impactOf } from '../src/core/graph'
import { usageOf } from '../src/core/symbols'
import { EMPTY_FILTER } from '../src/core/search'
import { DetailRail } from '../src/ui/DetailRail'
import { NotesDrawer, type SectionId } from '../src/ui/NotesDrawer'
import { dependencyRankCount, DIRECTION_OPTIONS, FilePath } from '../src/ui/Presentation'
import { ProjectSidebar } from '../src/ui/ProjectSidebar'

const scan = await scanDemo()
const result = await analyze({ root: scan.root, files: scan.files, allPaths: scan.allPaths, tsconfigs: scan.tsconfigs })
const graph = buildGraph(result.nodes, result.edges)
const metrics = computeMetrics(graph)
const noop = () => {}
const text = (html: string) => html.replace(/<[^>]*>/g, '')
const detail = (selected: string | null = null, direction: 'dependents' | 'dependencies' = 'dependents', depth = 2) =>
  renderToStaticMarkup(createElement(DetailRail, {
    selected,
    impact: selected ? impactOf(graph, selected, depth, direction) : null,
    usage: selected ? usageOf(selected, result.symbols, result.symbolEdges) : null,
    metrics, deadCount: 0, onClear: noop, onOpenNotes: noop,
  }))
const notes = (section: SectionId) => renderToStaticMarkup(createElement(NotesDrawer, {
  metrics, result, scan, deadCode: null, concurrency: 32,
  onConcurrencyChange: noop, initialSection: section, onSelect: noop, onClose: noop,
}))

describe('展示层的身份与统计口径', () => {
  it('关系方向从左到右为依赖、被依赖，并与真实方向绑定', () => {
    expect(DIRECTION_OPTIONS.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: '依赖', value: 'dependencies' },
      { label: '被依赖', value: 'dependents' },
    ])
    const chain = new Graph({ type: 'directed' })
    for (const id of ['caller.ts', 'current.ts', 'utility.ts']) chain.addNode(id)
    chain.addDirectedEdge('caller.ts', 'current.ts')
    chain.addDirectedEdge('current.ts', 'utility.ts')
    expect([...impactOf(chain, 'current.ts', 1, DIRECTION_OPTIONS[0].value).reached]).toEqual(['utility.ts'])
    expect([...impactOf(chain, 'current.ts', 1, DIRECTION_OPTIONS[1].value).reached]).toEqual(['caller.ts'])
  })

  it.each([false, true])('文件侧栏不再显示底部文件总数（筛选：%s）', (filtered) => {
    const html = renderToStaticMarkup(createElement(ProjectSidebar, {
      fileIds: result.nodes.map(n => n.id), selected: null, onSelect: noop,
      metrics, colorOf: () => '#3987e5', highlight: null,
      filter: filtered ? { ...EMPTY_FILTER, query: 'not-a-real-file' } : EMPTY_FILTER,
      onFilterChange: noop, facets: { dirs: [], exts: [] },
      matches: filtered ? new Set<string>() : null,
    }))
    expect(html).not.toContain('sidebar-footer')
    expect(text(html)).not.toContain('个文件')
    expect(text(html)).toContain('工程文件')
    if (filtered) expect(text(html)).toContain('没有匹配的文件')
  })

  it('依赖排行只计算直接入度大于零的文件', () => {
    expect(dependencyRankCount(new Map([['a', 0], ['b', 2], ['c', 1]]))).toBe(2)
    expect(dependencyRankCount(new Map())).toBe(0)
    const count = dependencyRankCount(metrics.inDegree)
    expect(text(detail())).toContain(`${count}文件依赖排行`)
    expect(text(notes('hubs'))).toContain(`依赖排行${count}`)
    expect(count).toBeLessThan(metrics.inDegree.size)
  })

  it('路径保留完整身份，同时把文件名与目录分层', () => {
    const path = 'packages/very-long-directory/中文目录/component.test.ts'
    const html = renderToStaticMarkup(createElement(FilePath, { path }))
    expect(html).toContain(`title="${path}"`)
    expect(html).toContain('file-path-name">component.test.ts')
    expect(html).toContain('file-path-directory">packages/very-long-directory/中文目录/')
    const root = renderToStaticMarkup(createElement(FilePath, { path: 'main.ts' }))
    expect(root).not.toContain('file-path-directory')
  })

  it('路径中的 HTML 字符被转义，不成为页面元素', () => {
    const html = renderToStaticMarkup(createElement(FilePath, { path: 'src/<script>.ts' }))
    expect(html).toContain('&lt;script&gt;.ts')
    expect(html).not.toContain('<script>')
  })

  it('切换方向只改变对应的关系说明，当前范围和全部范围都可见', () => {
    const reverse = text(detail('src/core/types.ts'))
    const forward = text(detail('src/core/types.ts', 'dependencies'))
    expect(reverse).toContain('受它影响的文件')
    expect(forward).toContain('它依赖的文件')
    expect(forward).not.toContain('受它影响的文件')
    for (const content of [reverse, forward]) {
      expect(content).toContain('当前 2 跳 · 全部可达')
      expect(content).toContain('导出符号')
      expect(content).toContain('取消选择')
    }
  })

  it('不限跳数不泄漏 Infinity，且上下文不重复放置全局分析按钮', () => {
    expect(text(detail('src/core/types.ts', 'dependents', Infinity))).toContain('不限跳数')
    expect(text(detail('src/core/types.ts', 'dependents', Infinity))).not.toContain('Infinity')
    expect(detail()).not.toContain('>项目分析</button>')
  })

  it('循环组数和涉及文件数分开标注，每个成员仍有独立按钮', () => {
    const html = notes('cycles')
    expect(text(html)).toContain(`${metrics.cycles.length}组循环依赖`)
    expect(text(html)).toContain(`${metrics.inCycle.size}文件涉及文件`)
    expect((html.match(/class="link-row"/g) ?? []).length).toBe(metrics.cycles.flat().length)
  })

  it('零疑似死代码不宣称所有导出都有人使用', () => {
    const content = text(notes('dead'))
    expect(content).toContain('未发现符合当前规则的疑似死代码')
    expect(content).toContain('不代表可以直接删除')
  })

  it('解析报告保留四个信息分区、命中率及并发说明', () => {
    const content = text(notes('report'))
    for (const label of ['概览', '分析耗时', '依赖解析', '诊断信息', '解析命中率', '改完需要重新分析才生效']) {
      expect(content).toContain(label)
    }
    expect(content).not.toContain('准确率')
  })

  it('必要文字主题色在所有基础表面上达到 4.5:1', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    const color = (name: string) => {
      const hex = css.match(new RegExp(`--${name}: (#\\w{6});`))?.[1]
      expect(hex, name).toBeDefined()
      return hex!
    }
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    for (const foreground of ['ink', 'ink-2', 'ink-3']) {
      for (const background of ['plane', 'panel', 'panel-2', 'stage']) {
        const ratio = (luminance(color(foreground)) + 0.05) / (luminance(color(background)) + 0.05)
        expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(color('stage')).toBe('#1a1a19')
    expect(css).toContain('--ink-muted: var(--ink-3)')
  })
})
