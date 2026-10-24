# dsh-ops-guard

把两条**技能里的建议**变成**运行时的强制**：

| 守卫 | 规则 | 替代通道 |
|---|---|---|
| **下载守卫** | 大文件下载必须走 aria2 | `aria2-dl.cjs` → aria2-next (Motrix Next) |
| **搜索守卫** | 找文件必须走 Everything | Everything 常驻 IPC |

两者都在 `tools/pre-execute` 拦截，但**拦截之后的处理不同**，这个区别是本插件的核心：

- **下载守卫 → 拒绝 + 给命令**：下载是副作用操作，守卫不能替模型执行
- **搜索守卫 → 拒绝 + 给结果**：搜索是只读查询，守卫**自己算完再返回**，模型无需再发起任何调用

## 为什么需要它

### 下载：提示词拦不住

`aria2-download` 技能把规则写在提示词里，而**提示词只是建议**。实际发生过的：

| | aria2 通道 | 绕过通道 |
|---|---|---|
| 引擎 | aria2-next (Motrix Next) | node 单连接 https |
| 实测速度 | **11.78 MB/s** | **0.13 MB/s** |
| 断点续传 | ✅ | 部分 |

同一条 4.76 GB 的镜像差了 **约 90 倍**。而 agent 手头只要有一个 `download.cjs` 就会顺手用它 —— 在 shell 层面 `node download.cjs` 和 `aria2-dl.js` 长得一模一样，没有任何机制能区分。

### 搜索：内置工具不会自己让路

内核的 `glob` 是**能用**的，所以模型没有理由去用 Everything。规则必须落到运行时。

## 实测：守卫在所有范围都更快

这是**当前实现**的数据（11 次中位数，`bench/scope-latency.mjs`）：

| 范围 | 内置 glob | 守卫 | 谁快 |
|---|---|---|---|
| 单个小目录（3 个文件） | 11.6 ms | **7.7 ms** | 守卫 1.5x |
| 单个子目录 | 12.5 ms | **6.8 ms** | 守卫 1.8x |
| 单个项目 | 21.5 ms | **6.9 ms** | 守卫 3.1x |
| 单个项目（仅 src） | 11.7 ms | **7.7 ms** | 守卫 1.5x |
| `D:\VibeCoding` | 559.8 ms | **8.2 ms** | 守卫 **68x** |

**连最小范围的单目录也更快。** 原因在于**两边成本的来源不同**：

| | 成本构成 |
|---|---|
| 内置 glob | **进程启动 + 遍历目录树** |
| 守卫 | **仅 IPC 往返**（进程已存在） |

单独测 ripgrep 的启动开销是 **10.4 ms**。也就是说，在 3 个文件的目录上，
内置 glob 的 11.6 ms 里**有 10.4 ms 是进程启动**，真正搜索只花了 1.3 ms。

**守卫完全不付这笔钱**，因为它没有进程可启动 —— 管道已经在那儿了。

对「单目录会不会反过来」这个疑问，做了 25 次逐次对比：

```
      中位      p10      p90
rg    11.6 ms   10.6     13.2
守卫   7.7 ms    6.7      8.7
       → 守卫快 1.51x，25 次里 rg 只赢 1 次
```

### ⚠️ 一个我先前搞错、并已更正的结论

早期版本的 README 写着：**窄范围搜索比内置 glob 慢 2–3 倍。**

**那个结论是错的**，而且错得有代表性：它拿 **es.exe 完整进程**（约 41 ms）对比 ripgrep，
然后把 es.exe 的成本算到了守卫头上。

**守卫从不启动进程。** 它在 DSH 进程内问那条已经存在的管道。那 ~35 ms 的启动开销它一分钱不付。

（es.exe 的那个结论本身是对的 —— 命令行工具每次都要启动进程。只是它**不适用于守卫**。）

### 反过来，也有一个真实的代价

**Everything 是文件索引，不是内容索引。** 而且它的索引**不是瞬时的**：

```
刚创建的 3 个文件   → es.exe 查到 0 条
3 秒后             → 3 条
```

刚写盘的文件可能查不到。这是**索引型方案固有权衡**，不是缺陷 ——
但对「刚创建就想立刻找到」的场景要注意。

## 工作原理

监听 cordis 的 `tools/pre-execute` 钩子（waterfall 模式），在**工具真正执行之前**裁决：

```
模型请求 glob("**/*.md", path: "D:/proj")
    ↓
tools/pre-execute 钩子触发
    ↓
搜索守卫走 Everything IPC 查询 → 拿到结果
    ↓
返回 { kind: 'deny', reason: '<拒绝说明 + 实际结果>' }
    ↓
工具体从未执行，模型直接读到结果
```

## 搜索守卫

### ⚠️ 只拦 glob，不拦 grep —— 这是实测结论

内置的搜索工具是**两个**，可替代性**完全不同**：

| 工具 | 能力 | 是否替代 | 依据 |
|---|---|---|---|
| `glob` | 按**文件名/路径**找 | ✅ **替代** | Everything 就是干这个的 |
| `grep` | 按**文件内容**找 | ❌ **不替代** | 见下 |

