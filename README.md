# Code Atlas

把一个代码仓库解析成可交互的依赖关系图，看清「这个项目是怎么连起来的」。
**全程在浏览器本地完成，代码不上传。**

🔗 **在线体验**：https://bungo973.github.io/code-atlas/
打开就能看示例——Code Atlas 分析它自己的源码，走的是同一条真流水线。

![主视图：左侧工程目录，右侧依赖关系图](docs/screenshots/overview.png)

---

## 它解决什么问题

接手一个陌生仓库时，前两个小时通常花在同一件事上：**搞清楚从哪儿开始读，以及改这个文件会波及谁。**
`grep` 能找到引用，但拼不出全貌；IDE 的「查找引用」一次只看一个符号。

Code Atlas 一次性回答这几个问题：

| 问题 | 界面上的答案 |
|---|---|
| 从哪儿开始读？ | **入口点** — 没有任何文件依赖它 |
| 哪些文件动不得？ | **枢纽** — 直接入度最高，节点画得最大 |
| 改这个会波及谁？ | **影响范围** — 选中后按跳数分层高亮 |
| 有没有解不开的结？ | **循环依赖** — 强连通分量，红圈标注 |
| 哪些导出没人用？ | **疑似死代码** — 符号级，带三条豁免规则 |

## 特性

- **文件级（L1）+ 符号级（L2）** — 不只是「A 依赖 B」，而是「A 用了 B 导出的 `format`」
- **影响范围分层** — 1 跳 / 2 跳 / 3 跳 / 全部，只高亮真正的传播路径
- **零网络请求** — 打开 DevTools 的 Network 面板可自证；分析期间一个请求都没有
- **无需安装** — 不用 CLI，不用装插件，打开网页选个目录就行
- **多种语言/框架** — TS / JS / JSX / TSX / Vue / Svelte / Astro，含 monorepo 多份 tsconfig

## 在真实仓库上的表现

三个开源仓库的实测（Node 侧跑同一份 `src/core` 代码，`npm run verify -- <路径>`）：

