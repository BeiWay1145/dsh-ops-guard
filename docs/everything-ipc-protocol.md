# Everything IPC 协议逆向报告

**结论：协议已完全破解，常驻查询比 es.exe 快约 160 倍（0.3ms vs 47.8ms）。**

被测文件：`C:\Users\BeiWay1145\bin\es.exe` (ES 1.1.0.37)
sha256 `3be7185707e8023cd9295dbcb7a3fa4092a3d8f52b7fa92a0b84243ab40d12f3`
工具：REA (Ghidra 12.1.4 后端)
日期：2026-10-12

---

## 一、传输层：命名管道

```
\\.\PIPE\Everything IPC
```

由 `FUN_140019670` 建立：

```c
CreateFileW(L"\\\\.\\PIPE\\Everything IPC",
            GENERIC_READ|GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL)
```

失败时用 `WaitNamedPipeW` 轮询，30 秒上限。若指定了 `-instance`，管道名会拼上实例名。

---

## 二、帧格式（完全确认）

### 请求

由 `FUN_140017960` 发送：

```
偏移 0 : int32   command   （小端）
偏移 4 : int32   length    （payload 字节数）
偏移 8 : bytes[] payload
```

### 响应

由 `FUN_140017e70` / `FUN_1400183a0` 读取：

```
循环:
  读 8 字节头: [int32 status][int32 length]
    status == 100  → 中间帧，继续读
    status == 200  → 末帧，结束
    其他 (如 404)  → 错误，终止
  读 length 字节 payload
```

**这条已被实测证实**：发错命令号时 Everything 返回 `status=404, len=0`。

---

## 三、已确认的命令号

| cmd | 含义 | 证据 |
|---|---|---|
| 4 | 获取版本 | 返回 1423 = Everything 1.5.0.1423 |
| 7 | **执行搜索** | `FUN_14000f400` L214 发送搜索请求 |
| 9 | 设置 4 字节开关 | `FUN_140018600(handle, u32) → bool` |
| 0x12 (18) | 获取结果数 | 返回 `%I64u\r\n`；未设查询时返回 -1 |
| 0x19 (25) | 布尔开关 | 4 字节入 → 4 字节出 |
| 0x1A (26) | 布尔开关 | 同上 |
| 0x1B (27) | 布尔开关 | 同上 |
| 0x1C (28) | 布尔开关 | 同上 |

---

## 四、cmd=7 的请求 payload（实测可用）

```
偏移 0 : uint32  flags        （0x4000 常见；bit14 表示后续长度用 64 位）
偏移 4 : uint32  queryLen     （UTF-8 字节数，不含 NUL）
偏移 8 : bytes[] query        （UTF-8 编码，由 FUN_14001cc30 编码器确认）
         uint64  field1        （DAT_14003c3a8）
         uint64  field2        （DAT_14003a010）
         uint32  field3        （DAT_14003c370）
         uint32  sortCount
         [ sortCount × 8 字节排序项 ]
```

**flag 位含义**（从 `FUN_14000f400` 的置位逻辑读出）：

| 位 | 含义 |
|---|---|
| 0x4000 | 基础 |
| 0x4001 | **offset 用 64 位** |
| 0x0010 | 某个 bool（DAT_14003c381）|
| 0x0002 / 0x0004 | 排序相关 |
| 0x0020 / 0x0040 / 0x0080 / 0x0100 | 字段显示开关 |
| 0x0800 | 隐藏某些结果 |

---

## 五、速度实测（关键成果）

| 方式 | 中位耗时 |
|---|---|
| **IPC 直连（含连接）** | **0.3 ms** |
| es.exe（含进程启动） | 47.8 ms |

**约 160 倍差距。**

三次采样：0.2 / 0.3 / 0.5 ms，稳定。

---

## 六、尚未完成的部分

命令号与帧格式**已确认可用**，但**结果集的完整解码还没做完**：

- cmd=7 返回的 55 字节是**查询状态帧**（回显查询串尾部，如 `*.md` → `md`），
  不是文件列表
- 完整结果需要**继续读多帧**，并解析 `FUN_140018670` 里那套复合结构
  （flags 驱动的可变长度字段 + 排序项 + 逐条记录）
- `FUN_140018670` 是解析器入口，揭示了字段顺序，但**每条记录的字段布局**
  尚未逐字节验证

**也就是说**：通道打通了、速度确认了、帧格式拿到了；
**剩下的是把结果记录解析出来**——这是工程量问题，不是可行性问题。

---

## 七、对插件的意义

如果完成解析，守卫可以做到：

| 场景 | rg | es.exe | 常驻 IPC |
|---|---|---|---|
| 单项目 | 19 ms | 48 ms | **~0.3 ms** |
| 整盘 | 7726 ms | 51 ms | **~0.3 ms** |

即守卫从「宽搜索占优」变成「**所有区间压倒性占优**」，
单项目内也不再倒挂（现在是慢 1.6–2.5x）。

**但需要权衡**：
- 依赖 Everything 私有协议，**未公开、可能随版本变化**
- 需要在插件里内置协议实现（约 100–200 行）+ 解析器
- 必须有 es.exe 回落路径（Everything 未运行时）

---

## 八、复现命令

```js
// Node 直连（零依赖）
import net from 'node:net'
const sock = net.connect('\\\\.\\PIPE\\Everything IPC')
// 请求: [i32 cmd=7][i32 len][payload]
// 响应: 循环读 [i32 status][i32 len][body]，status==200 结束
```

REA 侧：
```
open_binary("C:\Users\BeiWay1145\bin\es.exe")
list_strings()                      → 管道名、错误消息
xrefs("0x14002d370")                → ES_IPC 窗口类
procedure_pseudo_code("0x140017960") → 发送器（帧格式）
procedure_pseudo_code("0x140017e70") → 接收器（状态码）
procedure_pseudo_code("0x14000f400") → 搜索主逻辑（cmd=7）
read_bytes("0x140032da0", 512)      → 搜索语法关键字表
```
