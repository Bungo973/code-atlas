/** 扫描规则。Node 适配层和浏览器适配层共用，避免两边发散 */

export const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.astro', '.vue', '.svelte',
])

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache',
  'vendor', '__pycache__', '.venv',
])

export function isCodeFile(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i > 0 && CODE_EXTS.has(name.slice(i))
}
