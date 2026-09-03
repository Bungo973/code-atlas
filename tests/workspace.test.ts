import { describe, expect, it } from 'vitest'
import { matchWorkspacePackage, parseWorkspacePackages } from '../src/core/workspace'

const pkg = (path: string, body: Record<string, unknown>) => ({
  path,
  text: JSON.stringify(body),
})

const PKGS = parseWorkspacePackages([
  pkg('/repo/package.json', { name: 'root' }),
  pkg('/repo/packages/utils/package.json', { name: '@ep/utils', main: 'index.ts' }),
  pkg('/repo/packages/components/package.json', {
    name: '@ep/components',
    main: 'dist/index.js',
    module: 'index.ts',
  }),
  pkg('/repo/packages/components-lite/package.json', { name: '@ep/components-lite' }),
  pkg('/repo/packages/exp/package.json', {
    name: '@ep/exp',
    exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
  }),
  pkg('/repo/packages/broken/package.json', { version: '1.0.0' }),
])

describe('parseWorkspacePackages', () => {
  it('按 name 建映射，没有 name 的跳过', () => {
    expect(PKGS.map((p) => p.name).sort()).toEqual([
      '@ep/components',
      '@ep/components-lite',
      '@ep/exp',
      '@ep/utils',
      'root',
    ])
  })

  it('包目录是 package.json 的所在目录', () => {
    expect(PKGS.find((p) => p.name === '@ep/utils')?.dir).toBe('/repo/packages/utils')
  })

  it('坏 JSON 不炸，直接跳过', () => {
    expect(parseWorkspacePackages([{ path: '/r/package.json', text: '{ oops' }])).toEqual([])
  })

  it('入口里源码字段排在 main 前面 —— 刚 clone 的仓库没有 dist', () => {
    const entries = PKGS.find((p) => p.name === '@ep/components')!.entries
    const iModule = entries.indexOf('/repo/packages/components/index.ts')
    const iMain = entries.indexOf('/repo/packages/components/dist/index.js')
    expect(iModule).toBeGreaterThanOrEqual(0)
    expect(iMain).toBeGreaterThan(iModule)
  })

  it('exports 里的 source 条件也认', () => {
    expect(PKGS.find((p) => p.name === '@ep/exp')!.entries).toContain(
      '/repo/packages/exp/src/index.ts'
    )
  })

  it('入口列表最后兜底包目录本身，交给 index.* 候选', () => {
    const entries = PKGS.find((p) => p.name === '@ep/utils')!.entries
    expect(entries[entries.length - 1]).toBe('/repo/packages/utils')
  })
})

describe('matchWorkspacePackage', () => {
  it('不是本地包时返回 null', () => {
    expect(matchWorkspacePackage('vue', PKGS)).toBeNull()
    expect(matchWorkspacePackage('@vueuse/core', PKGS)).toBeNull()
  })

  it('裸包名给出全部入口候选', () => {
    expect(matchWorkspacePackage('@ep/utils', PKGS)).toContain('/repo/packages/utils/index.ts')
  })

  it('子路径直接拼到包目录下', () => {
    expect(matchWorkspacePackage('@ep/utils/dom/style', PKGS)).toEqual([
      '/repo/packages/utils/dom/style',
    ])
  })

  it('取最长匹配 —— @ep/components 不能把 @ep/components-lite 抢走', () => {
    expect(matchWorkspacePackage('@ep/components-lite/x', PKGS)).toEqual([
      '/repo/packages/components-lite/x',
    ])
  })

  it('名字是前缀但不在斜杠边界上，不算匹配', () => {
    // @ep/utils 不该命中 @ep/utilsx
    expect(matchWorkspacePackage('@ep/utilsx', PKGS)).toBeNull()
  })
})
