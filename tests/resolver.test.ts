import { describe, expect, it } from 'vitest'
import { normalizeKey } from '../src/core/path'
import { resolveImport } from '../src/core/resolver'
import type { Alias, ResolveContext } from '../src/core/types'

const ROOT = '/repo'

function ctxOf(
  files: string[],
  opts: { root?: string; aliases?: Alias[]; baseDir?: string } = {}
): ResolveContext {
  const set = new Set(files.map(normalizeKey))
  return {
    root: opts.root ?? ROOT,
    aliases: opts.aliases ?? [],
    baseDir: opts.baseDir ?? opts.root ?? ROOT,
    has: (p) => set.has(p),
  }
}

const from = (p: string) => `${ROOT}/${p}`

describe('相对路径', () => {
  it('带扩展名直接命中', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/b.ts'])
    expect(resolveImport('./b.ts', from('src/a.ts'), ctx)).toEqual({
      status: 'resolved',
      target: '/repo/src/b.ts',
    })
  })

  it('省略扩展名，按 TRY_EXTS 顺序补全', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/b.tsx'])
    expect(resolveImport('./b', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/b.tsx',
    })
  })

  it('.ts 优先于 .js', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/b.ts', '/repo/src/b.js'])
    expect(resolveImport('./b', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/b.ts',
    })
  })

  it('.. 能正确上跳', () => {
    const ctx = ctxOf(['/repo/src/deep/a.ts', '/repo/src/shared.ts'])
    expect(resolveImport('../shared', from('src/deep/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/shared.ts',
    })
  })
})

describe('目录 → index 文件', () => {
  it('./utils 解析到 utils/index.ts', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/utils/index.ts'])
    expect(resolveImport('./utils', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/utils/index.ts',
    })
  })

  it('同名文件优先于同名目录的 index', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/utils.ts', '/repo/src/utils/index.ts'])
    expect(resolveImport('./utils', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/utils.ts',
    })
  })
})

/**
 * 以下三组是 Day 1 在真实仓库上打出来的 bug，固化为回归测试。
 * 见 ADR-006 / ADR-007。
 */
describe('回归：ESM + TypeScript 的 .js → .ts 约定', () => {
  it("import './x.js' 命中 x.ts", () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/x.ts'])
    expect(resolveImport('./x.js', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/x.ts',
    })
  })

  it("import './x.js' 命中 x.d.ts（vite/types 的真实场景）", () => {
    const ctx = ctxOf(['/repo/types/a.d.ts', '/repo/types/hmrPayload.d.ts'])
    expect(resolveImport('./hmrPayload.js', from('types/a.d.ts'), ctx)).toMatchObject({
      target: '/repo/types/hmrPayload.d.ts',
    })
  })

  it("import './x.jsx' 命中 x.tsx", () => {
    const ctx = ctxOf(['/repo/src/a.tsx', '/repo/src/C.tsx'])
    expect(resolveImport('./C.jsx', from('src/a.tsx'), ctx)).toMatchObject({
      target: '/repo/src/C.tsx',
    })
  })
})

describe('回归：纯类型模块 .d.ts', () => {
  it("import './types' 命中 types.d.ts（TanStack/query 的真实场景）", () => {
    const ctx = ctxOf(['/repo/src/Post.vue', '/repo/src/types.d.ts'])
    expect(resolveImport('./types', from('src/Post.vue'), ctx)).toMatchObject({
      target: '/repo/src/types.d.ts',
    })
  })

  it('有实现文件时不应命中 .d.ts', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/types.ts', '/repo/src/types.d.ts'])
    expect(resolveImport('./types', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/types.ts',
    })
  })
})

