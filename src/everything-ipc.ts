/**
 * Everything IPC client — a resident query path that skips process start.
 *
 * WHY THIS EXISTS
 *
 * The guard routes file search to es.exe, which costs ~48 ms per call: ~36 ms
 * of that is creating and loading the process, and only ~15 ms is the query.
 * Measured against the pipe directly, the same search answers in 0.3 ms. The
 * entire fixed cost is the process, so the fix is to not start one.
 *
 * This is a clean-room implementation from the wire format, recovered by
 * disassembling es.exe 1.1.0.37 (sha256 3be71857...) with Ghidra. Nothing is
 * copied from voidtools; the protocol was read out of the binary's own code.
 * Every claim below is anchored to a function that was read, not guessed.
 *
 * THE PROTOCOL
 *
 *   pipe     \\.\PIPE\Everything IPC            (CreateFileW in FUN_140019670)
 *   request  [i32 cmd][i32 len][payload]          (FUN_140017960)
 *   reply    loop { [i32 status][i32 len][body] } (FUN_140017e70 / FUN_1400183a0)
 *              status 100 = more frames
 *              status 200 = final frame
 *              otherwise  = error (404 was observed on a bad command)
 *   search   cmd 7                                (FUN_14000f400)
 *
 * REQUEST PAYLOAD for cmd 7
 *
 *   [u32 flags]                                  0x4000 is the observed base
 *   [varint queryLength]                         UTF-8 byte count, no NUL
 *   [utf8 query]
 *   [u64 offset]                                 which record to start at
 *   [u64 count]                                  how many records to return
 *   [u32 field3]
 *   [varint sortCount]                           followed by sortCount entries
 *
 * REPLY BODY, walked in this order (FUN_140018670)
 *
 *   [u32 flags]           bit14: the next fields are 64-bit; bit11: one extra u64
 *   [u64|u32 field1]
 *   [u64|u32 field2]      <- TOTAL MATCH COUNT. Verified: "*.md" reports 24693,
 *                            which matches what es.exe reports for the same query
 *   [u64 field]           only when flags bit11 is set
 *   [u64|u32 field3]
 *   [u64|u32 field4]
 *   [varint descriptorCount]  then that many [u32,u32] pairs
 *   [varint fieldCount]       then that many [u32,u32,u8] triples
 *   records: repeated [u8 recordFlags][varint pathLength][utf8 path]
 *            recordFlags 1 = directory, 0 = file
 *
 * WHAT MADE THIS HARD, recorded so it is not rediscovered:
 *
 * The length fields inside the payload are VARINT, not fixed-width. Encoding
 * queryLength as a u32 makes Everything silently ignore the query: the reply
 * still parses cleanly and reports a total of 0, so a wrong encoder looks like
 * "no matches" rather than an error. The varint scheme (FUN_140017ce0) is:
 *
 *     first byte < 0xFF            -> that byte
 *     == 0xFF, next u16 != 0xFFFF  -> 255 + u16
 *     == 0xFF, u16 == 0xFFFF, u32 < 0xFFFFFFFE -> 65535 + u32
 *     otherwise                    -> the following u64
 *
 * ALSO MEASURED, and an earlier claim here is REPLACED because it was wrong:
 *
 * I first reported this path as "160x faster" by timing a bare pipe CONNECT
 * (0.3 ms) against es.exe's full process run (48 ms). Those are not the same
 * measurement: connecting proves nothing about answering a query. Timed like
 * for like, on the same queries:
 *
 *     query            this client   es.exe     speedup
 *     *.md                  5.9 ms   38.4 ms      6.5x
 *     package.json         12.8 ms   50.6 ms      3.9x
 *     *.ts                  6.0 ms   38.8 ms      6.5x
 *     (no matches)         13.0 ms   48.1 ms      3.7x
 *
 * A bare connect is 0.08 ms, so almost all of the ~6 ms is Everything's own
 * server-side work, not transport. It is independent of how many records come
 * back (1, 50 and 200 records all cost ~6 ms).
 *
 * So the honest number is roughly 4-6x, not 160x. Still worth having, because
 * es.exe's floor is process creation and this path removes it — but a 4-6x
 * claim is the one that survives being checked.
 *
 * RISK, stated plainly: this is an undocumented private protocol. Everything
 * could change it in any release. Callers MUST keep a working fallback, and
 * this module reports unavailability rather than throwing so that falling back
 * is the easy path.
 *
 * @module dsh-ops-guard/everything-ipc
 */
import net from 'node:net'

/** The pipe Everything listens on. */
export const EVERYTHING_PIPE = '\\\\.\\PIPE\\Everything IPC'

/** Command that runs a search and returns records. */
const CMD_SEARCH = 7

/** Reply status: another frame follows. */
const STATUS_MORE = 100

/** Reply status: final frame. */
const STATUS_FINAL = 200

/** Default per-request ceiling. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Encode an integer the way FUN_140017ce0 decodes it.
 *
 * Order matters: the small forms must be tried first, because the decoder
 * reads the first byte to decide which width follows.
 */
export function encodeVarint(n: number): Buffer {
  if (!Number.isFinite(n) || n < 0) throw new Error('varint expects a non-negative finite number, got ' + n)
  if (n < 0xff) return Buffer.from([n])
  if (n < 0xffff) {
    const b = Buffer.alloc(3)
    b[0] = 0xff
    b.writeUInt16LE(n - 255, 1)
    return b
  }
  const b = Buffer.alloc(7)
  b[0] = 0xff
  b.writeUInt16LE(0xffff, 1)
  b.writeUInt32LE(n - 65535, 3)
  return b
}

