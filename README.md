# dsh-ops-guard

把两条**技能里的建议**变成**运行时的强制**：

| 守卫 | 规则 | 替代通道 |
|---|---|---|
| **下载守卫** | 大文件下载必须走 aria2 | `aria2-dl.cjs` → aria2-next (Motrix Next) |
| **搜索守卫** | 按文件名找文件必须走 Everything | `es.exe` → voidtools Everything |

两者共用同一套机制：在 `tools/pre-execute` 拦截，拒绝并给出**可直接粘贴的替代命令**。

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

### 📊 实测：收益取决于搜索范围，不是普遍加速

这是**基准测试**给出的结论，与最初的假设不同，如实记录：

| 范围 | 内核 glob (rg) | es.exe | 谁快 |
|---|---|---|---|
| 单个目录 | 13 ms | 42 ms | **rg 快 3.2x** |
| 单个项目 | 16 ms | 42 ms | **rg 快 2.6x** |
| `D:\VibeCoding` | 82 ms | 40 ms | **es 快 2.1x** |
| **整盘 `D:\`** | **1077 ms** | **40 ms** | **es 快 27x** |

**原因**：es.exe 有 **~40 ms 固定开销**（进程启动 + IPC，实测 `-version` 就要 33 ms），而 ripgrep 的开销随目录树线性增长。

**结论**：守卫在**宽范围搜索**（跨项目、整盘）是显著净收益；在**窄范围**（单项目内）反而比内核 glob 慢 2–3 倍。跨查询中位数约 **3.1x** 加速，但方差极大。

### ⚠️ 一个被基准抓出的真实缺陷

最初实现的守卫**原样传递 glob 模式**，而 Everything 的 `-path` **本就按文件名递归**，所以 `**/` 前缀是多余的。实测：

```
es -path D "**/*.ts"       1525 ms   223 条
es -path D "*.ts"            40 ms   223 条   ← 结果相同，快 38 倍
es -path D "src/**/*.ts"    218 ms     0 条   ← 完全错误，丢失全部匹配
es -path D/src "*.ts"        41 ms     5 条   ← 正确
```

即最初的建议命令**既慢 38 倍、又在带目录前缀时返回 0 条**——完全违背守卫初衷。现已在 `translateToEsPattern` 中修正并加了 7 条断言钉住。

### glob → es.exe 的映射

模式语言几乎不用翻译（`**` 在两边都是递归的），只是参数名不同：

| 内置 glob | es.exe |
|---|---|
| `pattern: "**/*.ts"` | `es.exe "**/*.ts"` |
| `path: "D:\proj"` | `-path "D:\proj"` |
| 省略 path（=工作区） | `-path <会话工作区>` |

实测确认的两个细节：

- **`**` 必须保留**：`src/**/*.ts` 能匹配 `src/__deep/probe.ts`，而 `src\*.ts` **不递归**。所以模式形状原样传递，不做扁平化。
- **通配符要加引号**：不加引号的 `*.ts` 会被 shell 先展开，es.exe 根本看不到它。

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
  node "$env:USERPROFILE\.dsh\skills\aria2-download\scripts\aria2-dl.js" "<URL>" --out=<filename>

Options: --dir=<dir> for the destination, --header="K: V" for headers,
--no-wait to enqueue and return immediately (then query with --status <gid>).
A blocked command is never partially executed.

Blocked command: curl -o Win11.iso https://.../y.iso
```

**URL 会被自动提取并填进建议命令**——被拒绝的一方不需要猜该怎么改。

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

## 性能边界：为什么不是普遍加速

内置 `glob` 用 ripgrep **每次调用都走目录树**；es.exe 走后端索引，但**每次调用都要启动一个进程**（实测 ~36ms 纯启动 + ~15ms IPC/查询）。

**所以守卫不是普遍加速**：

| 场景 | rg（内核 glob） | es.exe | 谁快 |
|---|---|---|---|
| 单项目 | 19–30 ms | 48 ms | **rg 快 1.6–2.5x** |
| 跨项目 `D:\VibeCoding` | 631 ms | 49 ms | **es 快 13x** |
| 整盘 `D:\` | 7726 ms | 51 ms | **es 快 152x** |

**能否消除 es.exe 的固定开销？** **能，协议已完整逆向并实现。**

我最初判断"命名管道是私有二进制协议，需逆向，不可行"。**这个判断是错的** ——
用 REA + Ghidra 逆向 `es.exe` 后，协议、记录解码全部打通，客户端已可运行：

```
管道 : \\.\PIPE\Everything IPC
请求 : [i32 cmd][i32 len][payload]     cmd=7 为搜索
响应 : 循环 { [i32 status][i32 len][body] }  100=中间帧 200=末帧 404=错误
记录 : [u8 flags(1=目录)][varint 路径长度][utf8 路径]
```

同口径实测（**这才是可比的数字**）：

| 查询 | IPC 客户端 | es.exe | 加速 |
|---|---|---|---|
| `*.md` | 5.9 ms | 38.4 ms | 6.5x |
| `package.json` | 12.8 ms | 50.6 ms | 3.9x |
| 无匹配 | 13.0 ms | 48.1 ms | 3.7x |

**约 4–6 倍**，不是我先前误报的 160 倍。正确性已验证：`package.json` 结果数与 es.exe
**完全一致（7199）**，flags 与真实文件系统 **123/123 条一致**。

完整协议见 [docs/everything-ipc-protocol.md](docs/everything-ipc-protocol.md)，
被推翻的早期调查见 [docs/resident-query-investigation.md](docs/resident-query-investigation.md)。

⚠️ **尚未接入守卫**：客户端已实现并测试（`src/everything-ipc.ts`，22/22 通过），
但守卫仍在用 es.exe。切换需要 es.exe 回落路径，见文档「风险」一节。

## 已知边界

- **拦不住「命令内部的下载」**：`python script.py` 里用 `urllib` 下载，钩子看到的是 `python script.py`，看不到它内部在做什么。彻底收口需要本地代理层，不在本插件范围。
- **拦不住非 DSH 发起的下载**：在 DSH 之外的终端里 `curl -o` 不受影响。
- 依赖宿主提供 `tools/pre-execute` 钩子（已在 DSH 0.1.5-rc 系列上实测）。

## 开发

```bash
npm install
npm test          # 构建 + 检测器单测 + 真实 ToolRuntime 运行时测试
npm run typecheck
```

测试分两层：

- `tests/detect.test.mjs` — 纯函数检测规则（38 项，含大量「必须放行」的反例）
- `tests/guard.runtime.mjs` — 把**构建产物**装进真实 cordis + ToolRuntime，验证 deny 真的拦住了工具体

运行时测试会自行在本机寻找已安装的 DSH 树；找不到时**跳过而非失败**，这样裸克隆仓库也能通过。

## 许可

MIT
