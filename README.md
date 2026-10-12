# dsh-ops-guard

把两条**技能里的建议**变成**运行时的强制**：

| 守卫 | 规则 | 替代通道 |
|---|---|---|
| **下载守卫** | 大文件下载必须走 aria2 | `aria2-dl.cjs` → aria2-next (Motrix Next) |
| **搜索守卫** | 按文件名找文件必须走 Everything | `es.exe` → voidtools Everything |

两者共用同一套机制：在 `tools/pre-execute` 拦截，然后给出替代通道。

**搜索守卫更进一步**：它不再只是给一条命令，而是**直接把搜索结果返回给模型** ——
通过 Everything 的常驻 IPC 通道（协议为逆向所得），查询在 DSH 进程内完成，
模型无需再执行任何命令。

## 为什么需要它

`aria2-download` 技能把规则写在提示词里，而**提示词只是建议**。实际发生的是：

| | aria2 通道 | 绕过通道 |
|---|---|---|
| 引擎 | aria2-next (Motrix Next) | node 单连接 https |
| 实测速度 | **11.78 MB/s** | **0.13 MB/s** |
| Motrix 可见 | ✅ | ❌ |
| 断点续传 | ✅ | 部分 |

同一条 4.76 GB 的 Windows 11 镜像，两条路差了 **约 90 倍**。而 agent 手头只要有一个 `download.cjs`，就会顺手用它——因为**在 shell 层面 `node download.cjs` 和 `aria2-dl.js` 长得一模一样**，没有任何机制能区分。

本插件把这条规则搬到运行时：**拦截工具调用，拒绝并给出正确的 aria2 命令**。

## 工作原理

监听 cordis 的 `tools/pre-execute` 钩子（waterfall 模式），在**工具真正执行之前**裁决：

```
模型请求 pwsh("curl -o x.iso https://...")
    ↓
tools/pre-execute 钩子触发
    ↓
识别为下载 → 返回 { kind: 'deny', reason: '<改用 aria2 的完整命令>' }
    ↓
工具被拒绝，reason 原样呈现给模型（工具体从未执行）
```

## 搜索守卫

同样的论证适用于文件搜索：`everything-cli` 技能把规则写在提示词里，而**手上有内置 `glob` 工具的 agent 没有任何理由去用 es.exe**。规则必须落到运行时。

Everything 是本机常驻的全盘实时索引（**250 万文件**），`es.exe` 毫秒级返回；内核的 `glob` 则每次调用都要让 ripgrep 真的走一遍目录树。

### ⚠️ 只拦 glob，不拦 grep —— 这是实测结论

内置的搜索工具是**两个**，它们的可替代性**完全不同**：

| 工具 | 能力 | 能否替代 | 依据 |
|---|---|---|---|
| `glob` | 按**文件名/路径**找 | ✅ **替代** | Everything 就是干这个的 |
| `grep` | 按**文件内容**找 | ❌ **不替代** | 见下 |

**为什么不动 grep**：Everything 的内容搜索需要用户在 Everything 里**显式开启内容索引**，而本机实测**是关闭的**：

```
es.exe "content:dsh-ops-guard"        → 无任何输出
es.exe -get-result-count "content:..."     → 无任何输出
```

在此状态下拦截 grep，等于把**慢的内容搜索变成没有内容搜索**——比它要防止的问题严重得多。这与下载守卫自己的原则一致：**宁可漏掉一次优化，也不阻断一条工作流。**

被拒时给出的理由里**明确告诉模型 grep 没被拦**，避免它转向别处绕路。

### 📊 实测：收益取决于搜索范围

最初的基准（守卫还只是"给命令"时）结论是**反直觉**的，如实保留：

