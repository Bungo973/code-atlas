/**
 * 浏览器适配层：File System Access API。
 *
 * 只负责「拿到文件」，不含任何解析逻辑——解析全在 src/core（ADR-008）。
 * 代码不上传：这里没有任何网络调用，用户可在 DevTools 的 Network 面板自证。
 */

import type { SourceFile, TsconfigSource } from '../core/analyze'
import { normalizeKey } from '../core/path'
import { SKIP_DIRS, isCodeFile } from '../core/scan-config'

export type BrowserScan = {
  /** 合成的仓库根，形如 `/my-project` */
  root: string
  rootName: string
  /** 待解析的代码文件 */
  files: SourceFile[]
  /** 目录下所有文件的 normalizeKey */
  allPaths: Set<string>
  /** 目录树里找到的**全部** tsconfig/jsconfig，不只是根目录那份 */
  tsconfigs: TsconfigSource[]
  /** 目录遍历耗时（不含读取文件内容） */
  scanMs: number
  /** 目录下文件总数（含非代码文件） */
  totalFileCount: number
}

const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json'])

export function isSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isSupported()) {
    throw new Error(
      '当前浏览器不支持 File System Access API。请使用 Chrome / Edge，或改用「拖入文件夹」的降级方案。'
    )
  }
  try {
    return await window.showDirectoryPicker!({ id: 'code-atlas', mode: 'read' })
  } catch (e) {
    // 用户取消选择时抛 AbortError，不算错误
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
}

const now = () => performance.now()

export async function scanDirectory(rootHandle: FileSystemDirectoryHandle): Promise<BrowserScan> {
  const t0 = now()

  const rootName = rootHandle.name
  const root = `/${rootName}`

  const files: SourceFile[] = []
  const allPaths = new Set<string>()
  const configHandles: { path: string; handle: FileSystemFileHandle }[] = []
  let totalFileCount = 0

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    const subdirs: { handle: FileSystemDirectoryHandle; path: string }[] = []

    for await (const [name, handle] of (dir as FileSystemDirectoryHandleIterable).entries()) {
      const path = `${prefix}/${name}`

      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name)) continue
        subdirs.push({ handle: handle as FileSystemDirectoryHandle, path })
        continue
      }

      totalFileCount++
      allPaths.add(normalizeKey(path))

      const fileHandle = handle as FileSystemFileHandle

      // 整棵树都要收集，不能只看根目录——用户可能选中 monorepo 的父目录
      if (CONFIG_NAMES.has(name)) configHandles.push({ path, handle: fileHandle })

      if (isCodeFile(name)) {
        files.push({ path, read: async () => (await fileHandle.getFile()).text() })
      }
    }

    // 兄弟目录并行下探。串行递归在深目录树上会把耗时线性叠加
    await Promise.all(subdirs.map((d) => walk(d.handle, d.path)))
  }

  await walk(rootHandle, root)

  const tsconfigs: TsconfigSource[] = []
  await Promise.all(
    configHandles.map(async ({ path, handle }) => {
      try {
        tsconfigs.push({ path, text: await (await handle.getFile()).text() })
      } catch {
        /* 读不到就跳过 */
      }
    })
  )

  return {
    root,
    rootName,
    files,
    allPaths,
    tsconfigs,
    scanMs: now() - t0,
    totalFileCount,
  }
}