| 仓库 | 代码文件 | 依赖边 | 导出符号 | 命中率 | 分析耗时 |
|---|---|---|---|---|---|
| [excalidraw](https://github.com/excalidraw/excalidraw) | 668 | 3327 | 2495 | **99.9%** | 279 ms |
| [vite](https://github.com/vitejs/vite) | 1598 | 1846 | 2161 | **99.6%** | 305 ms |
| [tanstack/query](https://github.com/TanStack/query) | 1230 | 1524 | 1767 | **99.7%** | 345 ms |

**命中率的分母只算「本该解析成功的」**：外部 npm 包、静态资源、以及设计上无法解析的三类
（构建产物、框架虚拟模块、超出所选根目录）都不进分母。
把外部包算进分母能让数字更好看，但那是自欺欺人。

> 这个指标有已知盲区，而且踩过三次：**漏提取的 import 根本不会出现在分母里**。
> 详见 [ADR-006](docs/DECISIONS.md) 和 [ADR-012](docs/DECISIONS.md)。

## 本地运行

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm test             # 134 个用例，含一个分析本仓库源码的端到端用例
npm run typecheck
npm run verify -- /path/to/repo   # Node 侧跑同一份解析器，输出上面那张表
```

需要 Chrome / Edge（[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)）才能打开本地目录。
其它浏览器可以看内置示例。

## 技术选择

完整的 22 条决策记录在 [`docs/DECISIONS.md`](docs/DECISIONS.md)，格式固定为
**选了什么 / 放弃了什么 / 为什么 / 代价是什么**。挑几条：

**不用 tree-sitter，用 `es-module-lexer` + 正则规则表**（[ADR-001](docs/DECISIONS.md)）
画依赖图只需要 import 语句，不需要完整 AST。tree-sitter 的 WASM 包 + 各语言语法文件是好几 MB，
而这是个「打开网页就用」的工具，首屏体积直接决定它能不能用。
代价：JSX 里带属性的标签会让 lexer 失败，需要正则兜底——所以两条路径都保留，产出对比可见。

**核心层不依赖任何运行环境 API**（[ADR-008](docs/DECISIONS.md)）
`src/core` 是纯函数，零 I/O，不 import 任何 `node:*`。文件是否存在由 `ResolveContext.has` 注入。
同一份代码在浏览器和 Node 验证脚本里跑，**所以上面那张性能表和线上是同一条流水线**——
否则「浏览器比 Node 慢多少」这个问题根本没法回答。

**做到符号级 L2，明确不做调用图 L3**（[ADR-003](docs/DECISIONS.md) / [ADR-004](docs/DECISIONS.md)）
L2 几乎零新增成本（`es-module-lexer` 本来就返回 exports），还白送一个死代码检测。
L3 需要类型推断来解决方法调用的接收者，那是另一个数量级的工程。
ADR-004 是对 ADR-003 措辞的修正：原话把「不划算」写成了「做不到」，说满了。

**疑似死代码的三条豁免规则**（[ADR-015](docs/DECISIONS.md)）
有引用 / 所属文件被 `import * as` 命名空间导入 / 所属文件是入口点。
第二条是命门——缺了它误报率从 7% 涨到 35%。
界面上永远写「**疑似**死代码」，两个字不可省略：可能被动态引用，也可能本身就是公开 API。

## 四个只有肉眼能发现的问题

单元测试和聚合指标都没抓到它们，全是靠盯着真实仓库的产物才发现的。这部分是我认为最值得看的：

**① tsconfig 只在根目录找**（[ADR-012](docs/DECISIONS.md)）
用户选了 monorepo 的父目录，而 tsconfig 在 `packages/web/` 下。
234 个 import 被静默判成外部包，图从 164 条边塌到 9 条，65 个孤岛——
**而命中率显示 100%**，因为外部包不进分母。
修复：收集整棵树的全部 tsconfig，按最近祖先作用域匹配；新增 `externalAliasLike` 告警指标。

**② 传递入度在大仓库里会饱和**（[ADR-019](docs/DECISIONS.md)）
excalidraw 有一个 346 个节点的强连通分量，于是几乎每个文件的传递入度都是 509。
半径公式 `1+√509 ≈ 23.6`，乘 1.5 得到 35px——668 个这么大的圆必然糊成一团。
这条**推翻了 ADR-005** 的视觉编码选择。改用直接入度 + 固定半径区间 `[2.5, 11]px`。

**③ 纯类型模块显示「0 个导出」**（[ADR-023](docs/DECISIONS.md)）
截图里 `src/core/types.ts` 写着 `0 个导出`，而侧栏同时显示 10 个文件直接引用它。
**十个人 import 一个没有导出的文件**——这个矛盾摆在同一屏上。
原因：`es-module-lexer` 报的是**运行时**导出，而 `export type` / `interface` 编译后被完全擦除，
它一个都不报（这符合 ES 规范，不是它的 bug）。我们的正则兜底能抓到，但兜底只在 lexer **失败**时才跑。
三个仓库上因此漏掉了 16%–19% 的导出符号，而所有测试都是绿的。

**④ 同一个饱和指标，另外三处还在用**（[ADR-020](docs/DECISIONS.md) / [ADR-021](docs/DECISIONS.md)）
②只改了节点半径。影响范围高亮仍是无限传递闭包（点哪儿都亮同一片 509 个）；
悬停提示框仍挂着那个没有区分度的数字；
枢纽榜甚至**按它排序**——前几十行全是并列 509，等于随机取 40 个。
修复后定下三条硬规矩：饱和指标不做排序键、不做视觉编码、不单独出现。

> 教训写在 ADR-020 里：**推翻一个指标的时候，要把它的所有使用点一起 grep 一遍。**
> 我写完这句话之后自己又漏了两处，于是有了 ADR-021。

## 项目结构

```
src/
├── core/              纯函数，零 I/O，可在任意环境运行
│   ├── extractor.ts     import 提取（lexer + 正则兜底）
│   ├── resolver.ts    ★ specifier → 硬盘上的真实文件
│   ├── analyze.ts       流水线编排
│   ├── graph.ts         图指标：入度 / 循环 / 入口 / 影响范围
│   ├── symbols.ts       符号级引用与疑似死代码
│   └── tree.ts          目录树构建与展平
├── adapters/
│   ├── browser.ts       File System Access API
│   └── demo.ts          内置示例（分析本仓库自己）
└── ui/                  区域划分见 docs/UI-VOCABULARY.md
    ├── ProjectSidebar.tsx   侧栏
    ├── GraphCanvas.tsx      画布（含小地图）
    ├── DetailRail.tsx       详情栏
    └── NotesDrawer.tsx      分析面板
```

`resolver.ts` 是核心：处理相对路径、tsconfig 别名（含 monorepo 多作用域）、
index 文件、扩展名补全、ESM+TS 的 `.js`→`.ts` 约定、纯类型 `.d.ts` 模块、
框架虚拟模块、打包器前缀（`?raw`、`!!loader!`）。

## 文档

| 文档 | 内容 |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 词汇表。每个术语带 `_Avoid_` 列表，统一说法 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 22 条决策记录，含被推翻的决定 |
| [`docs/UI-VOCABULARY.md`](docs/UI-VOCABULARY.md) | 界面区域命名、圆角分级、两条视觉硬约束 |
| [`docs/PLAN.md`](docs/PLAN.md) | 计划、验收标准、计划与实际的对照 |

## 技术栈

React 19 · TypeScript · Vite 8 · graphology · react-force-graph-2d · es-module-lexer · Vitest

配色针对深色表面 `#1a1a19` 做过色觉分离验证。力导向图是 all-pairs 形态
（任意两色都可能相邻），分类色**只能用 3 个槽位**，第 4 个起折叠为「其他」——
这不是省事，是 8 个槽位在 all-pairs 下过不了色觉分离下限（[ADR-011](docs/DECISIONS.md)）。
