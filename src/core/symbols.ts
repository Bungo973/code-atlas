/**
 * L2 符号级分析：疑似死代码检测。
 *
 * 纯函数，与渲染无关。
 *
 * **必须叫「疑似」，不能叫「未使用」。** 静态分析在这件事上永远不可能确定：
 * 动态引用（`require(变量)`、字符串拼接的路径）、被仓库外的消费方引用、
 * 库的公开 API——三者都会让「没有入边」的判断失效。
 * 把猜测说成结论是产品诚信问题，这条写进了验收标准。
 */

import type { ExportSymbol, SymbolEdge } from './types'

export type DeadCodeInput = {
  symbols: ExportSymbol[]
  symbolEdges: SymbolEdge[]
  /**
   * 被命名空间导入（`import * as ns`、`export * from`、动态 import）的文件。
   * 无法确定用了哪些符号，**其全部导出都必须视为已使用**，否则大面积误报。
   */
  namespaceImported: Set<string>
  /** 入口点文件：没人依赖它，它的导出自然也不会有人用，单独归类而不是当死代码 */
  entryPoints: Set<string>
}

export type DeadCodeResult = {
  /** 疑似无人使用的导出符号 */
  suspects: ExportSymbol[]
  /** 各类被豁免的数量，用于在界面上解释「为什么不是全部」 */
  excused: {
    hasImporter: number
    namespaceImported: number
    entryPoint: number
  }
}

export function findSuspectedDeadSymbols(input: DeadCodeInput): DeadCodeResult {
  const used = new Set<string>()
  for (const e of input.symbolEdges) used.add(e.target)

  const suspects: ExportSymbol[] = []
  const excused = { hasImporter: 0, namespaceImported: 0, entryPoint: 0 }

  for (const s of input.symbols) {
    if (used.has(s.id)) {
      excused.hasImporter++
      continue
    }
    if (input.namespaceImported.has(s.file)) {
      excused.namespaceImported++
      continue
    }
    if (input.entryPoints.has(s.file)) {
      excused.entryPoint++
      continue
    }
    suspects.push(s)
  }

  return { suspects, excused }
}

/** 按文件归组，便于在界面上按文件展示而不是平铺几百行 */
export function groupByFile(symbols: ExportSymbol[]): { file: string; names: string[] }[] {
  const map = new Map<string, string[]>()
  for (const s of symbols) {
    const list = map.get(s.file)
    if (list) list.push(s.name)
    else map.set(s.file, [s.name])
  }
  return [...map.entries()]
    .map(([file, names]) => ({ file, names: names.sort() }))
    .sort((a, b) => b.names.length - a.names.length || a.file.localeCompare(b.file))
}

/** 某个文件的导出符号各被哪些文件使用 */
export function usageOf(
  file: string,
  symbols: ExportSymbol[],
  symbolEdges: SymbolEdge[]
): { name: string; users: string[] }[] {
  const byTarget = new Map<string, string[]>()
  for (const e of symbolEdges) {
    const list = byTarget.get(e.target)
    if (list) {
      if (!list.includes(e.source)) list.push(e.source)
    } else {
      byTarget.set(e.target, [e.source])
    }
  }
  return symbols
    .filter((s) => s.file === file)
    .map((s) => ({ name: s.name, users: (byTarget.get(s.id) ?? []).sort() }))
    .sort((a, b) => b.users.length - a.users.length || a.name.localeCompare(b.name))
}
