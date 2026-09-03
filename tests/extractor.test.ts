import { beforeAll, describe, expect, it } from 'vitest'
import { extract, extractByRegex, initExtractor } from '../src/core/extractor'

beforeAll(async () => {
  await initExtractor()
})

/** imports 现在是 ImportRecord[]，取 specifier 列表 */
const specs = (r: { imports: { spec: string }[] }) => r.imports.map((i) => i.spec)

/**
 * ADR-006 发现 2：es-module-lexer 吃得下所有 TS 语法，唯独吃不下 JSX。
 * 这组测试把那次探测的结论固化下来——如果哪天 lexer 支持了 JSX，
 * 这里会失败，提醒我们回去简化 extractor。
 */
describe('es-module-lexer 的能力边界', () => {
  const tsCases: Record<string, string> = {
    '类型注解': `import a from './a'; export function f(x: number): string { return '' }`,
    'import type': `import type { A } from './a'; export type B = A`,
    '泛型箭头': `import a from './a'; export const f = <T,>(x: T): T => x`,
    interface: `import a from './a'; export interface I { n: number }`,
    enum: `import a from './a'; export enum E { A, B }`,
    'as satisfies': `import a from './a'; export const c = {} as const satisfies Record<string, number>`,
    装饰器: `import a from './a'; @deco export class C {}`,
  }

  it.each(Object.entries(tsCases))('TS 语法「%s」不需要回退', (_name, src) => {
    const r = extract(src, 'file.ts')
    expect(r.usedFallback).toBe(false)
    expect(specs(r)).toContain('./a')
  })

  it('带属性和文本的 JSX 会回退到正则', () => {
    const src = `import a from './a'\nexport default function C() { return <div className="x">hi</div> }`
    const r = extract(src, 'file.tsx')
    expect(r.usedFallback).toBe(true)
    expect(specs(r)).toContain('./a')
  })

  /**
   * 细化 ADR-006 的结论：lexer 对 JSX 的失败**不是全有全无**。
   * 简单自闭合标签能过，带属性/文本内容的过不了。
   * 所以「回退率」反映的是项目里 JSX 的复杂度，不是 TSX 文件的比例。
   */
  it('简单自闭合 JSX 反而能被 lexer 吃下', () => {
    const r = extract(`import a from './a'\nexport default () => <div/>`, 'file.tsx')
    expect(r.usedFallback).toBe(false)
  })
})

describe('正则提取器', () => {
  it('覆盖四种引入形式', () => {
    const src = `
      import a from './a'
      import './side-effect'
      export { x } from './b'
      const c = await import('./c')
      const d = require('./d')
    `
    expect(specs(extractByRegex(src))).toEqual(
      expect.arrayContaining(['./a', './side-effect', './b', './c', './d'])
    )
  })

  it('忽略注释里的伪 import（假阳性防护）', () => {
    const src = `
      // import fake from './fake-line'
      /* import fake2 from './fake-block' */
      import real from './real'
    `
    const list = specs(extractByRegex(src))
    expect(list).toContain('./real')
    expect(list).not.toContain('./fake-line')
    expect(list).not.toContain('./fake-block')
  })

  it('提取命名导出与默认导出', () => {
    const src = `
      export const a = 1
      export function b() {}
      export class C {}
      export type T = number
      export { d, e as f }
      export default function () {}
    `
    const { exports } = extractByRegex(src)
    expect(exports).toEqual(expect.arrayContaining(['a', 'b', 'C', 'T', 'd', 'f', 'default']))
  })
})

describe('L2 可行性：exports 是否白送', () => {
  it('lexer 路径能返回导出符号名', () => {
    const r = extract(`export const format = 1; export function parse() {}`, 'file.ts')
    expect(r.usedFallback).toBe(false)
    expect(r.exports).toEqual(expect.arrayContaining(['format', 'parse']))
  })

  it('回退路径也能返回导出符号名', () => {
    const r = extract(
      `export const format = 1\nexport default function C() { return <div className="x">hi</div> }`,
      'file.tsx'
    )
    expect(r.usedFallback).toBe(true)
    expect(r.exports).toEqual(expect.arrayContaining(['format', 'default']))
  })
})

