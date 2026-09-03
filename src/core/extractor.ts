/**
 * 从源码里提取 import 记录和 export 符号名。
 *
 * 实测结论（ADR-006）：es-module-lexer 能吃下所有 TS 语法
 * （类型注解、import type、泛型、interface、enum、装饰器、as satisfies），
 * 但吃不下带属性/文本内容的 JSX。React 项目里正则回退承担 35%–77% 的工作量，
 * 不是「兜底」而是主力之一。
 */

import { init, parse } from 'es-module-lexer'

export type ImportRecord = {
  spec: string
  /** 具名导入的**源名**（`import { a as b }` 记 a），用于 L2 的符号级连边 */
  names: string[]
  /** 是否有默认导入 */
  hasDefault: boolean
  /**
   * `import * as ns` / `export * from`。
   * 命名空间导入无法确定用了哪些符号，**目标文件的所有导出都必须视为已使用**，
   * 否则死代码检测会大面积误报。
   */
  isNamespace: boolean
}

export type ExtractResult = {
  imports: ImportRecord[]
  /** 导出符号名，用于 L2。es-module-lexer 白送，见 ADR-003 */
  exports: string[]
  /** 是否走了正则回退。用于统计 lexer 覆盖率 */
  usedFallback: boolean
}

let ready: Promise<unknown> | null = null

/** 必须在首次 extract 前 await。es-module-lexer 的 WASM 需要初始化 */
export function initExtractor(): Promise<unknown> {
  ready ??= init
  return ready
}

/**
 * 子句部分用 `[^'"]*?` 而非 `[\s\S]*?`，且可选组写成 `??`（惰性）。
 *
 * 用 `[\s\S]*?` + 贪婪 `?` 会让 `import './side-effect'` 被静默吞掉：
 * 可选组跨行向前扫描，一直匹配到下一条语句的 ` from `，把整条无绑定 import
 * 吞进匹配区间。**这类漏提取在「命中率」指标里完全不可见**（ADR-006 发现 3），
 * 只有单测能抓到。禁止改回 `[\s\S]`。
 */
const IMPORT_PATTERNS = [
  /(?:^|[\s;}(])import\s+(?:[^'"]*?\sfrom\s*)??['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])export\s+(?:[^'"]*?\s)??from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const EXPORT_PATTERNS = [
  /(?:^|[\s;}])export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|[\s;}])export\s*\{([^}]*)\}/g,
]

/**
 * 去掉注释，避免正则把注释里的 `import` 当真。**必须是字符串感知的。**
 *
 * 原来是两条正则直接扫全文，不认识字符串字面量。excalidraw 里有这么一行：
 *
 *     import { getShortcutKey } from "../..//shortcut";
 *                                          ↑↑ 源码自己的笔误，双斜杠
 *
 * 正则把 `//shortcut";` 当成行注释整段删掉，**连收尾引号一起删**。
 * 引号配对随之错位，import 正则把下一条语句也吞了进去——
 * 一个笔误吃掉两条 import，而命中率完全看不见（被吞掉的 import 不进分母）。
 * 原来那个 `[^:\\]` 前置条件是为了保护 `https://`，这里 `//` 前面是 `.`，挡不住。
 *
 * 改成单遍扫描，显式跟踪字符串状态。注意**字符串内容原样保留**——
 * 这个函数只负责删注释，而 import 的 specifier 本身就是字符串。
 *
 * 已知局限：不区分正则字面量和除号，`str.replace(/'/g, "")` 里那个 `'`
 * 会被当成字符串开头。但因为字符串一律原样抄写，**最坏结果只是漏删一处注释，
 * 永远不会删掉真代码**——而原来那版的失败方式恰恰是吃掉源码。
 */
function stripNoise(source: string): string {
  const out: string[] = []
  const n = source.length
  let i = 0

  /** 注释按原长度换成空格，换行保留：行列位置不变，出问题时好定位 */
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(source[k] === '\n' ? '\n' : ' ')
  }

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      const start = i
      while (i < n && source[i] !== '\n') i++
      blank(start, i)
      continue
    }

    if (c === '/' && next === '*') {
      const start = i
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      blank(start, i)
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      out.push(c)
      i++
      while (i < n) {
        if (source[i] === '\\') {
          out.push(source[i])
          if (i + 1 < n) out.push(source[i + 1])
          i += 2
          continue
        }
        const closing = source[i] === c
        out.push(source[i])
        i++
        if (closing) break
      }
      continue
    }

    out.push(c)
    i++
  }

  return out.join('')
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/**
 * 从一条 import / export-from 语句解析出它引用了哪些符号。
 * 纯函数，独立可测——L2 的连边正确性全靠它。
 */
