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

/** 去掉注释，避免正则把注释里的 `import` 当真 */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
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

    return {
      imports: [...bySpec.values()],
      exports: exports.map((e) => e.n),
      usedFallback: false,
    }
  } catch {
    return { ...extractByRegex(source), usedFallback: true }
  }
}