| 范围 | 内核 glob (rg) | es.exe | 谁快 |
|---|---|---|---|
| 单个目录 | 13 ms | 42 ms | **rg 快 3.2x** |
| 单个项目 | 16 ms | 42 ms | **rg 快 2.6x** |
| `D:\VibeCoding` | 82 ms | 40 ms | **es 快 2.1x** |
| **整盘 `D:\`** | **1077 ms** | **40 ms** | **es 快 27x** |

**原因**：es.exe 有 **~40 ms 固定开销**（进程启动 + IPC），而 ripgrep 的开销随目录树线性增长。

**但这一结论已被常驻 IPC 推翻** —— 见下节。如今窄范围也不再倒挂。

### ⚠️ 一个被基准抓出的真实缺陷

最初实现的守卫**原样传递 glob 模式**，而 Everything 的 `-path` **本就按文件名递归**，所以 `**/` 前缀是多余的。实测：

```
es -path D "**/*.ts"       1525 ms   223 条
es -path D "*.ts"            40 ms   223 条   ← 结果相同，快 38 倍
es -path D "src/**/*.ts"    218 ms     0 条   ← 完全错误，丢失全部匹配
es -path D/src "*.ts"        41 ms     5 条   ← 正确
```

即最初的建议命令**既慢 38 倍、又在带目录前缀时返回 0 条**。现已在 `translateToEsPattern` 中修正并加了断言钉住。

### glob → Everything 查询的映射

模式语言几乎不用翻译（`*` 在两边都是文件名匹配），要处理的是**作用域**：

| 内置 glob | Everything 查询 |
|---|---|
| `pattern: "**/*.ts"` | `*.ts`（`**/` 前缀多余，见上） |
| `path: "D:\proj"` | `path:D:\proj `（**查询语法，不是 `-path`**） |
| 省略 path | 取会话工作目录 |

⚠️ **管道协议里没有 `-path`** —— 那是 es.exe 的命令行参数，线格式里并不存在。
作用域必须写进查询本身：`path:<目录> <模式>`。已验证与 `es -path` **结果集合完全相同**（11 vs 11，零差异）。

另有两个实测确认的细节：

- **`**` 必须保留**：`src/**/*.ts` 能匹配 `src/__deep/probe.ts`，而 `src\*.ts` **不递归**。所以模式形状原样传递，不做扁平化。
- **Everything 不按 shell 方式解析相对路径**：实测 `path:. *.md` 返回**整盘 24693 条**（静默地）。相对路径现按工作目录解析，无法解析时不猜、直接放弃限定。

### 为什么 es.exe 只在加载时探测一次

`tools/pre-execute` 在**每次工具调用**前面跑，探测 es.exe（要 stat 十几个目录）放在钩子里是浪费。改为插件挂载时解析一次。

探测**不检查 Everything 是否在运行**：es.exe 通过 IPC 与 Everything 通信，服务没开时会在调用时报错。在 pre-execute 钩子里 spawn 一个进程去探活是错的位置——模型执行时会看到真实错误，比守卫去猜更有用。

### 为什么不用审批钩子

`approval/request` 在**审批策略为 `never` 时会失效**——`ApprovalService.decide()` 在派发 waterfall **之前**就 `return "rejected"`：

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // ← 在这里返回
const answer = ... this.ctx.waterfall(..., "approval/request", ...)   // ← 永远走不到
```

而 `tools/pre-execute` 是**独立的 waterfall，没有这个短路**，所以任何策略下都有效。

## 拦截规则

判据来自技能本身：**是否需要把字节写到磁盘**，而不是 URL 长什么样、文件多大。

| 拦截 | 放行 |
|---|---|
| `curl -o F` / `curl -O` / `curl --output F` | `curl https://api.x/status`（只输出到 stdout） |
| `wget <url>`（默认落盘） | `wget -O - <url>`（显式输出到 stdout） |
| `Invoke-WebRequest ... -OutFile F` | `Invoke-WebRequest https://api.x/status` |
| `Invoke-RestMethod ... -OutFile F` | `Invoke-RestMethod https://api.x/data` |
| `Start-BitsTransfer ...` | — |

**明确不拦**（按设计）：

- `pip install` / `npm install` 等包管理器——不在本插件职责内
- `git clone`——git 自有传输层
- 注释行里的命令（shell 不会执行）
- 非 shell 工具（即使参数里含 `curl -o` 字样）
- **仅仅是提到某文件名**（例如日志里打印 `download.cjs`）——曾有一条按文件名匹配的规则，因误伤已删除

检测**刻意偏向漏判而非误判**：拦截一条正常命令是可见的体验倒退，而漏掉一次下载只是现状。

## 拦截后模型看到什么

