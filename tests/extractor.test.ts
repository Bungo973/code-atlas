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