**为什么不动 grep**：Everything 的内容搜索需要用户**显式开启内容索引**，本机实测**是关闭的**：

```
es.exe "content:dsh-ops-guard"   → 无任何输出
```

在此状态下拦截 grep，等于把**慢的内容搜索变成没有内容搜索** —— 比它要防止的问题严重得多。
这与下载守卫的原则一致：**宁可漏掉一次优化，也不阻断一条工作流。**

被拒时给出的理由里**明确告诉模型 grep 没被拦**，避免它绕路。

### 为什么守卫自己执行，而不是给条命令

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

逆向自 `es.exe` 1.1.0.37（Ghidra）。**全部命令号与字段布局**见
[docs/everything-ipc-protocol.md](docs/everything-ipc-protocol.md)。

> 卡了一整轮的那个坑：请求里的长度字段是 **varint**，写成 u32 会让 Everything
> **静默忽略查询** —— 响应结构依然完整、能正常解析、`total` 报 0，
> 看起来像「没有匹配」而不是「格式错误」。

### glob → Everything 查询的映射

模式语言几乎不用翻译，要处理的是**作用域**：

| 内置 glob | Everything 查询 |
|---|---|
| `pattern: "**/*.ts"` | `*.ts`（`**/` 前缀多余，见下） |
| `path: "D:\proj"` | `path:D:\proj `（**查询语法，不是 `-path`**） |
| 省略 path | 取会话工作目录 |

⚠️ **管道协议里没有 `-path`** —— 那是 es.exe 的命令行参数，线格式里并不存在。
作用域必须写进查询本身。已验证与 `es -path` **结果集合完全相同**（11 vs 11，零差异）。

另有两个实测确认的细节：

- **`**` 必须保留**：`src/**/*.ts` 能匹配 `src/__deep/probe.ts`，而 `src\*.ts` **不递归**。
- **Everything 不按 shell 方式解析相对路径**：实测 `path:. *.md` 返回**整盘 24693 条**（静默地）。
  相对路径现按工作目录解析，无法解析时不猜、直接放弃限定。

### 一个被基准抓出的真实缺陷

最初实现**原样传递 glob 模式**，而 Everything 的 `-path` **本就按文件名递归**，`**/` 前缀是多余的：

```
es -path D "**/*.ts"       1525 ms   223 条
es -path D "*.ts"            40 ms   223 条   ← 结果相同，快 38 倍
es -path D "src/**/*.ts"    218 ms     0 条   ← 完全错误，丢失全部匹配
es -path D/src "*.ts"        41 ms     5 条   ← 正确
```

即最初的建议命令**既慢 38 倍、又在带目录前缀时返回 0 条**。已在 `translateToEsPattern` 修正。

### 回落路径

**任何管道故障**（Everything 没运行、超时、协议变动）都会自动退回「给命令」模式
（`searchDenialMessage`）。守卫不会因为 Everything 没跑就让搜索失效 ——
把慢搜索变成没有搜索，比它要防的问题严重得多。

### 为什么 es.exe 只在加载时探测一次

`tools/pre-execute` 在**每次工具调用**前面跑，探测 es.exe（要 stat 十几个目录）放在钩子里是浪费。
改为插件挂载时解析一次，并在探测时**校验候选路径是文件而非目录**。

> 这个校验来自一个真实事故：PowerShell 7 安装目录下有个叫 `es` 的**西班牙语本地化文件夹**，
> 裸名探测命中了它，守卫于是让模型去执行一个**目录**。

## 拦截规则

| 规则 | 触发 | 处置 |
|---|---|---|
| `curl-output` | `curl -o` / `-O` | 拒绝 + aria2 命令 |
| `wget-output` | `wget -O` | 拒绝 + aria2 命令 |
| `invoke-webrequest-outfile` | `Invoke-WebRequest -OutFile` | 拒绝 + aria2 命令 |
| `bits-transfer` | `Start-BitsTransfer` | 拒绝 + aria2 命令 |
| `glob` | 内置 `glob` 工具 | 拒绝 + **实际结果** |

放行的例子（**必须不被误拦**）：

| 命令 | 为什么放行 |
|---|---|
| `curl https://api.x/data` | 输出到 stdout，不落盘 |
| `curl -o` 出现在字符串里 | 不是真正的下载参数 |
| `Invoke-RestMethod https://api.x/data` | 不落盘 |
| 非 shell 工具 | 守卫只裁决 shell 与 glob |
| `grep` | 内容搜索，见上 |

## 拦截后模型看到什么

### 下载守卫

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

**URL 会被自动提取并填进建议命令** —— 被拒绝的一方不需要猜该怎么改。

### 搜索守卫

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

> **为什么必须自带**：早期版本的提示指向 `~/.dsh/skills/aria2-download/scripts/aria2-dl.js` ——
> 一个**机器私有路径**。在没有该技能的机器上，守卫会拒绝下载、然后让用户去用一个
> **根本不存在**的文件。那比不拦更糟：既打断流程，又不给出路。

