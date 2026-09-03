#!/usr/bin/env tsx
/**
 * 解析器验证脚本（Node 侧）。
 *
 * 与浏览器跑的是**同一条流水线**（src/core/analyze.ts），只有取文件的方式不同。
 * 这样两边的耗时数字才可比——Day 3 要回答的正是「浏览器比 Node 慢多少」。
 *
 * 用法：npm run verify -- <项目路径> [更多项目路径...]
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import nodePath from 'node:path'

import { analyze, hitRate, type SourceFile, type TsconfigSource } from '../src/core/analyze'
import { buildGraph, computeMetrics } from '../src/core/graph'
import { findSuspectedDeadSymbols } from '../src/core/symbols'
import { normalizeKey, relativeTo, toPosix } from '../src/core/path'
import { SKIP_DIRS, isCodeFile } from '../src/core/scan-config'
import type { AnalyzeResult } from '../src/core/analyze'

async function scan(root: string) {
  const t0 = Date.now()
  const files: SourceFile[] = []
  const allPaths = new Set<string>()
  const configPaths: string[] = []
  const packagePaths: string[] = []
  let totalFileCount = 0

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      const full = toPosix(nodePath.join(dir, e.name))
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) subdirs.push(full)
        continue
      }
      if (!e.isFile()) continue
      totalFileCount++
      allPaths.add(normalizeKey(full))
      // 整棵树都收集，不能只看根目录
      if (e.name === 'tsconfig.json' || e.name === 'jsconfig.json') configPaths.push(full)
      if (e.name === 'package.json') packagePaths.push(full)
      if (isCodeFile(e.name)) {
        files.push({ path: full, read: () => readFile(full, 'utf8') })
      }
    }
    await Promise.all(subdirs.map(walk))
  }

  await walk(root)

  const packageJsons: { path: string; text: string }[] = []
  await Promise.all(
    packagePaths.map(async (p) => {
      try {
        packageJsons.push({ path: p, text: await readFile(p, 'utf8') })
      } catch {
        /* 跳过 */
      }
    })
  )

  const tsconfigs: TsconfigSource[] = []
  for (const p of configPaths) {
    try {
      tsconfigs.push({ path: p, text: await readFile(p, 'utf8') })
    } catch {
      /* 读不到就跳过 */
    }
  }

  return { files, allPaths, tsconfigs, packageJsons, totalFileCount, scanMs: Date.now() - t0 }
}

// ────────────────────────── 报告 ──────────────────────────

const pad = (n: number | string, w = 7) => String(n).padStart(w)
const pct = (n: number, d: number) => (d === 0 ? '  0.0' : ((n / d) * 100).toFixed(1).padStart(5))

