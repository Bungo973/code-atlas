/**
 * 分析流水线：源文件 → 依赖图。
 *
 * 与 core 其余部分一样不碰环境 API——文件内容由 `SourceFile.read` 注入。
 * Node 适配层和浏览器适配层跑的是**同一条流水线**，所以两边的耗时数字可以直接对比
 * （Day 3 要回答的正是「浏览器比 Node 慢多少」）。
 */

import { extract, initExtractor } from './extractor'
import { basename, dirname, extname, normalizeKey, relativeTo, toPosix } from './path'
import { resolveImport } from './resolver'
import { isCodeFile } from './scan-config'
import { parseTsconfig } from './tsconfig'
import {
  parseWorkspacePackages,
  type PackageJsonSource,
  type WorkspacePackage,
} from './workspace'
import type {
  AliasScope,
  DepEdge,
  ExportSymbol,
  FailureReason,
  FileNode,
  ResolveContext,
  ResolveFailure,
  SymbolEdge,
} from './types'

export type SourceFile = {
  /** posix 绝对路径 */
  path: string
  size?: number
  read: () => Promise<string>
}

export type TsconfigSource = {
  /** tsconfig.json 文件本身的 posix 绝对路径 */
  path: string
  text: string
}

export type AnalyzeInput = {
  /** 仓库根，posix 绝对路径 */
  root: string
  /** 待解析的代码文件 */
  files: SourceFile[]
  /** 目录下**所有**文件的 normalizeKey，解析时判断目标是否存在 */
  allPaths: Set<string>
  /**
   * 目录树里找到的**全部** tsconfig/jsconfig。
   *
   * 不能只取根目录那一份：用户完全可能选中 monorepo 的父目录，
   * 而 tsconfig 在 `packages/web/` 下。漏掉它会让所有 `@/...` 导入
   * 被误判成外部包，图直接空掉——而命中率还显示 100%（ADR-012）。
   */
  tsconfigs?: TsconfigSource[]
  /**
   * 仓库里的**全部** package.json。用于把 `@scope/pkg` 这类裸 specifier
   * 认成 monorepo 内部引用而不是外部 npm 包（ADR-025）。
   */
  packageJsons?: PackageJsonSource[]
  /** 并发读取数。浏览器端逐文件异步，这个值影响很大 */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

export type AnalyzeStats = {
  total: number
  external: number
  /**
   * external 里长得像别名却没匹配上的数量。
   * **> 0 就说明有 tsconfig 没被找到**，图会缺边。这是必须在界面上告警的健康指标。
   */
  externalAliasLike: number
  asset: number
  resolved: number
  failed: Record<FailureReason, number>
  lexerOk: number
  lexerFallback: number
}

export type Timing = {
  /** 读文件内容的累计耗时 */
  read: number
  /** 提取 import/export 的累计耗时 */
  extract: number
  /** 路径解析的累计耗时 */
  resolve: number
  /** 整个 analyze 的墙钟耗时 */
  total: number
}

export type AnalyzeResult = {
  nodes: FileNode[]
  edges: DepEdge[]
  symbols: ExportSymbol[]
  /** L2：「谁用了谁的哪个导出」 */
  symbolEdges: SymbolEdge[]
  /**
   * 被 `import * as ns` / `export * from` / 动态 import 引用的文件。
   * 这些文件的全部导出都要视为已使用——无法确定具体用了哪几个。
   */
  namespaceImported: Set<string>
  failures: ResolveFailure[]
  /** 疑似漏配别名的具体来源，界面上可展开成清单 */
  aliasLikeExternals: { source: string; raw: string }[]
  stats: AnalyzeStats
  timing: Timing
  aliasCount: number
  /** 实际生效的别名作用域，用于界面展示「找到了哪几份 tsconfig」 */
  aliasScopes: AliasScope[]
  /** 识别到的 workspace 包，用于报告「有没有认出 monorepo」 */
  packages: WorkspacePackage[]
}

const emptyStats = (): AnalyzeStats => ({
  total: 0,
  external: 0,
  externalAliasLike: 0,
  asset: 0,
  resolved: 0,
  failed: { unresolved: 0, 'build-artifact': 0, 'virtual-module': 0, 'out-of-root': 0 },
  lexerOk: 0,
  lexerFallback: 0,
})

/**
 * 为每个文件挑选**最近祖先**的 tsconfig 作用域——这是 TypeScript 的真实行为。
 * 作用域按目录深度降序排列，第一个命中的就是最近的。
 */
function makeScopePicker(scopes: AliasScope[], fallback: AliasScope) {
  const cache = new Map<string, AliasScope>()
  return (fileDir: string): AliasScope => {
    const hit = cache.get(fileDir)
    if (hit) return hit
    let found = fallback
    for (const s of scopes) {
      if (fileDir === s.dir || fileDir.startsWith(`${s.dir}/`)) {
        found = s
        break
      }
    }
    cache.set(fileDir, found)
    return found
  }
}

/** 并发上限的 map。浏览器端一次性发起上千个 getFile() 会把主线程拖死 */
async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export async function analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
  const t0 = now()
  await initExtractor()

  const root = toPosix(input.root)
  const has = (p: string) => input.allPaths.has(p)

  const aliasScopes: AliasScope[] = (input.tsconfigs ?? [])
    .map(({ path, text }) => {
      const dir = dirname(toPosix(path))
      const { aliases, baseDir } = parseTsconfig(text, dir)
      return { dir, aliases, baseDir }
    })
    .filter((s) => s.aliases.length > 0)
    // 深度降序：最近祖先优先
    .sort((a, b) => b.dir.length - a.dir.length)

  const rootScope: AliasScope = { dir: root, aliases: [], baseDir: root }
  const scopeFor = makeScopePicker(aliasScopes, rootScope)

  // 包名 → 目录的映射。全仓库共用一份，不随文件位置变化
  const packages = parseWorkspacePackages(input.packageJsons ?? [])

  const stats = emptyStats()
  const timing: Timing = { read: 0, extract: 0, resolve: 0, total: 0 }

  const nodes: FileNode[] = []
  const edges: DepEdge[] = []
  const symbols: ExportSymbol[] = []
  const symbolEdges: SymbolEdge[] = []
  const namespaceImported = new Set<string>()
  const failures: ResolveFailure[] = []
  /** 长得像别名却没匹配上的裸 specifier，保留证据供界面追问 */
  const aliasLikeExternals: { source: string; raw: string }[] = []

  let done = 0
  const concurrency = input.concurrency ?? 32

  await mapPooled(input.files, concurrency, async (file) => {
    const tRead = now()
    let source: string
    try {
      source = await file.read()
    } catch {
      return
    }
    timing.read += now() - tRead

    const id = relativeTo(root, file.path)
    const fileDir = dirname(file.path)
    const scope = scopeFor(fileDir)
    const ctx: ResolveContext = {
      root,
      aliases: scope.aliases,
      baseDir: scope.baseDir,
      packages,
      has,
    }

    const tExtract = now()
    const extracted = extract(source, file.path)
    timing.extract += now() - tExtract

    if (extracted.usedFallback) stats.lexerFallback++
    else stats.lexerOk++

    nodes.push({
      id,
      path: file.path,
      name: basename(file.path),
      ext: extname(file.path),
      size: file.size ?? source.length,
      loc: countLines(source),
      dir: relativeTo(root, dirname(file.path)),
    })

    for (const name of extracted.exports) {
      symbols.push({ id: `${id}#${name}`, file: id, name, kind: 'unknown', line: 0 })
    }

    const tResolve = now()
    // 同一文件对同一目标的重复导入（如 `import` 与 `import type` 并存）只算一条依赖。
    // 边的语义是「依赖关系」，不是「import 语句」——建图时本来也会合并，
    // 在这里去重才能让两处的边数一致。
    const seenTargets = new Set<string>()
    for (const rec of extracted.imports) {
      const spec = rec.spec
      stats.total++
      const res = resolveImport(spec, file.path, ctx)
      if (res.status === 'resolved') {
        // 解析到了真实文件，但目标不是代码文件（.css / .json / 图片等）。
        // 它不该算作代码依赖——图里没有对应节点，算进去会产生悬空边，
        // 让「依赖边」和「图上的边」两个数字对不上。
        if (!isCodeFile(res.target)) {
          stats.asset++
          continue
        }
        stats.resolved++
        const target = relativeTo(root, res.target)
        if (!seenTargets.has(target)) {
          seenTargets.add(target)
          edges.push({ source: id, target, raw: spec, kind: 'static' })
        }

        // ── L2 符号级 ──
        if (rec.isNamespace) {
          // 用了 `import * as ns`：无法确定具体用了哪些导出，整个文件视为已使用
          namespaceImported.add(target)
        }
        for (const name of rec.names) {
          symbolEdges.push({ source: id, target: `${target}#${name}` })
        }
        if (rec.hasDefault) {
          symbolEdges.push({ source: id, target: `${target}#default` })
        }
      } else if (res.status === 'external') {
        stats.external++
        if (res.aliasLike) {
          stats.externalAliasLike++
          /**
           * **证据必须留下**，不能只加计数器。
           *
           * 原来这里只有 `externalAliasLike++`，界面上写着「21 个」，
           * 而用户问「哪些」的时候答不上来——答案在计数的那一刻就被扔了。
           * 一个分析工具的可信度不来自数字好看，来自任何一个数字都能被追问到底。
           */
          aliasLikeExternals.push({ source: id, raw: spec })
        }
      } else if (res.status === 'asset') {
        stats.asset++
      } else {
        stats.failed[res.reason]++
        failures.push({ source: id, raw: spec, reason: res.reason })
      }
    }
    timing.resolve += now() - tResolve

    input.onProgress?.(++done, input.files.length)
  })

  timing.total = now() - t0
  return {
    nodes,
    edges,
    symbols,
    symbolEdges,
    namespaceImported,
    failures,
    aliasLikeExternals,
    stats,
    timing,
    aliasCount: aliasScopes.reduce((n, s) => n + s.aliases.length, 0),
    aliasScopes,
    packages,
  }
}

function countLines(s: string): number {
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** 命中率：只有 `unresolved` 计入分母，见 ADR-007 */
export function hitRate(stats: AnalyzeStats): { rate: number; internal: number } {
  const internal = stats.resolved + stats.failed.unresolved
  return { rate: internal === 0 ? 0 : (stats.resolved / internal) * 100, internal }
}

export { normalizeKey }
