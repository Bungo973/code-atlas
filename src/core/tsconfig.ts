/**
 * 解析 tsconfig.json / jsconfig.json 里的路径别名。
 *
 * 纯函数：接收文本，不读文件。I/O 由调用方负责。
 */

import { resolvePath } from './path'
import type { Alias } from './types'

export type TsconfigInfo = {
  aliases: Alias[]
  /** baseUrl 解析后的绝对路径；无 baseUrl 时等于 configDir */
  baseDir: string
}

/**
 * tsconfig 允许注释和尾逗号（JSONC），JSON.parse 会直接抛。
 * 这里做一次粗略清洗——不追求严格正确，够解析 compilerOptions 即可。
 */
export function looseParseJson(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped)
}

/**
 * @param text      tsconfig.json 内容
 * @param configDir tsconfig 所在目录的绝对路径
 */
export function parseTsconfig(text: string, configDir: string): TsconfigInfo {
  let cfg: any
  try {
    cfg = looseParseJson(text)
  } catch {
    return { aliases: [], baseDir: configDir }
  }

  const co = cfg?.compilerOptions ?? {}
  const baseDir = co.baseUrl ? resolvePath(configDir, String(co.baseUrl)) : configDir

  const paths = co.paths ?? {}
  const aliases: Alias[] = Object.entries(paths).map(([prefix, targets]) => ({
    prefix,
    targets: (Array.isArray(targets) ? targets : [targets]).map(String),
  }))

  return { aliases, baseDir }
}
