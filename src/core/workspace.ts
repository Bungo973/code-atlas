/**
 * monorepo workspace 包解析。
 *
 * 为什么必须做：JS 生态里大仓库几乎全是 monorepo，包与包之间用**包名**互相引用
 * （`@element-plus/utils`），靠 node_modules 里的软链指回同一个仓库。
 * 不认识这层映射的话，这些 import 会被当成外部 npm 包丢掉。
 *
 * element-plus 上的实测：2209 个文件里有 1957 处 `@element-plus/*` 引用，
 * 全部被判成外部包——图只剩 2528 条边，42% 的文件成了孤岛。
 * **而命中率显示 98.7% ✅**：被误判成 external 的 import 不进分母，
 * 和 ADR-012 是同一个盲区，这已经是第五次。
 *
 * 实现上**故意不解析 workspace glob**（`packages/*`、`internal/*` 这些）。
 * 直接收集仓库里所有 package.json、按 name 建映射就够了，而且顺带覆盖
 * npm / yarn / pnpm / lerna / nx 各家不同的声明方式。
 * 代价是可能把一个「碰巧同名但不是 workspace 成员」的包也映射进来——
 * 但一个 specifier 能对上仓库内某个包名时，指向本地几乎总是对的。
 */

import { dirname, joinPath, toPosix } from './path'
import { looseParseJson } from './tsconfig'

export type PackageJsonSource = {
  /** package.json 自身的 posix 绝对路径 */
  path: string
  text: string
}

export type WorkspacePackage = {
  /** package.json 里的 name */
  name: string
  /** 包目录，posix 绝对路径 */
  dir: string
  /** 入口候选，已拼成绝对路径，按优先级排序 */
  entries: string[]
}

/**
 * 从 exports 字段里捞出字符串形式的入口。
 * 只取常见的几个 key，**不做完整的 exports 条件解析**——
 * 那套规则（condition 嵌套、通配、fallback 数组）本身就是个小型规范，
 * 而这里只要拿到一个能落到源码上的路径即可。
 */
function entriesFromExports(exp: unknown): string[] {
  if (typeof exp === 'string') return [exp]
  if (!exp || typeof exp !== 'object') return []

  const dot = (exp as Record<string, unknown>)['.'] ?? exp
  if (typeof dot === 'string') return [dot]
  if (!dot || typeof dot !== 'object') return []

  const out: string[] = []
  for (const key of ['source', 'development', 'import', 'module', 'require', 'default']) {
    const v = (dot as Record<string, unknown>)[key]
    if (typeof v === 'string') out.push(v)
  }
  return out
}

export function parseWorkspacePackages(sources: PackageJsonSource[]): WorkspacePackage[] {
  const out: WorkspacePackage[] = []

  for (const src of sources) {
    let pkg: Record<string, unknown>
    try {
      pkg = (looseParseJson(src.text) ?? {}) as Record<string, unknown>
    } catch {
      continue
    }

    const name = pkg.name
    if (typeof name !== 'string' || !name) continue

    const dir = dirname(toPosix(src.path))

    /**
     * 顺序有讲究：source / module 这类字段通常指向源码，main 常常指向
     * 还没构建出来的 dist。在一个刚 clone 下来的仓库里，只信 main 会全部落空。
     */
    const rel = [
      ...entriesFromExports(pkg.exports),
      typeof pkg.source === 'string' ? pkg.source : null,
      typeof pkg.module === 'string' ? pkg.module : null,
      typeof pkg.main === 'string' ? pkg.main : null,
    ].filter((v): v is string => Boolean(v))

    const entries = rel.map((r) => joinPath(dir, r))
    // 最后兜底包目录本身，交给 tryCandidates 去找 index.*
    entries.push(dir)

    out.push({ name, dir, entries })
  }

  return out
}

/**
 * specifier → 包内的候选绝对路径。不匹配任何本地包时返回 null。
 *
 * 取**最长**匹配：`@scope/a` 和 `@scope/a-b` 同时存在时，
 * `@scope/a-b/x` 必须落到后者。按名字长度降序找第一个匹配即可。
 */
export function matchWorkspacePackage(
  spec: string,
  packages: WorkspacePackage[]
): string[] | null {
  let best: WorkspacePackage | null = null
  let bestSub = ''

  for (const p of packages) {
    if (spec === p.name) {
      if (!best || p.name.length > best.name.length) {
        best = p
        bestSub = ''
      }
    } else if (spec.startsWith(`${p.name}/`)) {
      if (!best || p.name.length > best.name.length) {
        best = p
        bestSub = spec.slice(p.name.length + 1)
      }
    }
  }

  if (!best) return null
  return bestSub ? [joinPath(best.dir, bestSub)] : [...best.entries]
}
