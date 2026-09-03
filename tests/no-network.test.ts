/**
 * 「代码不会离开浏览器」的机器可验证证明。
 *
 * 这是本项目**唯一的信任主张**：别人凭什么把公司代码拖进一个陌生网页？
 * 一张 DevTools 截图只能证明「拍照那一刻没有请求」，而且看图的人无法确认
 * 截图时到底做了什么操作。这个用例把它变成 CI 里的常驻断言——
 * 任何人 clone 下来跑 `npm test` 都能自己验一遍，改坏了 CI 直接红。
 *
 * 断言的是**架构事实**（ADR-002）：应用代码里根本不存在往外发数据的 API。
 * 没有后端可连，不是「我们保证不发」。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * 任何能把数据送出本机的 API。
 *
 * 注意这里**不禁止动态 `import()`**：它加载的是打包进产物的本地 chunk，
 * 走的是同源静态资源，方向是下载而不是上传。内置示例正是靠它惰性加载源码（ADR-022）。
 * 「零请求」这个说法只对「打开本地目录」那条路径成立，
 * 而这个用例守的是比它更强、也更要紧的东西：**没有任何出站通道**。
 */
const OUTBOUND = [
  { re: /\bfetch\s*\(/, name: 'fetch()' },
  { re: /\bXMLHttpRequest\b/, name: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, name: 'WebSocket' },
  { re: /\bEventSource\b/, name: 'EventSource' },
  { re: /\bsendBeacon\s*\(/, name: 'navigator.sendBeacon()' },
  { re: /\bRTCPeerConnection\b/, name: 'RTCPeerConnection' },
  { re: /\bnavigator\s*\.\s*clipboard\b/, name: 'navigator.clipboard' },
  // 远程 URL 常量：出站请求的另一半，光禁 API 不禁地址是漏的
  { re: /['"`]https?:\/\/(?!www\.w3\.org|developer\.mozilla|github\.com)/, name: '硬编码远程 URL' },
]

/**
 * `localStorage` **故意不在禁用清单里**。
 *
 * 它写在本机磁盘上，永远不出网，和「代码会不会离开浏览器」是两件事。
 * 把它塞进来会让这个用例看起来管得更宽，实际上是在稀释它证明的东西——
 * 一个断言应该只证明一件事，否则读的人不知道绿灯到底代表什么。
 * （本项目只用它存侧栏宽度，键名 `code-atlas.sidebar-width`。）
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(name))) {
      out.push(full)
    }
  }
  return out
}

/** 去掉注释，否则这个文件自己的说明文字会把自己判红 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const files = sourceFiles(SRC)

describe('零出站通道（ADR-002）', () => {
  it('扫到了源码文件——空数组会让下面所有断言假绿', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it.each(OUTBOUND)('src/ 里不存在 $name', ({ re }) => {
    const hits = files
      .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))

    expect(hits).toEqual([])
  })

  it('index.html 里没有外部脚本或第三方资源', () => {
    const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8')
    // data: URI 的 favicon 是内联的，不算外部资源
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/)
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/)
  })

  it('生产依赖里没有网络客户端', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'))
    const deps = Object.keys(pkg.dependencies ?? {})
    for (const banned of ['axios', 'node-fetch', 'ky', 'superagent', 'socket.io-client']) {
      expect(deps).not.toContain(banned)
    }
  })
})