```
BLOCKED by dsh-ops-guard: this command downloads a file to disk
(matched: curl-output), and downloads must go through the local aria2 engine
(Motrix Next) so they are multithreaded, resumable and visible in the download manager.

Use instead:
  node "<本插件目录>\scripts\aria2-dl.cjs" "<URL>" --out=<filename>

Options: --dir=<dir> for the destination, --header="K: V" for headers,
--no-wait to enqueue and return immediately (then query with --status <gid>).
A blocked command is never partially executed.

Blocked command: curl -o Win11.iso https://.../y.iso
```

**URL 会被自动提取并填进建议命令**——被拒绝的一方不需要猜该怎么改。

### 搜索守卫：直接给出结果

搜索守卫的输出**不一样** —— 它不是给命令，而是**把结果一并返回**：

```
BLOCKED by dsh-ops-guard: the built-in glob tool was not run.
(matched: glob — pattern "**/*.md", path "D:/proj")

Everything already answered this query over its resident IPC pipe in 6.3 ms,
so there is nothing for you to run:

  total matches: 11

        D:\proj\README.md
        D:\proj\docs\everything-ipc-protocol.md
        ...

If you need a DIFFERENT query, es.exe speaks the same pattern language:
  C:\Users\<user>\bin\es.exe -n 50 -path D:\proj "*.md"

The grep tool is NOT affected: content search stays on the built-in tool.
```

三点值得注意：

- **结果已经在里面了**，模型读完就能回答，不需要再发起工具调用
- **耗时如实写出**（`in 6.3 ms`），让成本可见
- **grep 仍然被明确豁免**，避免模型误以为内容搜索也被拦

## 随包分发的 forwarder

本插件**自带** aria2 转发脚本：

```
scripts/aria2-dl.cjs
```

拦截提示里给出的路径，就是**这个随包副本的绝对路径**（由 `import.meta.url` 在运行期解析）。

> **为什么必须自带**：早期版本的提示指向 `~/.dsh/skills/aria2-download/scripts/aria2-dl.js` —— 那是一个**机器私有路径**。在没有该技能的机器上，守卫会拒绝下载、然后让用户去用一个**根本不存在**的文件。那比不拦更糟：既打断流程，又不给出路。

该脚本**只走 JSON-RPC**（不依赖 `aria2c.exe`），要求本机运行 **aria2-next** 引擎（Motrix Next 内置）。引擎未启动时会明确报错，而不是静默失败。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARIA2_RPC_PORT` | `16800` | 引擎 RPC 端口 |
| `ARIA2_RPC_TIMEOUT_MS` | `15000` | RPC 超时 |
| `ARIA2_DOWNLOAD_DIR` | 用户 `Downloads` 目录 | 默认落盘目录（**不硬编码盘符**） |

### 直接使用

```bash
node scripts/aria2-dl.cjs <url> --out=<文件名> [--dir=<目录>] [--no-wait]
node scripts/aria2-dl.cjs --status <gid>
node scripts/aria2-dl.cjs --list
```

## 安装

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add "dsh-ops-guard@github:BeiWay1145/dsh-ops-guard"
```

安装后**重启 DSH** 生效。

## 常驻 IPC：为什么守卫自己执行搜索

最初守卫只做一件事：拒绝 `glob`，给出一条 `es.exe` 命令。**那是不够的** ——
模型还得再发起一次工具调用、再付一次进程启动。

### 为什么不做一个 CLI 包装器

最自然的方案是写个小命令行客户端走管道。**先测了，发现会适得其反**：

```
node -e ""      58.5 ms   ← 裸进程启动
es.exe          38.9 ms
```

**Node 启动比它要替代的 es.exe 还慢。** 常驻 IPC 只在**已经存活的进程内**才有价值，
而守卫正是这样一个进程。它无法改写调用（`pre-execute` 只能 allow/deny/ask/cancel，
已在 `dsh-tools/lib/index.js` 核实），所以唯一花掉这个优势的方式就是：
**把答案算出来，放进拒绝理由里。**

### 协议（逆向所得）

```
管道 : \\.\PIPE\Everything IPC
请求 : [i32 cmd][i32 len][payload]              cmd=7 搜索
响应 : 循环 { [i32 status][i32 len][body] }     100=中间帧 200=末帧 404=错误
记录 : [u8 flags(1=目录)][varint 长度][utf8 路径]
```

