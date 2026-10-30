# 已向上游 dsh-ops 提交的条目

本文件记录 ops-guard 的功能中，哪些已经作为 issue 提交给
[T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)，以及各自的状态与依据。

上游的流程要求（见其 `docs/CONTRIBUTING.md`）：
**每个 PR 必须关联一个 issue，且必须先认领 issue**；新功能还需要维护者批准后才能写代码。
所以这里只记录 issue，不代表已经获批实现。

---

## #506 · shell 层的大文件下载没有约束

- 链接：https://github.com/T-Auto/dsh-ops/issues/506
- 提交：2026-10-30
- 对应本仓库：`src/detect.ts`（下载检测）+ `src/index.ts` 的 guard 1
- 状态：**open，等待维护者回应**

**提交的问题**：模型用 `curl -o` / `wget -O` / `Invoke-WebRequest -OutFile` /
`Start-BitsTransfer` 直接落盘下载时走单连接流式写盘，比专用下载器慢两个数量级。
本机实测同一 ISO：`curl -o` 0.13 MB/s vs aria2 ~11.78 MB/s。

**提议的形态**：不是"强制用 aria2"，而是**检测与转发分离** ——
检测层识别"会写字节到磁盘"的命令，转发层指向用户自己配置的下载器；
没配置就不拦。这样不绑定任何第三方工具。

**为什么这个不属于 ops-guard**：本仓库的实现把转发目标硬编码成 aria2，
依赖机器私有的 `~/.dsh/skills/aria2-download`。换成通用能力才适合上游。

---

## #507 · 盲等 sleep 应改用 job_output(wait)

- 链接：https://github.com/T-Auto/dsh-ops/issues/507
- 提交：2026-10-30
- 对应本仓库：`src/sleep-advisory.ts` + `src/index.ts` 的 post-execute 提示
- 状态：**open，等待维护者回应**

**提交的数据**（全量 342 个会话、61,205 次子调用）：

| 量 | 数量 |
| --- | ---: |
| `run_in_background` 启动 | 513 |
| `job_output` 调用 | 351（`wait:true` 仅 109） |
| `sleep` 调用 | 772 |

每个后台任务平均只被查询 0.68 次，而 sleep 次数是后台任务数的 1.5 倍。

**提议的形态**：只提示、不拦截，每会话最多一次。
理由是 13% 的 sleep 在等外部服务，**没有 job 可等**，拦了会打断工作。

**已写进 issue 的已知边界**：PTC 模式下这个钩子无法实现 ——
`tools/ptc-dispatch-log` 的载荷是
`{ exec, agent, subCallId, name, isError, content }`，**没有 `arguments`**，
读不到命令字符串（探针实测为 `name=bash cmd=` 空）。

---

## #423 评论 · Everything 路线的固定开销数据

- 位置：https://github.com/T-Auto/dsh-ops/issues/423#issuecomment-6526217874
- 提交：2026-10-30
- 对应本仓库：`src/everything-ipc.ts`
- 状态：**已发评论，#423 目前结论是 no-go（针对自建索引）**

**为什么发在 #423 而不是新开 issue**：#423 是"评估可选文件名/路径索引后端"，
维护者评论 1 明确把 **Everything 嵌入式集成**列为候选路线。新开 issue 会与它重复。

**补的数据**（#423 原有讨论中没有的一组）：

| 路径 | 全盘查询 | 说明 |
| --- | ---: | --- |
| `es.exe` 每次新进程 | 463–642 ms | 3 文件目录也要 279–354 ms → 固定开销约 350–400 ms |
| **常驻 IPC 管道** | 15.3–29.8 ms | 复用已建立的 `\.\PIPE\Everything IPC` |

**核心判断**：这条路线成不成，取决于**是否维持常驻连接**，而不是要不要用 Everything。
新进程路径的固定开销比目录遍历还慢。

**没有主张 GO**：只提供测量与判断依据，是否推进由维护者按预注册阈值决定。

---

## 没有提交的部分

### 搜索守卫整体（拦截内置 glob 改走 Everything）

**不提交。** 原因：

1. dsh-ops 的 `ops_glob` / `ops_grep` 是用自己实现的 Rust worker（`native/crates/`），
   与 Everything 是两套技术路线；提"改用 Everything"会被视为重复造轮子。
2. 只对 Windows 有效，且要求 Everything 常驻。
3. #474 已经在跟踪他们自己的 `ops_grep` 性能，方向是优化 worker 而不是换后端。
4. #423 已经覆盖了"要不要引入索引后端"这个正确的问题位置。

### #484 / #458 的复现尝试（已做，无法复现）

在隔离 profile `issue484-test` 里实测过，**两个都无法在本机复现**：

- **#484**（受限档位静默失败）：0.4.3 在 `workspace-write` 下 `ops_bash` 正常执行
  （`echo PROOF > proof.txt` 确实创建了文件）；`read-only` 下拒绝时错误信息完整
  （`EXECUTION_RESTRICTED` + `[sandbox: file access denied]` + `exit code 1`）。
  没有出现 issue 描述的"exitCode 恒为 0、无输出"。
- **#458**（ConstrainedLanguage 下准备脚本失败）：本机
  `$ExecutionContext.SessionState.LanguageMode` 是 **FullLanguage**，触发前提不成立。

结论记在这里，避免以后重复投入。
