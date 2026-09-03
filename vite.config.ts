import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],

  /**
   * 相对路径产物。
   *
   * 部署目标不确定：GitHub Pages 挂在 `/仓库名/` 子路径下，Vercel / Netlify / 本地
   * `vite preview` 都在根路径。写死 `/` 的话 Pages 上所有资源 404，
   * 写死 `/code-atlas/` 的话别处全挂。本项目没有前端路由，用相对路径两边都成立。
   */
  base: './',

  build: {
    rollupOptions: {
      output: {
        /**
         * 把力导向图那套库单独切出来。
         *
         * 不是为了减少总字节数（一样多），是为了让**应用代码和依赖分开缓存**：
         * 改一行 UI 不该让用户重新下载 400 KB 的绘图库。
         *
         * 必须是**函数形式**——Vite 8 底层是 rolldown，对象形式会直接报
         * `manualChunks is not a function`。
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          // 叫 viz 不叫 graph：示例会把 src/core/graph.ts 也切成一个 chunk，
          // 两个都叫 graph 的话构建清单读起来会打架
          if (/react-force-graph|d3-|graphology|force-graph/.test(id)) return 'viz'
          return 'vendor'
        },
      },
    },
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
