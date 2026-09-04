/** 文件名属于绘制层：布局使用屏幕像素，不参与节点力学或命中区域。 */
import type { Impact } from '../core/graph'
import { isMatch, type MatchSet } from '../core/search'

export const LABEL_FONT_SIZE = 13
export const LABEL_FONT_FAMILY = '"Cascadia Code", Consolas, monospace'
export const LABEL_FADE_START = 1.4
export const LABEL_FADE_END = 2.2

type LabelNode = { id: string; name: string; isGroup: boolean }
export type LabelRect = { x: number; y: number; width: number; height: number }
export type ScreenLabelNode = { id: string; name: string; x: number; y: number; r: number }
export type PlacedLabel = LabelRect & { id: string; text: string }

/** 连续过渡，不在单个缩放阈值处突然出现一整屏文字。 */
export function labelOpacity(scale: number): number {
  if (!Number.isFinite(scale)) return 0
  const t = Math.max(0, Math.min(1, (scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)))
  return t * t * (3 - 2 * t)
}

/** 与图谱共用 Impact / matches；不另算关系，且聚合目录不冒充文件。 */
export function labelCandidates<T extends LabelNode>(
  nodes: readonly T[], selected: string | null, impact: Impact | null, matches: MatchSet
): T[] {
  if (!selected || !impact || impact.root !== selected) return []
  const priority = (id: string) => id === selected ? 0 : impact.depth.get(id) ?? Infinity
  return nodes
    .filter(n => !n.isGroup && isMatch(matches, n.id) && (n.id === selected || impact.reached.has(n.id)))
    .sort((a, b) => priority(a.id) - priority(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const PADDING = 4
const HEIGHT = LABEL_FONT_SIZE + 6
const MARGIN = 8
const GAP = 6

function overlaps(a: LabelRect, b: LabelRect) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y
}

/** 空间网格避免每个标签都扫描全部节点；仅索引视口内的障碍物。 */
class LabelGrid {
  private cells = new Map<string, LabelRect[]>()

  private keys(rect: LabelRect): string[] {
    const keys: string[] = []
    for (let x = Math.floor(rect.x / 64); x <= Math.floor((rect.x + rect.width) / 64); x++) {
      for (let y = Math.floor(rect.y / 64); y <= Math.floor((rect.y + rect.height) / 64); y++) {
        keys.push(`${x}:${y}`)
      }
    }
    return keys
  }

  add(rect: LabelRect) {
    for (const key of this.keys(rect)) {
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(rect)
      else this.cells.set(key, [rect])
    }
  }

  collides(rect: LabelRect) {
    return this.keys(rect).some(key => this.cells.get(key)?.some(other => overlaps(rect, other)))
  }
}

/** 只缩短展示文本，完整路径仍在现有悬停提示中；按码点裁切避免截断 emoji。 */
function fitText(name: string, maxWidth: number, measure: (text: string) => number) {
  if (measure(name) <= maxWidth) return name
  if (measure('…') > maxWidth) return ''
  const chars = Array.from(name)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(chars.slice(0, mid).join('') + '…') <= maxWidth) low = mid
    else high = mid - 1
  }
  return chars.slice(0, low).join('') + '…'
}

/** nodes 按优先级排序；放不下的标签不画，不移动节点、不放大命中区域。 */
export function placeLabels({ nodes, width, height, measure, obstacles = [] }: {
  nodes: readonly ScreenLabelNode[]
  width: number
  height: number
  measure: (text: string) => number
  obstacles?: readonly LabelRect[]
}): PlacedLabel[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MARGIN * 2 || height < HEIGHT + MARGIN * 2) return []
  const grid = new LabelGrid()
  const addObstacle = (rect: LabelRect) => {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return
    const x = Math.max(0, rect.x)
    const y = Math.max(0, rect.y)
    const right = Math.min(width, rect.x + rect.width)
    const bottom = Math.min(height, rect.y + rect.height)
    if (right > x && bottom > y) grid.add({ x, y, width: right - x, height: bottom - y })
  }
  for (const obstacle of obstacles) addObstacle(obstacle)
  const visible = nodes.filter(n => [n.x, n.y, n.r].every(Number.isFinite) && n.r >= 0 &&
    n.x >= 0 && n.x <= width && n.y >= 0 && n.y <= height)
  for (const n of visible) {
    addObstacle({ x: n.x - n.r - 2, y: n.y - n.r - 2, width: (n.r + 2) * 2, height: (n.r + 2) * 2 })
  }

  const labels: PlacedLabel[] = []
  for (const n of visible) {
    const text = fitText(n.name, Math.min(180, width - MARGIN * 2) - PADDING * 2, measure)
    if (!text) continue
    const w = measure(text) + PADDING * 2
    const positions = [
      { x: n.x + n.r + GAP, y: n.y - HEIGHT / 2 },
      { x: n.x - n.r - GAP - w, y: n.y - HEIGHT / 2 },
      { x: n.x - w / 2, y: n.y + n.r + GAP },
      { x: n.x - w / 2, y: n.y - n.r - GAP - HEIGHT },
    ]
    for (const position of positions) {
      const rect = { ...position, width: w, height: HEIGHT }
      if (rect.x < MARGIN || rect.y < MARGIN || rect.x + w > width - MARGIN || rect.y + HEIGHT > height - MARGIN || grid.collides(rect)) continue
      labels.push({ ...rect, id: n.id, text })
      grid.add(rect)
      break
    }
  }
  return labels
}

/** 绘制时把屏幕像素换回图坐标，因此缩放不会把字号和文字描边一起放大。 */
export function paintLabels(ctx: CanvasRenderingContext2D, labels: readonly PlacedLabel[], {
  scale, origin, opacity, selected, foreground, secondary, background,
}: {
  scale: number
  origin: { x: number; y: number }
  opacity: number
  selected: string
  foreground: string
  secondary: string
  background: string
}) {
  if (scale <= 0 || !Number.isFinite(scale) || opacity <= 0) return
  ctx.save()
  ctx.font = `${LABEL_FONT_SIZE / scale}px ${LABEL_FONT_FAMILY}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3 / scale
  ctx.strokeStyle = background
  ctx.globalAlpha = opacity
  for (const label of labels) {
    const x = (label.x + PADDING - origin.x) / scale
    const y = (label.y + label.height / 2 - origin.y) / scale
    ctx.fillStyle = label.id === selected ? foreground : secondary
    ctx.strokeText(label.text, x, y)
    ctx.fillText(label.text, x, y)
  }
  ctx.restore()
}
