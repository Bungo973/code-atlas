import { describe, expect, it, vi } from 'vitest'
import type { Impact } from '../src/core/graph'
import {
  LABEL_FADE_END, LABEL_FADE_START, LABEL_FONT_SIZE,
  labelCandidates, labelOpacity, paintLabels, placeLabels,
  type PlacedLabel, type ScreenLabelNode,
} from '../src/ui/nodeLabels'

const nodes = ['far.ts', 'near-b.ts', 'root.ts', 'near-a.ts', 'unrelated.ts', 'outside.ts']
  .map(id => ({ id, name: id, isGroup: false }))
const impact: Impact = {
  root: 'root.ts', direction: 'dependents', maxDepth: 2, farthest: 3, total: 4,
  depth: new Map([['near-a.ts', 1], ['near-b.ts', 1], ['far.ts', 2], ['outside.ts', 3]]),
  reached: new Set(['near-a.ts', 'near-b.ts', 'far.ts']),
}
const measure = (text: string) => Array.from(text).length * 7
const node = (id: string, x = 250, y = 150): ScreenLabelNode => ({ id, name: id, x, y, r: 8 })
const place = (items: ScreenLabelNode[]) => placeLabels({ nodes: items, width: 500, height: 300, measure })

describe('文件名的出现条件', () => {
  it('未选中、不完整的关系状态以及目录聚合都不显示文件名', () => {
    expect(labelCandidates(nodes, null, null, null)).toEqual([])
    expect(labelCandidates(nodes, 'root.ts', null, null)).toEqual([])
    expect(labelCandidates(nodes, 'new.ts', impact, null)).toEqual([])
    expect(labelCandidates(nodes.map(n => ({ ...n, isGroup: true })), 'root.ts', impact, null)).toEqual([])
  })

  it('只包含当前关系范围，并按选中、直接、间接的顺序稳定排序', () => {
    const expected = ['root.ts', 'near-a.ts', 'near-b.ts', 'far.ts']
    expect(labelCandidates(nodes, 'root.ts', impact, null).map(n => n.id)).toEqual(expected)
    expect(labelCandidates([...nodes].reverse(), 'root.ts', impact, null).map(n => n.id)).toEqual(expected)
    expect(nodes[0].id).toBe('far.ts') // 不修改传入节点数组
  })

  it('筛选优先：连选中节点被筛掉时也不会泄漏它的标签', () => {
    expect(labelCandidates(nodes, 'root.ts', impact, new Set(['far.ts'])).map(n => n.id)).toEqual(['far.ts'])
    expect(labelCandidates(nodes, 'root.ts', impact, new Set())).toEqual([])
  })

  it('方向、跳数变化直接采用新 Impact，不沿用上一次的节点名单', () => {
    const forward: Impact = { ...impact, direction: 'dependencies', depth: new Map([['outside.ts', 1]]), reached: new Set(['outside.ts']) }
    expect(labelCandidates(nodes, 'root.ts', forward, null).map(n => n.id)).toEqual(['root.ts', 'outside.ts'])
    expect(labelCandidates(nodes, 'root.ts', { ...impact, maxDepth: 1, reached: new Set(['near-a.ts']) }, null).map(n => n.id))
      .toEqual(['root.ts', 'near-a.ts'])
  })

  it('缩小时隐藏，放大时连续淡入，没有二值开关式跳变', () => {
    expect(labelOpacity(0.5)).toBe(0)
    expect(labelOpacity(LABEL_FADE_START)).toBe(0)
    expect(labelOpacity((LABEL_FADE_START + LABEL_FADE_END) / 2)).toBeCloseTo(0.5)
    expect(labelOpacity(LABEL_FADE_END)).toBe(1)
    expect(labelOpacity(4)).toBe(1)
    expect(labelOpacity(NaN)).toBe(0)
    expect(labelOpacity(LABEL_FADE_START + 0.001)).toBeLessThan(0.001)
  })
})

describe('屏幕空间内的标签避让', () => {
  it('密集标签不重叠，优先节点先占位置，其余放不下就隐藏', () => {
    const labels = place(['root.ts', 'one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts'].map(id => node(id)))
    expect(labels[0].id).toBe('root.ts')
    expect(labels.length).toBeLessThan(6)
    for (let i = 0; i < labels.length; i++) {
      const a = labels[i]
      for (const b of labels.slice(i + 1)) {
        expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false)
      }
    }
  })

  it('避开关联节点本身，而不是把文字盖在另一个圆上', () => {
    const labels = place([node('root.ts'), node('near.ts', 290, 150)])
    for (const label of labels) {
      for (const n of [node('root.ts'), node('near.ts', 290, 150)]) {
        expect(label.x < n.x + n.r && label.x + label.width > n.x - n.r && label.y < n.y + n.r && label.y + label.height > n.y - n.r).toBe(false)
      }
    }
  })

  it('靠边时换方向摆放，标签始终完整留在绘图区内', () => {
    const labels = place([node('right.ts', 490, 150), node('left.ts', 10, 70), node('top.ts', 250, 5)])
    expect(labels).toHaveLength(3)
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(8)
      expect(label.y).toBeGreaterThanOrEqual(8)
      expect(label.x + label.width).toBeLessThanOrEqual(492)
      expect(label.y + label.height).toBeLessThanOrEqual(292)
    }
  })

  it('视口外和坐标未初始化的节点不生成标签', () => {
    expect(place([node('left.ts', -10), node('right.ts', 501), node('unset.ts', NaN)])).toEqual([])
  })

  it('图例等保留区域内不绘制文字', () => {
    expect(placeLabels({ nodes: [node('root.ts')], width: 500, height: 300, measure,
      obstacles: [{ x: 0, y: 0, width: 500, height: 300 }] })).toEqual([])
  })

  it('长文件名截断但保留原始身份；不截断 Unicode 码点', () => {
    const id = '组件🙂'.repeat(30) + '.tsx'
    const label = place([node(id)])[0]
    expect(label.id).toBe(id)
    expect(label.text.endsWith('…')).toBe(true)
    expect(label.width).toBeLessThanOrEqual(180)
    expect(Array.from(label.text).some(c => c.length === 1 && /[\uD800-\uDFFF]/.test(c))).toBe(false)
  })

  it('很小的绘图区不会产生越界标签', () => {
    expect(placeLabels({ nodes: [node('a.ts', 2, 2)], width: 12, height: 12, measure })).toEqual([])
  })
})

describe('绘制不改变图谱尺寸与命中区域', () => {
  it('屏幕字号和描边宽度固定，不随缩放膨胀', () => {
    const label: PlacedLabel = { id: 'root.ts', text: 'root.ts', x: 240, y: 130, width: 70, height: 19 }
    for (const scale of [1.5, 2, 4]) {
      const ctx = { save: vi.fn(), restore: vi.fn(), strokeText: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D
      paintLabels(ctx, [label], { scale, origin: { x: 100, y: 50 }, opacity: 0.7, selected: 'root.ts', foreground: '#fff', secondary: '#ccc', background: '#111' })
      expect(parseFloat(ctx.font) * scale).toBe(LABEL_FONT_SIZE)
      expect(ctx.lineWidth * scale).toBe(3)
      expect(ctx.globalAlpha).toBe(0.7)
      expect(ctx.fillStyle).toBe('#fff')
      expect(ctx.fillText).toHaveBeenCalledWith('root.ts', (244 - 100) / scale, (139.5 - 50) / scale)
      expect(ctx.restore).toHaveBeenCalledOnce()
    }
  })
})
