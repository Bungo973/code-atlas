import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  buildTree,
  defaultExpanded,
  flattenVisible,
  type TreeNode,
} from '../src/core/tree'

const FILES = [
  'src/App.tsx',
  'src/main.tsx',
  'src/api/types.ts',
  'src/api/endpoints.ts',
  'src/components/ui/button.tsx',
  'vite.config.ts',
]

const ids = (rows: { node: TreeNode }[]) => rows.map((r) => r.node.id)
const allDirs = (root: TreeNode): Set<string> => {
  const s = new Set<string>()
  const walk = (n: TreeNode) => {
    for (const c of n.children) {
      if (c.isDir) {
        s.add(c.id)
        walk(c)
      }
    }
  }
  walk(root)
  return s
}

describe('buildTree', () => {
  const root = buildTree(FILES)

  it('目录排在文件前面', () => {
    expect(root.children.map((c) => c.name)).toEqual(['src', 'vite.config.ts'])
  })

  it('同类按名称排序', () => {
    const src = root.children[0]
    expect(src.children.map((c) => c.name)).toEqual([
      'api',
      'components',
      'App.tsx',
      'main.tsx',
    ])
  })

  it('目录的 count 是子孙文件数', () => {
    expect(root.children[0].count).toBe(5) // src 下 5 个文件
    expect(root.children[0].children[0].count).toBe(2) // src/api 下 2 个
  })

  it('文件节点的 id 就是原始 id，目录用路径前缀', () => {
    const api = root.children[0].children[0]
    expect(api.id).toBe('src/api')
    expect(api.children.map((c) => c.id)).toEqual(['src/api/endpoints.ts', 'src/api/types.ts'])
  })

  it('同名的目录与文件不会互相吞并', () => {
    const r = buildTree(['x/a.ts', 'x.ts'])
    expect(r.children.map((c) => `${c.name}:${c.isDir}`)).toEqual(['x:true', 'x.ts:false'])
  })
})

describe('flattenVisible', () => {
  const root = buildTree(FILES)

  it('未展开时只显示顶层', () => {
    expect(ids(flattenVisible(root, new Set()))).toEqual(['src', 'vite.config.ts'])
  })

  it('展开一层后显示其子项', () => {
    const rows = flattenVisible(root, new Set(['src']))
    expect(ids(rows)).toEqual([
      'src',
      'src/api',
      'src/components',
      'src/App.tsx',
      'src/main.tsx',
      'vite.config.ts',
    ])
  })

  it('全部展开时深层文件可见', () => {
    const rows = flattenVisible(root, allDirs(root))
    expect(ids(rows)).toContain('src/components/ui/button.tsx')
  })
})

describe('flattenVisible 的过滤', () => {
  const root = buildTree(FILES)

  it('命中文件的祖先目录会被保留，否则命中项会消失', () => {
    const rows = flattenVisible(root, allDirs(root), (n) => n.id.includes('button'))
    expect(ids(rows)).toEqual([
      'src',
      'src/components',
      'src/components/ui',
      'src/components/ui/button.tsx',
    ])
  })

  it('无命中时返回空', () => {
    expect(flattenVisible(root, allDirs(root), () => false)).toEqual([])
  })

  it('多个命中分散在不同目录时都保留', () => {
    const rows = flattenVisible(root, allDirs(root), (n) => n.name.endsWith('.ts'))
    expect(ids(rows)).toEqual(
      expect.arrayContaining(['src/api/types.ts', 'src/api/endpoints.ts', 'vite.config.ts'])
    )
    expect(ids(rows)).not.toContain('src/App.tsx')
  })
})

describe('ancestorsOf', () => {
  it('从最外层到最内层', () => {
    expect(ancestorsOf('src/components/ui/button.tsx')).toEqual([
      'src',
      'src/components',
      'src/components/ui',
    ])
  })

  it('顶层文件没有祖先', () => {
    expect(ancestorsOf('vite.config.ts')).toEqual([])
  })
})

describe('defaultExpanded', () => {
  it('单链目录会一直展开，避免开局只有一行', () => {
    const root = buildTree(['a/b/c/d/deep.ts'])
    const exp = defaultExpanded(root, 0)
    expect(exp.has('a')).toBe(true)
    expect(exp.has('a/b/c')).toBe(true)
  })

  it('展开后能定位到深层文件', () => {
    const root = buildTree(FILES)
    const rows = flattenVisible(root, defaultExpanded(root))
    expect(ids(rows)).toContain('src/api/types.ts')
  })
})
