# Everything IPC 协议 —— 完整逆向报告

**状态：协议完全破解，记录解码已验证，客户端实现可用。**

被测文件：`C:\Users\BeiWay1145\bin\es.exe`（ES 1.1.0.37）
sha256 `3be7185707e8023cd9295dbcb7a3fa4092a3d8f52b7fa92a0b84243ab40d12f3`
工具：REA（Ghidra 12.1.4）  日期：2026-10-12

---

## 一、传输层

```
\\.\PIPE\Everything IPC
```

`FUN_140019670` 用 `CreateFileW` 打开，失败则 `WaitNamedPipeW` 轮询（30 秒上限）。
指定 `-instance` 时管道名会拼上实例名。

---

## 二、帧格式

### 请求（`FUN_140017960`）

```
偏移 0 : int32  command
偏移 4 : int32  payloadLength
偏移 8 : bytes  payload
```

### 响应（`FUN_140017e70` / `FUN_1400183a0`）

```
循环:
  读 8 字节: [int32 status][int32 length]
    status == 100 → 中间帧，继续
    status == 200 → 末帧，结束
    其他          → 错误（实测 404）
  读 length 字节 body
```

---

## 三、命令号

| cmd | 含义 | 依据 |
|---|---|---|
| 4 | 版本 | 实测返回 1423 = Everything 1.5.0.1423 |
| **7** | **搜索（返回记录）** | `FUN_14000f400` |
| 9 | 设 4 字节开关 | `FUN_140018600` |
| 0x12 | 结果计数 | 需先设查询，否则返回 -1 |
| 0x19–0x1C | 布尔开关 | 4 字节入 → 4 字节出 |

---

## 四、cmd=7 请求 payload

```
[u32   flags]          0x4000 为基础值
[varint queryLength]   UTF-8 字节数，不含 NUL
[utf8  query]
[u64   offset]         起始记录
[u64   count]          返回条数
[u32   field3]
[varint sortCount]
```

### ⚠️ 最大的坑：长度字段是 varint，不是 u32

把 `queryLength` 写成 u32 会让 Everything **静默忽略查询**：响应结构依然完整可解析、
`total` 报 0，看起来像"没有匹配"而不是"请求格式错误"。

varint 编码规则（解码见 `FUN_140017ce0`）：

| 条件 | 编码 |
|---|---|
| 首字节 < 0xFF | 就是该字节 |
| == 0xFF，后 u16 ≠ 0xFFFF | 255 + u16 |
| == 0xFF，u16 == 0xFFFF，u32 < 0xFFFFFFFE | 65535 + u32 |
| 否则 | 后续 u64 |

---

## 五、响应 body 解析（`FUN_140018670`）

```
[u32 flags]                 bit14: 后续字段为 64 位；bit11: 多一个 u64
[u64|u32 field1]
[u64|u32 field2]            ← 结果总数
[u64      field]            仅当 bit11
[u64|u32 field3]
[u64|u32 field4]
[varint descriptorCount]    后跟该数量的 [u32,u32]
[varint fieldCount]         后跟该数量的 [u32,u32,u8]
记录区: 重复 {
  [u8     recordFlags]      1 = 目录, 0 = 文件
  [varint pathLength]
  [utf8   path]
}
```

**解析是精确的**：实测消费 518/518 字节，逐字节对齐，无剩余。

---

## 六、验证

### 正确性

| 项目 | 结果 |
|---|---|
| 解析消费率 | 518/518 字节（100%） |
| flags vs 真实文件系统 | **123/123 条一致（100%）** |
| `package.json` 结果总数 | 本客户端 **7199** vs es.exe **7199** ✅ 完全一致 |
| 单元测试 | 22/22 通过 |

### 性能 —— 一个被我自己推翻的数字

**我最初报的"160x"是错的。** 那是拿**裸连接**（0.3ms）对比 **es.exe 完整进程**（48ms），
两者不是同一个测量。同口径实测：

| 查询 | IPC 客户端 | es.exe | 加速 |
|---|---|---|---|
| `*.md` | 5.9 ms | 38.4 ms | **6.5x** |
| `package.json` | 12.8 ms | 50.6 ms | **3.9x** |
| `*.ts` | 6.0 ms | 38.8 ms | **6.5x** |
| 无匹配 | 13.0 ms | 48.1 ms | **3.7x** |

**真实加速约 4–6 倍。**

补充测量：
- 裸连接 **0.08 ms**
- 完整查询 **5.5–13 ms**，与返回条数**无关**（1 条、50 条、200 条均约 6ms）
- 即：开销在 **Everything 服务端处理**，不在传输

---

## 七、风险

1. **私有未公开协议**，Everything 任何版本都可能更改。
2. 必须保留 **es.exe 回落路径**。
3. 编码错误**不会报错**，只会静默返回空结果 —— 最危险的一点，测试必须钉住 varint。

---

## 八、复现

客户端实现：[`src/everything-ipc.ts`](../src/everything-ipc.ts)
测试：[`tests/everything-ipc.test.mjs`](../tests/everything-ipc.test.mjs)

REA 侧关键调用：

```
open_binary("C:\\Users\\BeiWay1145\\bin\\es.exe")
list_strings()                        → 管道名、错误消息
procedure_pseudo_code("0x140017960")  → 发送器（帧格式）
procedure_pseudo_code("0x140017e70")  → 接收器（状态码）
procedure_pseudo_code("0x140017ce0")  → varint 解码
procedure_pseudo_code("0x140018670")  → 响应解析
procedure_pseudo_code("0x14000f400")  → 搜索主逻辑（cmd=7）
```
