/**
 * 最小 posix 路径工具。
 *
 * 为什么不用 node:path —— core 层必须能在浏览器里跑（见 ADR-008）。
 * 内部一律用正斜杠表示路径；Windows 的反斜杠在入口处就被 toPosix 归一化掉。
 */

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 用于 Set/Map 的键。大小写不敏感——Windows/macOS 的文件系统默认如此 */
export function normalizeKey(p: string): string {
  return toPosix(p).toLowerCase()
}

export function basename(p: string): string {
  const s = toPosix(p)
  return s.slice(s.lastIndexOf('/') + 1)
}

export function dirname(p: string): string {
  const s = toPosix(p)
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return s.slice(0, i)
}

/**
 * 取扩展名。**必须能识别 `.d.ts` 这类双扩展名**——
 * ADR-007 记录的真实缺陷正是由它引起的。
 */
export function extname(p: string): string {
  const base = basename(p)
  const dts = /(\.d\.[cm]?ts)$/.exec(base)
  if (dts) return dts[1]
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i)
}

/** 去掉扩展名后的部分 */
export function stripExt(p: string): string {
  const ext = extname(p)
  return ext ? p.slice(0, -ext.length) : p
}

export function joinPath(...parts: string[]): string {
  return normalizeSegments(parts.filter(Boolean).map(toPosix).join('/'))
}

/**
 * 把 spec 相对 from 目录解析成绝对路径，展开 `.` 与 `..`。
 * from 应为目录的绝对路径（posix 或 Windows 均可）。
 */
export function resolvePath(from: string, spec: string): string {
  const s = toPosix(spec)
  return normalizeSegments(s.startsWith('/') ? s : `${toPosix(from)}/${s}`)
}

function normalizeSegments(input: string): string {
  const parts = input.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '') {
      // 只保留开头的空段（表示 posix 根 `/`）
      if (out.length === 0) out.push('')
      continue
    }
    if (part === '.') continue
    if (part === '..') {
      // 不越过根/盘符
      if (out.length > 1 || (out.length === 1 && out[0] !== '')) out.pop()
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  return joined === '' ? '/' : joined
}

/** 求 p 相对 root 的路径，用作图节点的稳定 id */
export function relativeTo(root: string, p: string): string {
  const r = toPosix(root).replace(/\/+$/, '')
  const t = toPosix(p)
  return t.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? t.slice(r.length + 1) : t
}
