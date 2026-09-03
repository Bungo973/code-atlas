/**
 * ★ 核心模块：把 import 里的字符串，翻译成硬盘上真实存在的那个文件。
 *
 * 纯函数，不做任何 I/O —— 文件是否存在由 ctx.has 注入。
 * 这让同一份代码能在 Node（验证脚本）和浏览器（File System Access API）里跑。
 *
 * 实测命中率见 ADR-007：excalidraw 99.9% / vite 99.3% / TanStack-query 99.4%
 */

import { dirname, extname, joinPath, normalizeKey, resolvePath, toPosix } from './path'
import type { Alias, ResolveContext, ResolveResult } from './types'

/** 候选扩展名，按顺序尝试，命中即止。'' 表示 specifier 已自带扩展名 */
const TRY_EXTS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  // 纯类型模块排在最后：有实现文件时应优先命中实现文件
  '.d.ts',
  '.d.mts',
  '.d.cts',
]

const TRY_INDEX = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'index.d.ts',
]

/**
 * ESM + TypeScript 的约定：import 里写 './x.js'，磁盘上实际是 './x.ts'。
 * Node 的 ESM 解析要求写出扩展名，而 tsc 不会重写它，于是 TS 项目里到处是这种写法。
 * 不处理这条，所有遵循该约定的项目都会大面积解析失败（ADR-006 发现）。
 */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
}

const ASSET_EXTS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.md', '.mdx', '.txt', '.wasm', '.glsl', '.vert', '.frag',
])

/** 构建产物目录：解析不到是正常的，构建后才存在 */
const BUILD_DIRS = /(^|\/)(dist|build|out|\.next|\.nuxt|\.output|\.svelte-kit)(\/|$)/

/**
 * 框架生成的虚拟模块，不在磁盘上。
 *
 * 注意：这里**不能**包含 `^~`。`~/*` 是 Nuxt 等项目极常见的 tsconfig 别名，
 * 把它当虚拟模块会吞掉合法的别名解析（单测 `baseUrl 参与别名解析` 抓到的 bug）。
 * 无别名的 `~foo` 会自然落入 external 分支，不需要在这里特判。
 */
const VIRTUAL = [
  /(^|\/)\$[\w-]+$/, // SvelteKit 的 ./$types
  /^virtual:/,
]

const NON_FILE_PROTOCOL = /^(node|data|https?|file|bun|deno):/

/**
 * 长得像别名的裸 specifier。
 *
 * `@/x` —— npm 作用域包必须是 `@scope/name`，`@` 后直接跟 `/` 的不可能是包名
 * `~/x` —— Nuxt 等常见的根别名
 * `#x`  —— package.json 的 subpath imports
 *
 * 命中这些却没匹配上任何别名，基本可以断定是 tsconfig 没找到。
 */
const ALIAS_LIKE = /^(@\/|~\/|#)/

export function looksLikeAlias(spec: string): boolean {
  return ALIAS_LIKE.test(spec)
}

/**
 * 剥掉打包器加在 specifier 上的修饰：
 *   './x?raw'        → './x'
 *   '!!loader!./x'   → './x'
 */
export function cleanSpecifier(spec: string): string {
  return spec.split('?')[0].replace(/^!+.*!/, '')
}

/** tsconfig paths 别名匹配，支持尾部 `*` 通配 */
export function matchAlias(spec: string, aliases: Alias[], baseDir: string): string[] | null {
  for (const { prefix, targets } of aliases) {
    if (prefix.endsWith('*')) {
      const head = prefix.slice(0, -1)
      if (spec.startsWith(head)) {
        const rest = spec.slice(head.length)
        return targets.map((t) => resolvePath(baseDir, t.replace('*', rest)))
      }
    } else if (spec === prefix) {
      return targets.map((t) => resolvePath(baseDir, t))
    }
  }
  return null
}

/** 对一个不含扩展名（或含 .js）的绝对路径，尝试所有候选文件 */
export function tryCandidates(base: string, has: (p: string) => boolean): string | null {
  for (const ext of TRY_EXTS) {
    const p = base + ext
    if (has(p)) return p
  }

  // './x.js' → './x.ts'
  const ext = extname(base)
  const swaps = JS_TO_TS[ext]
  if (swaps) {
    const stem = base.slice(0, -ext.length)
    for (const s of swaps) {
      const p = stem + s
      if (has(p)) return p
    }
  }

  for (const idx of TRY_INDEX) {
    const p = joinPath(base, idx)
    if (has(p)) return p
  }

  return null
}

/**
 * 主入口。
 *
 * @param spec     import 里的原始字符串
 * @param fromFile 发起 import 的文件（绝对路径）
 */
export function resolveImport(spec: string, fromFile: string, ctx: ResolveContext): ResolveResult {
  if (NON_FILE_PROTOCOL.test(spec)) return { status: 'external', aliasLike: false }

  const clean = cleanSpecifier(spec)
  if (!clean) return { status: 'external', aliasLike: false }

  const has = (p: string) => ctx.has(normalizeKey(p))

  let bases: string[]
  // 别名匹配必须最先做——别名可能长得像虚拟模块（`~/*`），也可能长得像裸包（`@scope/x`）
  const aliasHit = matchAlias(clean, ctx.aliases, ctx.baseDir)

  if (aliasHit) {
    bases = aliasHit
  } else if (VIRTUAL.some((re) => re.test(clean))) {
    return { status: 'failed', reason: 'virtual-module' }
  } else if (clean.startsWith('.')) {
    bases = [resolvePath(dirname(fromFile), clean)]
  } else if (clean.startsWith('/')) {
    // 根相对路径。注意 monorepo 里 project root ≠ repo root，这里会有已知误差
    bases = [joinPath(ctx.root, clean)]
  } else {
    // 裸 specifier 且不匹配任何别名 → 外部包。
    // 但如果它长得像别名，多半是 tsconfig 没找到，需要单独标记出来告警
    return { status: 'external', aliasLike: looksLikeAlias(clean) }
  }

  for (const base of bases) {
    const hit = tryCandidates(base, has)
    if (hit) return { status: 'resolved', target: toPosix(hit) }
  }

  // ── 到这里说明没解析到，开始归因 ──

  if (ASSET_EXTS.has(extname(clean))) return { status: 'asset' }

  if (bases.some((b) => BUILD_DIRS.test(toPosix(b)))) {
    return { status: 'failed', reason: 'build-artifact' }
  }

  const root = normalizeKey(ctx.root)
  if (bases.every((b) => !normalizeKey(b).startsWith(root))) {
    return { status: 'failed', reason: 'out-of-root' }
  }

  return { status: 'failed', reason: 'unresolved' }
}