逆向自 `es.exe` 1.1.0.37（Ghidra）。**实现细节与全部命令号**见
[docs/everything-ipc-protocol.md](docs/everything-ipc-protocol.md)。

> 那个卡了一整轮的坑：请求里的长度字段是 **varint**，写成 u32 会让 Everything
> **静默忽略查询** —— 响应结构依然完整、能正常解析、`total` 报 0，
> 看起来像"没有匹配"而不是"格式错误"。

### 延迟实测（9 次中位数）

| 查询 | 内置 glob (rg) | es.exe | **守卫 + IPC** | vs rg | vs es |
|---|---|---|---|---|---|
| 单项目 `**/*.md` | 18.2 ms | 41.4 ms | **6.7 ms** | 2.7x | 6.2x |
| 单项目 `**/*.ts` | 22.1 ms | 43.8 ms | **7.0 ms** | 3.2x | 6.3x |
| 单项目 `**/*.json` | 18.8 ms | 42.8 ms | **6.3 ms** | 3.0x | 6.8x |
| 跨项目 `D:/VibeCoding` | 483.6 ms | 43.3 ms | **6.9 ms** | **70.3x** | 6.3x |

**窄范围不再倒挂** —— 上一节的 2–3 倍劣势已经消失。

而且还**省掉一次模型往返**：结果随拒绝理由一起返回，没有命令需要执行。
这一项毫秒列反映不出来，但它省的是一整个 tool call。

```bash
BENCH_REPS=9 node bench/guard-latency.mjs
```

> ⚠️ 基准里 es.exe 那一列**必须**用 `translateToEsPattern` 翻译后的模式。
> 用原始 `**/*.ts` 会得到 1400 ms —— 那是本项目早已修复的缺陷，
> 拿它当对照会让守卫看起来快 175 倍（真实是 6.3 倍）。那是稻草人，不是基线。

### 回落路径

**任何管道故障**（Everything 没运行、超时、协议变动）都会自动退回"给命令"模式
（`searchDenialMessage`）。守卫不会因为 Everything 没跑就让搜索失效 ——
把慢搜索变成没有搜索，比它要防的问题严重得多。

## 已知边界

- **拦不住「命令内部的下载」**：`python script.py` 里用 `urllib` 下载，钩子看到的是 `python script.py`，看不到它内部在做什么。彻底收口需要本地代理层，不在本插件范围。
- **拦不住非 DSH 发起的下载**：在 DSH 之外的终端里 `curl -o` 不受影响。
- 依赖宿主提供 `tools/pre-execute` 钩子（已在 DSH 0.1.5-rc 系列上实测）。
- **Everything 的 IPC 协议是私有的、未公开的**，任何版本都可能更改。已实现回落路径，
  但若协议变动，守卫会静默退回"给命令"模式（功能不受影响，只是不再省那次往返）。
- **搜索守卫回答的是文件名索引，不是内容**。这正是它不动 `grep` 的原因。

## 开发

```bash
npm install
npm test          # 构建 + 检测器单测 + 真实 ToolRuntime 运行时测试
npm run typecheck
```

测试分四层：

| 文件 | 覆盖 | 项数 |
|---|---|---|
| `tests/detect.test.mjs` | 下载检测规则（含大量「必须放行」的反例） | 65 |
| `tests/search.test.mjs` | 搜索检测、模式翻译、查询作用域、es.exe 探测、拒绝文本 | 41 |
| `tests/everything-ipc.test.mjs` | IPC 编解码（varint 往返、请求/响应布局、真实管道） | 22 |
| `tests/guard.runtime.mjs` | 把**构建产物**装进真实 cordis + ToolRuntime，验证 deny 真的拦住了工具体 | 26 断言 |
| `tests/ipc-guard.e2e.mjs` | 真实 ToolRuntime 端到端：断言拒绝理由里**带着结果**，而不是一条命令 | 8 断言 |

前三层是纯函数，随时可跑。后两层会自行在本机寻找已安装的 DSH 树；找不到时**跳过而非失败**，这样裸克隆仓库也能通过。

另有基准脚本：

```bash
BENCH_REPS=9 node bench/guard-latency.mjs   # 守卫 / 内置 glob / es.exe 三路对比
node bench/after-restart.mjs                # 重启后一键验证（挂载 + 延迟 + 行为）
```

## 许可

MIT
