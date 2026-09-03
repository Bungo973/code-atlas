/**
 * 目录树。纯函数，与渲染无关，因此可单测。
 *
 * 双向联动的关键在于「从图上的节点定位到树里的某一行」——
 * 需要展开它的全部祖先并算出它在可见行里的下标。这段逻辑放在这里，
 * 而不是散在组件的 effect 里。
 */

export type TreeNode = {
  /** 目录用相对路径，文件用 FileNode.id，两者不会冲突 */
  id: string
  name: string
  depth: number
  isDir: boolean
  /** 该目录（含子孙）下的文件数；文件恒为 1 */
  count: number
  children: TreeNode[]
}

export type VisibleRow = {
  node: TreeNode
  expanded: boolean
}

/** 用文件 id 列表（相对路径）构建目录树，目录在前、同类按名称排序 */
export function buildTree(fileIds: string[]): TreeNode {
  const root: TreeNode = { id: '', name: '', depth: -1, isDir: true, count: 0, children: [] }

  for (const id of fileIds) {
    const parts = id.split('/')
    let cur = root
    let prefix = ''

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      prefix = prefix ? `${prefix}/${name}` : name

      let next = cur.children.find((c) => c.name === name && c.isDir === !isLast)
      if (!next) {
        next = {
          id: isLast ? id : prefix,
          name,
          depth: i,
          isDir: !isLast,
          count: 0,
          children: [],
        }
        cur.children.push(next)
      }
      cur = next
    }
  }

  computeCounts(root)
  sortTree(root)
  return root
}

function computeCounts(node: TreeNode): number {
  if (!node.isDir) {
    node.count = 1
    return 1
  }
  node.count = node.children.reduce((n, c) => n + computeCounts(c), 0)
  return node.count
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of node.children) if (c.isDir) sortTree(c)
}

/**
 * 把树展平成可见行。
 * @param expanded 已展开的目录 id 集合
 * @param match    可选过滤：只保留自身命中、或子孙有命中的分支
 */
export function flattenVisible(
  root: TreeNode,
  expanded: Set<string>,
  match?: (node: TreeNode) => boolean
): VisibleRow[] {
  const rows: VisibleRow[] = []

  const keep = match ? buildKeepSet(root, match) : null

  function walk(node: TreeNode) {
    for (const child of node.children) {
      if (keep && !keep.has(child.id)) continue
      const isExpanded = child.isDir && expanded.has(child.id)
      rows.push({ node: child, expanded: isExpanded })
      if (isExpanded) walk(child)
    }
  }

  walk(root)
  return rows
}

/** 命中的节点及其全部祖先都要保留，否则命中项会因为父目录被过滤掉而消失 */
function buildKeepSet(root: TreeNode, match: (node: TreeNode) => boolean): Set<string> {
  const keep = new Set<string>()

  function visit(node: TreeNode, ancestors: string[]): boolean {
    let anyHit = false
    const chain = node.depth >= 0 ? [...ancestors, node.id] : ancestors

    if (node.depth >= 0 && !node.isDir && match(node)) {
      for (const a of chain) keep.add(a)
      anyHit = true
    }

    for (const c of node.children) {
      if (visit(c, chain)) anyHit = true
    }

    if (anyHit && node.depth >= 0) keep.add(node.id)
    return anyHit
  }

  visit(root, [])
  return keep
}

/** 某个文件 id 的全部祖先目录 id，从最外层到最内层 */
export function ancestorsOf(fileId: string): string[] {
  const parts = fileId.split('/')
  const out: string[] = []
  let prefix = ''
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
    out.push(prefix)
  }
  return out
}

/** 默认展开策略：从根往下，只要某层只有一个目录就继续展开，避免开局是一行 */
export function defaultExpanded(root: TreeNode, maxDepth = 2): Set<string> {
  const out = new Set<string>()

  function walk(node: TreeNode, depth: number) {
    for (const c of node.children) {
      if (!c.isDir) continue
      const onlyChild = node.children.filter((x) => x.isDir).length === 1
      if (depth < maxDepth || onlyChild) {
        out.add(c.id)
        walk(c, depth + 1)
      }
    }
  }

  walk(root, 0)
  return out
}