function report(root: string, s: Awaited<ReturnType<typeof scan>>, r: AnalyzeResult) {
  const { stats, timing } = r
  const { rate, internal } = hitRate(stats)
  const excused =
    stats.failed['build-artifact'] + stats.failed['virtual-module'] + stats.failed['out-of-root']

  console.log('')
  console.log('━'.repeat(64))
  console.log(`项目  ${root}`)
  console.log('━'.repeat(64))
  console.log(`扫描  ${r.nodes.length} 个代码文件 / ${s.totalFileCount} 个文件`)
  console.log(`别名  ${r.aliasCount} 条，来自 ${r.aliasScopes.length} 份 tsconfig`)
  console.log(`包名  ${r.packages.length} 个 workspace 包`)
  console.log(`提取  lexer ${stats.lexerOk} / 正则回退 ${stats.lexerFallback}`)

  console.log('')
  console.log('  耗时')
  console.log(`    目录遍历      ${pad(s.scanMs.toFixed(0))} ms`)
  console.log(`    分析(墙钟)    ${pad(timing.total.toFixed(0))} ms`)
  console.log(`      读文件累计  ${pad(timing.read.toFixed(0))} ms`)
  console.log(`      提取累计    ${pad(timing.extract.toFixed(0))} ms`)
  console.log(`      解析累计    ${pad(timing.resolve.toFixed(0))} ms`)
  console.log(`    合计          ${pad((s.scanMs + timing.total).toFixed(0))} ms`)

  console.log('')
  console.log('  import 分类')
  console.log(`    总计            ${pad(stats.total)}`)
  console.log(`    ├ 外部包         ${pad(stats.external)}  ${pct(stats.external, stats.total)}%`)
  if (stats.externalAliasLike > 0) {
    console.log(
      `    │   ⚠ 疑似漏配别名 ${pad(stats.externalAliasLike, 3)}  ← 长得像 @/ ~/ #，但没匹配上任何 tsconfig`
    )
  }
  console.log(`    ├ 静态资源       ${pad(stats.asset)}  ${pct(stats.asset, stats.total)}%`)
  console.log(`    ├ 成功解析       ${pad(stats.resolved)}  ${pct(stats.resolved, stats.total)}%`)
  console.log(`    ├ 设计上无法解析 ${pad(excused)}  ${pct(excused, stats.total)}%  ← 不计入失败率`)
  console.log(`    └ 真实失败       ${pad(stats.failed.unresolved)}  ${pct(stats.failed.unresolved, stats.total)}%`)

  const verdict =
    internal === 0 ? '⚠️  样本无效' : rate >= 90 ? '✅' : rate >= 75 ? '⚠️' : '❌'
  console.log('')
  console.log(`  命中率  ${stats.resolved} / ${internal} = ${rate.toFixed(1)}%  ${verdict}`)
  console.log(`  图规模  ${r.nodes.length} 节点 / ${r.edges.length} 边 / ${r.symbols.length} 导出符号`)

  // L2
  const g = buildGraph(r.nodes, r.edges)
  const m = computeMetrics(g)
  const dead = findSuspectedDeadSymbols({
    symbols: r.symbols,
    symbolEdges: r.symbolEdges,
    namespaceImported: r.namespaceImported,
    entryPoints: new Set(m.entryPoints),
  })
  console.log(
    `  符号级  ${r.symbolEdges.length} 条符号引用 · 疑似死代码 ${dead.suspects.length} 个` +
      `（豁免：${dead.excused.hasImporter} 有引用 / ${dead.excused.namespaceImported} 命名空间 / ${dead.excused.entryPoint} 入口点）`
  )
  console.log(
    `  图指标  ${m.cycles.length} 个循环依赖 · ${m.entryPoints.length} 个入口点 · ${m.islands.length} 个孤岛`
  )

  const real = r.failures.filter((f) => f.reason === 'unresolved')
  if (real.length > 0) {
    console.log('')
    console.log(`  真实失败样本 (共 ${real.length}，显示前 10)`)
    for (const f of real.slice(0, 10)) {
      console.log(`    ${f.source.padEnd(48)} → '${f.raw}'`)
    }
  }

  return { rate, wall: s.scanMs + timing.total }
}

async function main() {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    console.error('用法: npm run verify -- <项目路径> [更多项目路径...]')
    process.exit(1)
  }

  const rows: { name: string; files: number; ms: number; imports: number; rate: number }[] = []

  for (const t of targets) {
    const abs = toPosix(nodePath.resolve(t))
    try {
      if (!(await stat(abs)).isDirectory()) throw new Error('不是目录')
    } catch (e) {
      console.error(`跳过 ${abs}: ${(e as Error).message}`)
      continue
    }

    const s = await scan(abs)
    const r = await analyze({
      root: abs,
      files: s.files,
      allPaths: s.allPaths,
      tsconfigs: s.tsconfigs,
      packageJsons: s.packageJsons,
      concurrency: 32,
    })
    const { rate, wall } = report(abs, s, r)
    rows.push({
      name: relativeTo(nodePath.dirname(abs), abs),
      files: r.nodes.length,
      ms: Math.round(wall),
      imports: r.stats.total,
      rate,
    })
  }

  if (rows.length > 1) {
    console.log('')
    console.log('━'.repeat(64))
    console.log('汇总')
    console.log('━'.repeat(64))
    console.log(`  ${'项目'.padEnd(22)}${'文件'.padStart(7)}${'耗时'.padStart(9)}${'import'.padStart(9)}${'命中率'.padStart(9)}`)
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(22)}${pad(r.files)}${pad(r.ms + 'ms', 9)}${pad(r.imports, 9)}${pad(r.rate.toFixed(1) + '%', 9)}`
      )
    }
  }
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