该脚本**只走 JSON-RPC**（不依赖 `aria2c.exe`），要求本机运行 **aria2-next** 引擎
（Motrix Next 内置）。引擎未启动时会明确报错，而不是静默失败。

### 盲等提示的作用范围（只在 native 模式）

`tools/post-execute` 上的盲等提示**不覆盖 PTC 模式**。这是内核契约限制，不是疏漏：

- PTC 模式下模型只调一个 `run_code`，其中每个 `bash` / `pwsh` 都是**子调用**，
  不经过 `tools/post-execute`
- PTC 的对应钩子 `tools/ptc-dispatch-log` 确实会触发，但它的载荷是
  `{ exec, agent, subCallId, name, isError, content }` —— **没有 `arguments`**
- 桥接层传入的是**外层 `run_code` 的 exec**，而不是子调用参数，因此监听器
  拿不到命令字符串。实测探针记录为 `name=bash cmd=`（空）

走 native（因此包含提示）的 preset：`standard`、`minimal`、`cordis`、`tavernweave`
—— 它们都不配置 `tool-presentation`，内核默认 `mode: native`。
只有显式选择 PTC 的 preset 落在覆盖范围之外。

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

安装后**重启 DSH** 生效。搜索守卫还要求本机运行 Everything（含 `es.exe`）。

## 已知边界

- **拦不住「命令内部的下载」**：`python script.py` 里用 `urllib` 下载，钩子看到的是
  `python script.py`，看不到它内部在做什么。彻底收口需要本地代理层，不在本插件范围。
- **拦不住非 DSH 发起的下载**：在 DSH 之外的终端里 `curl -o` 不受影响。
- **Everything 的 IPC 协议是私有的、未公开的**，任何版本都可能更改。已实现回落路径，
  但若协议变动，守卫会静默退回「给命令」模式（功能不受影响，只是不再省那次往返）。
- **Everything 索引有延迟**（实测新文件约 3 秒），刚写盘的文件可能查不到。
- **搜索守卫回答的是文件名索引，不是内容** —— 这正是它不动 `grep` 的原因。
- 依赖宿主提供 `tools/pre-execute` 钩子（已在 DSH 0.1.5-rc 系列上实测）。

## 开发

```bash
npm install
npm test          # 构建 + 全部测试
npm run typecheck
```

### 测试跑在哪个内核上（重要）

`tests/kernel-host.mjs` 负责解析 DSH 内核，**顺序不能改**：

1. 打包的 desktop 应用（`resources/app/node_modules`）—— **这才是实际运行的**
2. `DSH_KERNEL_ROOT` 环境变量覆盖
3. `~/.dsh` 下的 pnpm store —— **仅作兜底，标记为 untrusted**

> ⚠️ **这曾是本项目最严重的测试缺陷。** 每个测试原本各自实现一遍解析逻辑，
> 都扫描 `~/.dsh/*/node_modules/.pnpm` 取**第一个** `dsh-tools`。本机第一个是
> `dsh-android-fork@0.1.5-rc.1`，而 desktop 实际加载 `0.2.1-rc.2`。
>
> 后果是「测试全绿但功能不工作」：一批断言在 0.1.5-rc.1 上全部通过，真实应用里
> 却毫无反应 —— 两个内核的代码路径不同，旧内核上通过的结论对新内核不成立。
> 靠一次重启 + 一句 `sleep 21` 没反应才发现。

`tests/kernel-host.test.mjs` 现在守着这件事：断言解析结果**必须是打包应用**、
必须是 trusted、版本必须与应用自带的一致、且**不能**是 android-fork。
任何把 pnpm 扫描排回前面的改动会立刻失败。

测试分六层：

| 文件 | 覆盖 | 项数 |
|---|---|---|
| `tests/kernel-host.test.mjs` | **内核解析守护**：必须指向打包应用，不能是 android-fork | 12 |
| `tests/detect.test.mjs` | 下载检测规则（含大量「必须放行」的反例） | 65 |
| `tests/search.test.mjs` | 搜索检测、模式翻译、查询作用域、es.exe 探测、拒绝文本 | 41 |
| `tests/everything-ipc.test.mjs` | IPC 编解码（varint 往返、请求/响应布局、真实管道） | 22 |
| `tests/guard.runtime.mjs` | 构建产物装进真实 cordis + ToolRuntime，验证 deny 真的拦住了工具体 | 26 断言 |
| `tests/ipc-guard.e2e.mjs` | 端到端：断言拒绝理由里**带着结果**，而不是一条命令 | 8 断言 |

前三层是纯函数，随时可跑。后两层会自行在本机寻找已安装的 DSH 树；
找不到时**跳过而非失败**，这样裸克隆仓库也能通过。

另有两个基准脚本：

```bash
BENCH_REPS=11 node bench/scope-latency.mjs   # 守卫 vs 内置 glob，全范围
node bench/guard-latency.mjs                 # 三路对比（含 es.exe）
```

## 许可

MIT