/**
 * ADR-023。原来这一组用例全是「含运行时导出的混合模块」，lexer 在那些输入上返回非空，
 * 断言就过了——**没有一个用例是纯类型模块**，于是漏报了 13%–40% 的导出符号而全绿。
 */
describe('类型导出（lexer 看不见的那部分）', () => {
  it('纯类型模块不能返回空导出', () => {
    const r = extract(
      `export type FileNode = { id: string }\nexport interface Opts { a: number }`,
      'types.ts'
    )
    // lexer 成功，所以不会走兜底——正是这一点让原来的 bug 藏住了
    expect(r.usedFallback).toBe(false)
    expect(r.exports).toEqual(expect.arrayContaining(['FileNode', 'Opts']))
  })

  it('type / interface / enum 与运行时导出并存时全都要有', () => {
    const r = extract(
      `export type T = 1
export interface I { a: 1 }
export enum E { A }
export const REAL = 1
export function fn() {}`,
      'mixed.ts'
    )
    expect(r.exports.sort()).toEqual(['E', 'I', 'REAL', 'T', 'fn'])
  })

  it('不会因为合并而产生重复项', () => {
    const r = extract(`export const a = 1\nexport { a as b }`, 'dup.ts')
    expect(new Set(r.exports).size).toBe(r.exports.length)
  })

  it('注释里的 export type 不算数', () => {
    const r = extract(`// export type Ghost = 1\nexport const real = 1`, 'c.ts')
    expect(r.exports).not.toContain('Ghost')
  })
})

/**
 * ADR-025。stripNoise 原来用正则扫全文，不认识字符串字面量。
 * excalidraw 里一个 `"../..//shortcut"` 的笔误，让它把收尾引号一起当注释删掉，
 * 引号配对错位，下一条 import 也被吞掉——而命中率完全看不见。
 */
describe('注释剥离必须是字符串感知的', () => {
  it('字符串里的 // 不是注释，一个笔误不该吃掉下一条 import', () => {
    const src = [
      'import { getShortcutKey } from "../..//shortcut";',
      'import { useAtom } from "../../editor-jotai";',
    ].join('\n')
    const specs = extractByRegex(src).imports.map((i) => i.spec).sort()
    expect(specs).toEqual(['../..//shortcut', '../../editor-jotai'])
  })

  it('字符串里的 /* 也不是注释', () => {
    const src = [
      'const glob = "src/*' + '*/*.ts";',
      'import { a } from "./real";',
    ].join('\n')
    expect(extractByRegex(src).imports.map((i) => i.spec)).toEqual(['./real'])
  })

  it('真正的行注释仍然要剥掉', () => {
    const src = ['// import { ghost } from "./ghost"', 'import { a } from "./real"'].join('\n')
    expect(extractByRegex(src).imports.map((i) => i.spec)).toEqual(['./real'])
  })

  it('真正的块注释仍然要剥掉，且不吞掉后面的语句', () => {
    const src = ['/* import { ghost } from "./ghost"', '   还是注释 */', 'import { a } from "./real"'].join('\n')
    expect(extractByRegex(src).imports.map((i) => i.spec)).toEqual(['./real'])
  })

  it('行注释里的 URL 不会误伤后续代码', () => {
    const src = ['// see https://example.com/a//b', 'import { a } from "./real"'].join('\n')
    expect(extractByRegex(src).imports.map((i) => i.spec)).toEqual(['./real'])
  })

  it('转义引号不会提前结束字符串', () => {
    const src = ['const s = "he said ' + String.fromCharCode(92) + '"// not a comment' + String.fromCharCode(92) + '""', 'import { a } from "./real"'].join('\n')
    expect(extractByRegex(src).imports.map((i) => i.spec)).toEqual(['./real'])
  })
})
