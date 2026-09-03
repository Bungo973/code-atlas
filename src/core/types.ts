import type { WorkspacePackage } from './workspace'

/** 数据模型。与 docs/PLAN.md 第 4 节保持一致 */

export type FileNode = {
  /** 相对仓库根的 posix 路径，唯一标识 */
  id: string
  path: string
  name: string
  ext: string
  size: number
  /** 行数 */
  loc: number
  /** 所属目录，用于着色 */
  dir: string
}

export type DepEdge = {
  source: string // FileNode.id
  target: string // FileNode.id
  /** 原始 import 字符串，便于调试和展示 */
  raw: string
  kind: 'static' | 'dynamic' | 'type'
}

/**
 * 解析结果分类。
 *
 * ADR-007 的要求：build-artifact / virtual-module / out-of-root 这三类
 * **不能计入失败率**，否则用户会误以为工具坏了。它们是设计上无法解析的，
 * 不是解析器的缺陷。
 */
export type FailureReason =
  | 'unresolved' // 真正的解析失败，计入失败率
  | 'build-artifact' // 指向 dist/build 产物，构建后才存在
  | 'virtual-module' // 框架生成的虚拟模块，如 SvelteKit 的 ./$types
  | 'out-of-root' // 超出所选目录范围

export type ResolveFailure = {
  source: string
  raw: string
  reason: FailureReason
}

// ─── L2 符号级 ───

export type ExportSymbol = {
  /** "src/utils/index.ts#format" */
  id: string
  file: string
  name: string
  kind: 'function' | 'class' | 'const' | 'type' | 'default' | 'reexport' | 'unknown'
  line: number
}

export type SymbolEdge = {
  source: string // 使用方 FileNode.id
  target: string // ExportSymbol.id
  /** 别名：import { format as fmt } */
  importedAs?: string
}

// ─── 解析器 ───

export type Alias = {
  /** tsconfig paths 的键，可能以 * 结尾 */
  prefix: string
  targets: string[]
}

export type ResolveStatus = 'resolved' | 'external' | 'asset' | 'failed'

export type ResolveResult =
  | { status: 'resolved'; target: string }
  /**
   * aliasLike：这个裸 specifier 长得像别名（`@/x`、`~/x`、`#x`）却没匹配上任何别名。
   * 它**几乎一定**意味着 tsconfig 没被找到，而不是真的外部包——
   * 因为 npm 作用域包是 `@scope/name` 的形式，`@/` 后面直接跟斜杠的不可能是包名。
   *
   * 单独标出来，是因为「归类成 external」不计入失败率，
   * 会让整个仓库解析失败时命中率依然显示 100%（ADR-012）。
   */
  | { status: 'external'; aliasLike: boolean }
  | { status: 'asset' }
  | { status: 'failed'; reason: FailureReason }

/** 一份 tsconfig/jsconfig 提供的别名作用域 */
export type AliasScope = {
  /** 该 config 所在目录，posix 绝对路径。作用于其下所有文件 */
  dir: string
  aliases: Alias[]
  /** baseUrl 解析后的绝对路径 */
  baseDir: string
}

export type ResolveContext = {
  /** 仓库内的 workspace 包，用于把 `@scope/pkg` 这类裸 specifier 认成内部引用 */
  packages: WorkspacePackage[]
  /** 仓库根，posix 绝对路径 */
  root: string
  aliases: Alias[]
  /** tsconfig baseUrl 解析后的绝对路径 */
  baseDir: string
  /** 判断某个绝对路径是否真实存在。由调用方注入，core 层不做 I/O */
  has: (absPath: string) => boolean
}
