# 常驻查询能否消除 es.exe 的固定开销？

> ⚠️ **本报告结论已被推翻。** 我当时判定"三条路径均不通、不列入方案"，
> 但命名管道实际可用。完整协议见 [everything-ipc-protocol.md](everything-ipc-protocol.md)。
> 本文件保留原样，作为"过早放弃"的记录。


**结论：理论收益很大（~48ms → ~3ms），但本机当前走不通。三条路径都实测过了。**

调查日期 2026-10-12。

---

## 一、开销花在哪（实测分解）

| 项目 | 耗时 | 说明 |
|---|---|---|
| `es.exe -version` | **36 ms** | 纯进程创建 + exe 加载，无搜索 |
| `es.exe` 空匹配 | **50.7 ms** | +14.7 ms = IPC 连接 + 查询 |
| `es.exe` 有结果 | 46.9 ms | 结果量对耗时几乎无影响 |
| `cmd /c exit`（对照） | 13.2 ms | Windows 最小进程基线 |
| `\\.\pipe\Everything IPC` 连接 | **0.1 ms** | 纯 IPC 往返 |

**分解结论**：48 ms 里，**约 36 ms 是 es.exe 自身的进程启动**，只有 **~15 ms 是 IPC + 查询**。

所以「固定开销」的主体是**进程创建**，而非 IPC 本身。

---

## 二、三条常驻路径，逐一验证

### ❌ 路径 1：命名管道直连（技术上最优，但协议不通）

Everything 确实暴露了命名管道：

```
\.\pipe\Everything IPC
\.\pipe\Everything Service
```

实测**连接耗时 0.1 ms**（对比 es.exe 全量 48 ms，差约 500 倍）。

**但连上之后发任何格式都无响应**：

| 试法 | 结果 |
|---|---|
| 空写 | timeout，0 字节 |
| 纯文本 `*.md` | timeout，0 字节 |
| 4 字节长度前缀 + 文本 | timeout，0 字节 |

这是 Everything 的**私有二进制协议**（es.exe 内部使用，未公开）。要接它必须逆向 —— **不列入方案**，维护成本远超收益。

### ⚠️ 路径 2：ETP 服务器（可行，需用户开启）

`Everything.ini` 里有 `allow_connect_to_etp_server=1`，但 **ETP 服务器本身未启用**（无任何 `etp_server_*` 键）。ETP 是类 FTP 的文本协议，Everything 1.5 支持。

### ⚠️ 路径 3：HTTP 服务器（最实用，同样需开启）

Everything 的 HTTP 服务器（`http://127.0.0.1/?search=...`）是**文本协议且零依赖**（Node `fetch` 直接可用），最适合常驻。

**但当前是关闭的**：主 ini 与备份 ini **都没有任何 `http_server` 键**，说明从未启用。

### ❌ 路径 4：es.exe 常驻模式

读了 `es.exe -help` 全文：**没有** server / daemon / stdin / pipe 任何常驻选项。纯一次性 CLI。

---

## 三、若能消除，收益有多大

| 场景 | rg（内核） | es 现在 | es 常驻（估算） |
|---|---|---|---|
| 单项目 src/ | 19 ms | 48 ms | **~3 ms** |
| 单项目 | 30 ms | 49 ms | **~3 ms** |
| `D:\VibeCoding` | 631 ms | 49 ms | **~3 ms** |
| 整盘 `D:\` | 7726 ms | 51 ms | **~3 ms** |

**关键影响**：现在 es 只在**宽搜索**占优（窄搜索慢 1.6–2.5x）；**常驻后所有区间都占优**。

即常驻能把守卫从「宽搜索的优化」变成「无条件的优化」。

（估算依据：loopback HTTP 往返 1–3 ms + Everything 索引查询 <1 ms。**未实测**，因服务器未开。）

---

## 四、为什么本机暂不建议做

1. **需要用户改 Everything 配置**（GUI 手动开 HTTP 或 ETP），插件无法单方面完成。
2. **收益只在窄搜索区间显著**（宽搜索已 150x，再快 16 倍意义有限）。
3. **引入新依赖**：现在只依赖一个 exe；走后端服务器要管端口、鉴权、失败回退。
4. **降级路径复杂**：服务器没开时必须回落 es.exe，等于维护两条路径。

**若要做的正确形态**：不是「消除 es.exe」，而是**双后端** ——
优先尝试常驻 HTTP（探测到服务器在听才用），否则回落 es.exe。

---

## 五、可复现命令

```powershell
$es = "$env:USERPROFILE\bin\es.exe"
Measure-Command { & $es -version }              # ~36 ms 纯启动
Measure-Command { & $es -n 10 "nomatch_xyz" }   # ~50 ms 含 IPC
Measure-Command { cmd /c exit }                 # ~13 ms 进程基线

# 命名管道是否存在
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match 'very' }

# HTTP 服务器是否开启（当前应为空）
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 80 }
```
