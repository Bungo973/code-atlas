import { describe, expect, it } from 'vitest'
import { analyze, type SourceFile, type TsconfigSource } from '../src/core/analyze'
import { normalizeKey } from '../src/core/path'
import { looksLikeAlias, resolveImport } from '../src/core/resolver'
import type { ResolveContext } from '../src/core/types'

/** 用内存文件构造一次分析。analyze 的读取是注入的，所以完全不需要碰文件系统 */
function run(
  root: string,
  fileMap: Record<string, string>,
  extraPaths: string[] = [],
  tsconfigs: TsconfigSource[] = []
) {
  const files: SourceFile[] = Object.entries(fileMap).map(([path, text]) => ({
    path,
    read: async () => text,
  }))
  const allPaths = new Set([...Object.keys(fileMap), ...extraPaths].map(normalizeKey))
  return analyze({ root, files, allPaths, tsconfigs, concurrency: 4 })
}

describe('别名作用域：最近祖先的 tsconfig', () => {
  /**
   * ADR-012 的回归测试。
   *
   * 用户选中 monorepo 父目录，而 tsconfig 在 web/ 子目录下。
   * 修复前：所有 `@/...` 被判成外部包，76 个文件只连出 9 条边，
   * 而命中率显示 100%——指标完全看不见这个失败。
   */
  const ROOT = '/repo'
  const TSCONFIG: TsconfigSource = {
    path: '/repo/web/tsconfig.json',
    text: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  }
  const FILES = {
    '/repo/web/src/main.tsx': `import App from '@/App'`,
    '/repo/web/src/App.tsx': `export default function App() { return null }`,
  }

  it('嵌套 tsconfig 未被收集时，图会空掉——但命中率仍是 100%', async () => {
    const r = await run(ROOT, FILES, [], [])
    expect(r.edges).toHaveLength(0)
    expect(r.stats.external).toBe(1)
    // 这就是那个盲区：分母里一个都没有，命中率照样满分
    expect(r.stats.failed.unresolved).toBe(0)
  })

  it('新指标能抓到它：aliasLike 计数 > 0', async () => {
    const r = await run(ROOT, FILES, [], [])
    expect(r.stats.externalAliasLike).toBe(1)
  })

  it('收集到嵌套 tsconfig 后，边正常连上', async () => {
    const r = await run(ROOT, FILES, [], [TSCONFIG])
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0]).toMatchObject({
      source: 'web/src/main.tsx',
      target: 'web/src/App.tsx',
    })
    expect(r.stats.externalAliasLike).toBe(0)
  })

  it('多份 tsconfig 时取最近祖先，而非根目录那份', async () => {
    const rootCfg: TsconfigSource = {
      path: '/repo/tsconfig.json',
      text: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./wrong/*'] } } }),
    }
    const r = await run(
      ROOT,
      FILES,
      ['/repo/wrong/App.tsx'],
      // 故意把根配置排在前面，验证排序逻辑而非输入顺序在起作用
      [rootCfg, TSCONFIG]
    )
    expect(r.edges[0].target).toBe('web/src/App.tsx')
  })

  it('没有 paths 的 tsconfig 不产生作用域', async () => {
    const empty: TsconfigSource = {
      path: '/repo/web/tsconfig.json',
      text: JSON.stringify({ compilerOptions: { strict: true } }),
    }
    const r = await run(ROOT, FILES, [], [empty])
    expect(r.aliasScopes).toHaveLength(0)
    expect(r.stats.externalAliasLike).toBe(1)
  })
})

describe('looksLikeAlias', () => {
  it.each(['@/components/x', '~/lib/y', '#internal/z'])('%s 像别名', (s) => {
    expect(looksLikeAlias(s)).toBe(true)
  })

  it.each(['react', '@scope/pkg', 'lodash-es/merge', './rel', '../up'])(
    '%s 不像别名',
    (s) => {
      expect(looksLikeAlias(s)).toBe(false)
    }
  )

  it('npm 作用域包不会被误报——这是区分的关键', () => {
    const ctx: ResolveContext = { root: '/r', aliases: [], baseDir: '/r', has: () => false }
    expect(resolveImport('@scope/pkg', '/r/a.ts', ctx)).toEqual({
      status: 'external',
      aliasLike: false,
    })
    expect(resolveImport('@/pkg', '/r/a.ts', ctx)).toEqual({
      status: 'external',
      aliasLike: true,
    })
  })
})

describe('analyze 产出', () => {
  it('节点、边、导出符号都能正确产出', async () => {
    const r = await run('/repo', {
      '/repo/a.ts': `import { b } from './b'\nexport const a = 1`,
      '/repo/b.ts': `export const b = 2\nexport function helper() {}`,
    })
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['a.ts', 'b.ts'])
    expect(r.edges).toEqual([
      expect.objectContaining({ source: 'a.ts', target: 'b.ts', raw: './b' }),
    ])
    expect(r.symbols.map((s) => s.id).sort()).toEqual(['a.ts#a', 'b.ts#b', 'b.ts#helper'])
  })

  /**
   * 回归：解析到真实文件但目标非代码文件时，不能产生边。
   * 否则 analyze 报的「依赖边」会比图上实际的边多，两个数字对不上（Day 8 截图暴露：153 vs 164）。
   */
  it('import 到真实存在的 .css 归为 asset，不产生悬空边', async () => {
    const r = await run(
      '/repo',
      { '/repo/App.tsx': `import './App.css'\nimport './b'` },
      ['/repo/App.css', '/repo/b.ts']
    )
    expect(r.stats.asset).toBe(1)
    expect(r.edges.map((e) => e.target)).toEqual(['b.ts'])
  })

  it('import 到真实存在的 .json 同样不产生边', async () => {
    const r = await run('/repo', { '/repo/a.ts': `import cfg from './cfg.json'` }, [
      '/repo/cfg.json',
    ])
    expect(r.edges).toHaveLength(0)
    expect(r.stats.asset).toBe(1)
  })

  /**
   * 提取器按 specifier 合并同一文件的多条 import 语句，
   * 所以「一次解析」的单位是 (文件, specifier) 对，而不是 import 语句条数。
   * 但符号级引用必须两条都保留——否则 T 会被误判成死代码。
   */
  it('同一目标的多条导入合并成一次解析、一条边，但符号引用都保留', async () => {
    const r = await run('/repo', {
      '/repo/a.ts': `import type { T } from './b'\nimport { v } from './b'`,
      '/repo/b.ts': `export const v = 1\nexport type T = number`,
    })
    expect(r.edges).toHaveLength(1)
    expect(r.stats.resolved).toBe(1)
    expect(r.symbolEdges.map((e) => e.target).sort()).toEqual(['b.ts#T', 'b.ts#v'])
  })

  it('符号级连边：谁用了谁的哪个导出', async () => {
    const r = await run('/repo', {
      '/repo/app.ts': `import { format as fmt } from './util'\nimport def from './util'`,
      '/repo/util.ts': `export const format = 1\nexport default function () {}`,
    })
    expect(r.symbolEdges.map((e) => e.target).sort()).toEqual([
      'util.ts#default',
      'util.ts#format',
    ])
    expect(r.symbolEdges.every((e) => e.source === 'app.ts')).toBe(true)
  })

  it('命名空间导入会把目标文件整体标记为已使用', async () => {
    const r = await run('/repo', {
      '/repo/app.ts': `import * as ns from './util'`,
      '/repo/util.ts': `export const a = 1\nexport const b = 2`,
    })
    expect(r.namespaceImported.has('util.ts')).toBe(true)
    expect(r.symbolEdges).toHaveLength(0)
  })

  it('行数统计正确', async () => {
    const r = await run('/repo', { '/repo/a.ts': 'const a = 1\nconst b = 2\nconst c = 3' })
    expect(r.nodes[0].loc).toBe(3)
  })
})