export function parseImportClause(statement: string): Omit<ImportRecord, 'spec'> {
  const none = { names: [] as string[], hasDefault: false, isNamespace: false }

  const m = /^\s*(?:import|export)\s+([\s\S]*?)\s*\bfrom\b/.exec(statement)
  if (!m) {
    // `export * from './x'` 没有 from 前的绑定子句时也走这里
    if (/^\s*export\s*\*/.test(statement)) return { ...none, isNamespace: true }
    // `import './side-effect'`：无绑定，不产生符号引用
    return none
  }

  // `import type { T } from` / `export type { T } from`
  const clause = m[1].trim().replace(/^type\s+/, '')

  // `import * as ns from` / `export * from`
  if (/^\*/.test(clause)) return { ...none, isNamespace: true }

  const brace = clause.indexOf('{')
  if (brace < 0) {
    // `import App, * as ns from './x'`——前面已排除 `^\*`，此处的 `*` 必然跟在默认导入之后
    if (clause.includes('*')) return { names: [], hasDefault: true, isNamespace: true }
    // `import App from './x'`
    return clause ? { ...none, hasDefault: true } : none
  }

  const before = clause.slice(0, brace).replace(/,\s*$/, '').trim()
  // `import App, * as ns from './x'`
  if (before.includes('*')) return { names: [], hasDefault: Boolean(before), isNamespace: true }

  const inner = clause.slice(brace + 1, clause.lastIndexOf('}'))
  const names = inner
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    // `format as fmt` → 记源名 format
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter((s) => IDENT.test(s) || s === 'default')

  return { names, hasDefault: Boolean(before), isNamespace: false }
}

export function extractByRegex(source: string): Omit<ExtractResult, 'usedFallback'> {
  const cleaned = stripNoise(source)

  const bySpec = new Map<string, ImportRecord>()
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(cleaned)) !== null) {
      const spec = m[1]
      const clause = parseImportClause(m[0])
      mergeRecord(bySpec, spec, clause)
    }
  }

  const exports = new Set<string>()
  for (const re of EXPORT_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(cleaned)) !== null) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name && IDENT.test(name)) exports.add(name)
      }
    }
  }
  if (/(?:^|[\s;}])export\s+default\b/.test(cleaned)) exports.add('default')

  return { imports: [...bySpec.values()], exports: [...exports] }
}

/** 同一 specifier 被多条语句引用时合并符号集合 */
function mergeRecord(
  map: Map<string, ImportRecord>,
  spec: string,
  clause: Omit<ImportRecord, 'spec'>
): void {
  const cur = map.get(spec)
  if (!cur) {
    map.set(spec, { spec, ...clause, names: [...clause.names] })
    return
  }
  for (const n of clause.names) if (!cur.names.includes(n)) cur.names.push(n)
  cur.hasDefault ||= clause.hasDefault
  cur.isNamespace ||= clause.isNamespace
}

export function extract(source: string, filename = 'file.ts'): ExtractResult {
  try {
    const [imports, exports] = parse(source, filename)
    const bySpec = new Map<string, ImportRecord>()

    for (const i of imports) {
      if (!i.n) continue
      // 动态 import 拿不到静态绑定，按命名空间处理（无法判断用了哪些符号）
      const clause =
        i.d >= 0
          ? { names: [], hasDefault: false, isNamespace: true }
          : parseImportClause(source.slice(i.ss, i.se))
      mergeRecord(bySpec, i.n, clause)
    }

    /**
     * 导出必须**合并**正则的结果，不能只信 lexer。
     *
     * es-module-lexer 报的是**运行时**导出，而 `export type` / `export interface`
     * 在编译后会被完全擦除，所以它一个都不报——这符合 ES 规范，不是它的 bug。
     * 后果是：一个纯类型模块（比如 src/core/types.ts）会显示「0 个导出」，
     * 而侧栏同时显示有 10 个文件直接引用它。**十个人 import 一个没有导出的文件**，
     * 这个矛盾在界面上是直接可见的——ADR-023。
     *
     * import 侧仍然只信 lexer（它在那边是权威的），只有 export 侧做并集。
     */
    const merged = new Set(exports.map((e) => e.n))
    for (const name of extractByRegex(source).exports) merged.add(name)

    return {
      imports: [...bySpec.values()],
      exports: [...merged],
      usedFallback: false,
    }
  } catch {
    return { ...extractByRegex(source), usedFallback: true }
  }
}