describe('tsconfig 别名', () => {
  const aliases: Alias[] = [
    { prefix: '@/*', targets: ['./src/*'] },
    { prefix: '@excalidraw/common', targets: ['./packages/common/src/index.ts'] },
  ]

  it('通配别名 @/* → src/*', () => {
    const ctx = ctxOf(['/repo/app/a.ts', '/repo/src/utils/format.ts'], { aliases })
    expect(resolveImport('@/utils/format', from('app/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/utils/format.ts',
    })
  })

  it('精确别名（无通配）', () => {
    const ctx = ctxOf(['/repo/a.ts', '/repo/packages/common/src/index.ts'], { aliases })
    expect(resolveImport('@excalidraw/common', from('a.ts'), ctx)).toMatchObject({
      target: '/repo/packages/common/src/index.ts',
    })
  })

  it('baseUrl 参与别名解析', () => {
    const ctx = ctxOf(['/repo/app/a.ts', '/repo/lib/x.ts'], {
      aliases: [{ prefix: '~/*', targets: ['./x*'] }],
      baseDir: '/repo/lib',
    })
    expect(resolveImport('~/', from('app/a.ts'), ctx)).toMatchObject({
      target: '/repo/lib/x.ts',
    })
  })
})

describe('外部包与协议', () => {
  it.each(['react', 'lodash-es/merge', '@scope/pkg'])('裸 specifier %s → external', (spec) => {
    const ctx = ctxOf(['/repo/src/a.ts'])
    expect(resolveImport(spec, from('src/a.ts'), ctx)).toMatchObject({ status: 'external' })
  })

  it.each(['node:fs', 'https://esm.sh/x', 'data:text/javascript,1'])(
    '协议前缀 %s → external',
    (spec) => {
      const ctx = ctxOf(['/repo/src/a.ts'])
      expect(resolveImport(spec, from('src/a.ts'), ctx)).toMatchObject({ status: 'external' })
    }
  )
})

describe('打包器修饰的剥离', () => {
  it('?raw 后缀', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/tpl.ts'])
    expect(resolveImport('./tpl?raw', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/tpl.ts',
    })
  })

  it('!!loader! 前缀', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/tpl.ts'])
    expect(resolveImport('!!raw-loader!./tpl', from('src/a.ts'), ctx)).toMatchObject({
      target: '/repo/src/tpl.ts',
    })
  })
})

/**
 * ADR-007：这三类不计入失败率，否则用户会以为工具坏了。
 */
describe('归因：不计入失败率的三类', () => {
  it('指向构建产物 → build-artifact', () => {
    const ctx = ctxOf(['/repo/bin/cli.js'])
    expect(resolveImport('../dist/node/cli.js', from('bin/cli.js'), ctx)).toEqual({
      status: 'failed',
      reason: 'build-artifact',
    })
  })

  it('SvelteKit 虚拟模块 → virtual-module', () => {
    const ctx = ctxOf(['/repo/src/routes/+page.ts'])
    expect(resolveImport('./$types', from('src/routes/+page.ts'), ctx)).toEqual({
      status: 'failed',
      reason: 'virtual-module',
    })
  })

  it('超出所选根目录 → out-of-root', () => {
    const ctx = ctxOf(['/repo/src/a.ts'])
    expect(resolveImport('../../outside/x', from('src/a.ts'), ctx)).toEqual({
      status: 'failed',
      reason: 'out-of-root',
    })
  })
})

describe('静态资源与真实失败', () => {
  it('未被扫描的 css → asset', () => {
    const ctx = ctxOf(['/repo/src/a.tsx'])
    expect(resolveImport('./App.css', from('src/a.tsx'), ctx)).toEqual({ status: 'asset' })
  })

  it('已存在的 css 应真实命中，而非归为 asset', () => {
    const ctx = ctxOf(['/repo/src/a.tsx', '/repo/src/App.css'])
    expect(resolveImport('./App.css', from('src/a.tsx'), ctx)).toMatchObject({
      target: '/repo/src/App.css',
    })
  })

  it('根内不存在的模块 → unresolved（唯一计入失败率的一类）', () => {
    const ctx = ctxOf(['/repo/src/a.ts'])
    expect(resolveImport('./nope', from('src/a.ts'), ctx)).toEqual({
      status: 'failed',
      reason: 'unresolved',
    })
  })
})

describe('大小写不敏感（Windows / macOS 默认行为）', () => {
  it('Utils.ts 能被 ./utils 命中', () => {
    const ctx = ctxOf(['/repo/src/a.ts', '/repo/src/Utils.ts'])
    expect(resolveImport('./utils', from('src/a.ts'), ctx)).toMatchObject({
      status: 'resolved',
    })
  })
})
