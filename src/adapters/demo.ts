/**
 * 内置示例：让 Code Atlas 分析**它自己的源码**。
 *
 * 为什么需要它：部署出去之后，打开链接的人本地并没有代码仓库。
 * 一个只会弹目录选择框的页面演示不了任何东西，Chrome 以外的浏览器更是连按钮都是灰的。
 *
 * 为什么是「自己的源码」而不是预先算好的假数据：
 * 这里走的是**同一条真流水线**——同一个 extractor、同一个 resolver、同一个 analyze()。
 * 屏幕上的边和数字是当场算出来的，不是打包时写死的 JSON。
 * 演示一个分析工具却给它喂假结果，等于什么都没演示。
 *
 * 代价：源码文本会进产物。用 `import.meta.glob` 的**惰性**形式，
 * 它们被切成独立 chunk，只有点了「看示例」才下载（见 ADR-022）。
 */

import type { SourceFile, TsconfigSource } from '../core/analyze'
import { normalizeKey } from '../core/path'
import { isCodeFile } from '../core/scan-config'
import type { BrowserScan } from './browser'

/**
 * 打包进示例的文件。
 *
 * 两条都不能改错：
 *
 * 1. `eager: false`（默认）。写成 eager 的话这些源码会直接并进主 chunk，
 *    主包立刻多出一百多 KB，而绝大多数用户根本不会点示例。
 * 2. **排除必须写在 glob 里**，用 `!` 前缀的负模式。`import.meta.glob` 在**打包时**
 *    静态展开，运行时再 filter 只能让文件不显示，产物里那 91 KB 的 package-lock chunk
 *    照样存在。这个坑是看构建产物清单才发现的。
 */
const RAW = {
  ...import.meta.glob('/src/**/*.{ts,tsx,css,html}', { query: '?raw', import: 'default' }),
  ...import.meta.glob('/tests/**/*.ts', { query: '?raw', import: 'default' }),
  ...import.meta.glob('/scripts/**/*.ts', { query: '?raw', import: 'default' }),
  ...import.meta.glob(['/*.{json,ts,html}', '!/package-lock.json'], {
    query: '?raw',
    import: 'default',
  }),

  /**
   * 手工补上本文件。
   *
   * `import.meta.glob` **会排除调用它的那个模块自己**（Vite 用这条规则避免自引用循环）。
   * 于是示例里独独缺了 demo.ts，而 App.tsx 和 demo.test.ts 都 import 它——
   * 结果就是两条边解析失败，示例的命中率不是 100%。
   *
   * 这个缺口是端到端测试断言「真实失败 = 0」时才暴露的：31 个文件的图上少两条边，
   * 肉眼根本看不出来。`?raw` 后缀让它成为一个只导出字符串的独立模块，不构成循环。
   */
  '/src/adapters/demo.ts': () => import('./demo.ts?raw').then((m) => m.default),
} as Record<string, () => Promise<string>>

const ROOT_NAME = 'code-atlas'
const ROOT = `/${ROOT_NAME}`

const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json'])

/** glob 的键是仓库根起算的绝对路径（`/src/core/graph.ts`），拼上合成根即可 */
const toRepoPath = (key: string) => `${ROOT}${key}`

export function demoFileCount(): number {
  return Object.keys(RAW).length
}

/**
 * 装出一份与 `scanDirectory` 形状完全一致的 BrowserScan。
 *
 * 形状一致是硬要求：下游的 analyze / buildGraph / 整个 UI 都不该知道
 * 数据是来自硬盘还是来自打包产物。示例路径一旦分叉，它就会慢慢和真实路径失去同步，
 * 变成一个「只有演示时才对」的假象。
 */
export async function scanDemo(): Promise<BrowserScan> {
  const t0 = performance.now()

  const keys = Object.keys(RAW).sort()

  const files: SourceFile[] = []
  const allPaths = new Set<string>()
  const configKeys: string[] = []

  for (const key of keys) {
    const path = toRepoPath(key)
    allPaths.add(normalizeKey(path))

    const name = key.slice(key.lastIndexOf('/') + 1)
    if (CONFIG_NAMES.has(name)) configKeys.push(key)
    // 同一份 isCodeFile 判定，不另写一套规则
    if (isCodeFile(name)) files.push({ path, read: RAW[key] })
  }

  const tsconfigs: TsconfigSource[] = []
  await Promise.all(
    configKeys.map(async (key) => {
      try {
        tsconfigs.push({ path: toRepoPath(key), text: await RAW[key]() })
      } catch {
        /* 读不到就跳过，和真实扫描一致 */
      }
    })
  )

  return {
    root: ROOT,
    rootName: ROOT_NAME,
    files,
    allPaths,
    tsconfigs,
    scanMs: performance.now() - t0,
    totalFileCount: keys.length,
  }
}
