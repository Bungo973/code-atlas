import { describe, expect, it } from 'vitest'
import { parseImportClause } from '../src/core/extractor'
import { findSuspectedDeadSymbols, groupByFile, usageOf } from '../src/core/symbols'
import type { ExportSymbol, SymbolEdge } from '../src/core/types'

describe('parseImportClause', () => {
  const clause = (s: string) => parseImportClause(s)

  it('默认导入', () => {
    expect(clause(`import App from './x'`)).toEqual({
      names: [],
      hasDefault: true,
      isNamespace: false,
    })
  })

  it('具名导入', () => {
    expect(clause(`import { a, b } from './x'`)).toMatchObject({
      names: ['a', 'b'],
      hasDefault: false,
    })
  })

  it('别名导入记录的是源名，不是本地名', () => {
    expect(clause(`import { format as fmt } from './x'`).names).toEqual(['format'])
  })

  it('默认 + 具名混合', () => {
    expect(clause(`import App, { a, b } from './x'`)).toMatchObject({
      names: ['a', 'b'],
      hasDefault: true,
    })
  })

  it('import type 与内联 type 修饰都要剥掉', () => {
    expect(clause(`import type { T } from './x'`).names).toEqual(['T'])
    expect(clause(`import { type T, v } from './x'`).names).toEqual(['T', 'v'])
  })

  it('命名空间导入', () => {
    expect(clause(`import * as ns from './x'`)).toMatchObject({ isNamespace: true })
  })

  it('默认 + 命名空间混合也算命名空间', () => {
    expect(clause(`import App, * as ns from './x'`)).toMatchObject({
      isNamespace: true,
      hasDefault: true,
    })
  })

  it('re-export 的具名列表', () => {
    expect(clause(`export { a, b as c } from './x'`).names).toEqual(['a', 'b'])
  })

  it('export * 视为命名空间——否则死代码会大面积误报', () => {
    expect(clause(`export * from './x'`)).toMatchObject({ isNamespace: true })
  })

  it('无绑定的副作用导入不产生任何符号引用', () => {
    expect(clause(`import './side-effect'`)).toEqual({
      names: [],
      hasDefault: false,
      isNamespace: false,
    })
  })

  it('多行具名导入', () => {
    expect(clause(`import {\n  a,\n  b,\n} from './x'`).names).toEqual(['a', 'b'])
  })
})

describe('findSuspectedDeadSymbols', () => {
  const sym = (file: string, name: string): ExportSymbol => ({
    id: `${file}#${name}`,
    file,
    name,
    kind: 'unknown',
    line: 0,
  })
  const edge = (source: string, target: string): SymbolEdge => ({ source, target })

  const base = {
    namespaceImported: new Set<string>(),
    entryPoints: new Set<string>(),
  }

  it('有入边的符号不算死代码', () => {
    const r = findSuspectedDeadSymbols({
      ...base,
      symbols: [sym('a.ts', 'used'), sym('a.ts', 'unused')],
      symbolEdges: [edge('b.ts', 'a.ts#used')],
    })
    expect(r.suspects.map((s) => s.name)).toEqual(['unused'])
    expect(r.excused.hasImporter).toBe(1)
  })

  it('命名空间导入的文件，全部导出都豁免', () => {
    const r = findSuspectedDeadSymbols({
      ...base,
      namespaceImported: new Set(['a.ts']),
      symbols: [sym('a.ts', 'x'), sym('a.ts', 'y')],
      symbolEdges: [],
    })
    expect(r.suspects).toHaveLength(0)
    expect(r.excused.namespaceImported).toBe(2)
  })

  it('入口点的导出单独归类，不当死代码', () => {
    const r = findSuspectedDeadSymbols({
      ...base,
      entryPoints: new Set(['main.tsx']),
      symbols: [sym('main.tsx', 'x')],
      symbolEdges: [],
    })
    expect(r.suspects).toHaveLength(0)
    expect(r.excused.entryPoint).toBe(1)
  })

  it('豁免优先级：有入边 > 命名空间 > 入口点', () => {
    const r = findSuspectedDeadSymbols({
      namespaceImported: new Set(['a.ts']),
      entryPoints: new Set(['a.ts']),
      symbols: [sym('a.ts', 'x')],
      symbolEdges: [edge('b.ts', 'a.ts#x')],
    })
    expect(r.excused).toEqual({ hasImporter: 1, namespaceImported: 0, entryPoint: 0 })
  })
})

describe('groupByFile', () => {
  it('按符号数降序归组', () => {
    const s = (f: string, n: string): ExportSymbol => ({
      id: `${f}#${n}`,
      file: f,
      name: n,
      kind: 'unknown',
      line: 0,
    })
    expect(groupByFile([s('a.ts', 'x'), s('b.ts', 'p'), s('b.ts', 'q')])).toEqual([
      { file: 'b.ts', names: ['p', 'q'] },
      { file: 'a.ts', names: ['x'] },
    ])
  })
})

describe('usageOf', () => {
  const symbols: ExportSymbol[] = [
    { id: 'a.ts#hot', file: 'a.ts', name: 'hot', kind: 'unknown', line: 0 },
    { id: 'a.ts#cold', file: 'a.ts', name: 'cold', kind: 'unknown', line: 0 },
    { id: 'b.ts#other', file: 'b.ts', name: 'other', kind: 'unknown', line: 0 },
  ]
  const edges: SymbolEdge[] = [
    { source: 'x.ts', target: 'a.ts#hot' },
    { source: 'y.ts', target: 'a.ts#hot' },
    { source: 'x.ts', target: 'a.ts#hot' }, // 重复引用只算一个使用方
  ]

  it('只返回该文件的符号，按使用方数量降序', () => {
    expect(usageOf('a.ts', symbols, edges)).toEqual([
      { name: 'hot', users: ['x.ts', 'y.ts'] },
      { name: 'cold', users: [] },
    ])
  })
})