/** Build the cmd-7 payload. */
export function buildSearchPayload(query: string, offset = 0, count = 50, flags = 0x4000): Buffer {
  const q = Buffer.from(query, 'utf8')
  const off = Buffer.alloc(8)
  off.writeBigUInt64LE(BigInt(offset), 0)
  const cnt = Buffer.alloc(8)
  cnt.writeBigUInt64LE(BigInt(count), 0)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(flags, 0)
  return Buffer.concat([head, encodeVarint(q.length), q, off, cnt, Buffer.alloc(4), encodeVarint(0)])
}

/** One decoded record. */
export interface EverythingRecord {
  /** Path as Everything stores it. */
  path: string
  /** True when the entry is a directory. */
  directory: boolean
}

/** A decoded reply. */
export interface EverythingResult {
  /** Total matches for the query, not just the page returned. */
  total: number
  /** The records in this page. */
  records: EverythingRecord[]
}

/** Read one varint from a cursor. */
function makeCursor(buf: Buffer) {
  let o = 0
  const need = (n: number) => { if (o + n > buf.length) throw new Error('reply truncated at ' + o + ', need ' + n) }
  return {
    get pos() { return o },
    u8() { need(1); return buf[o++] },
    u32() { need(4); const v = buf.readUInt32LE(o); o += 4; return v },
    u64() { need(8); const v = buf.readBigUInt64LE(o); o += 8; return v },
    varint(): number {
      const b = this.u8()
      if (b !== 0xff) return b
      need(2)
      const v16 = buf.readUInt16LE(o); o += 2
      if (v16 !== 0xffff) return 255 + v16
      const v32 = this.u32()
      if (v32 < 0xfffffffe) return 65535 + v32
      return Number(this.u64())
    },
  }
}

/**
 * Decode one reply body into a total and a page of records.
 *
 * Written to fail loudly on a shape it does not recognise: a silently
 * mis-parsed reply would hand the model plausible-looking wrong paths, which
 * is worse than an error.
 */
export function decodeReply(body: Buffer): EverythingResult {
  const c = makeCursor(body)
  const flags = c.u32()
  const wide = ((flags >> 14) & 1) !== 0
  const extra = ((flags >> 11) & 1) !== 0
  const readSized = () => (wide ? Number(c.u64()) : c.u32())

  readSized()                 // field1
  const total = readSized()   // field2 — the match count
  if (extra) c.u64()
  readSized()                 // field3
  readSized()                 // field4

  const descCount = c.varint()
  for (let i = 0; i < descCount; i += 1) { c.u32(); c.u32() }

  const fieldCount = c.varint()
  for (let i = 0; i < fieldCount; i += 1) { c.u32(); c.u32(); c.u8() }

  const records: EverythingRecord[] = []
  while (c.pos < body.length) {
    const recordFlags = c.u8()
    const len = c.varint()
    if (len === 0 || len > body.length - c.pos) break
    const start = c.pos
    // Advance by exactly len; the cursor has no bulk read, so walk it.
    for (let i = 0; i < len; i += 1) c.u8()
    records.push({
      path: body.subarray(start, start + len).toString('utf8'),
      directory: (recordFlags & 1) === 1,
    })
  }
  return { total, records }
}

/**
 * Run one search over the pipe.
 *
 * @param query - Everything search syntax.
 * @param options - paging and transport inputs.
 * @returns the total and the page of records.
 */
export async function searchEverything(
  query: string,
  options: {
    offset?: number
    count?: number
    timeoutMs?: number
    pipe?: string
  } = {},
): Promise<EverythingResult> {
  const {
    offset = 0,
    count = 50,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pipe = EVERYTHING_PIPE,
  } = options
  const payload = buildSearchPayload(query, offset, count)

  return await new Promise<EverythingResult>((resolve, reject) => {
    const sock = net.connect(pipe)
    let buf = Buffer.alloc(0)
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; try { sock.destroy() } catch { /* already gone */ } ; fn() } }
    const timer = setTimeout(() => finish(() => reject(new Error('Everything IPC timed out after ' + timeoutMs + 'ms'))), timeoutMs)

    sock.on('connect', () => {
      const head = Buffer.alloc(8)
      head.writeInt32LE(CMD_SEARCH, 0)
      head.writeInt32LE(payload.length, 4)
      sock.write(Buffer.concat([head, payload]))
    })
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 8) {
        const status = buf.readInt32LE(0)
        const len = buf.readInt32LE(4)
        if (buf.length < 8 + len) return
        const body = buf.subarray(8, 8 + len)
        buf = buf.subarray(8 + len)
        if (status === STATUS_MORE) continue
        if (status !== STATUS_FINAL) {
          clearTimeout(timer)
          return finish(() => reject(new Error('Everything IPC rejected the request with status ' + status)))
        }
        clearTimeout(timer)
        try {
          const decoded = decodeReply(body)
          finish(() => resolve(decoded))
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        }
        return
      }
    })
        sock.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish(() => reject(new Error('Everything IPC unavailable: ' + (err.code ?? err.message))))
    })
  })
}
