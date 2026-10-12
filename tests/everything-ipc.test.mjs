/**
 * Everything IPC client tests.
 *
 * The encoder tests exist because a wrong varint does not fail loudly: encoding
 * queryLength as a fixed-width u32 makes Everything ignore the query and report
 * a total of 0, which reads as "no matches" rather than "malformed request".
 * That is exactly how the first version of this client behaved.
 */
import assert from 'node:assert/strict'
import { encodeVarint, buildSearchPayload, decodeReply, searchEverything } from '../src/everything-ipc.ts'

let passed = 0
let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed++; console.log('  PASS ' + name) }
  else { failed++; console.log('  FAIL ' + name + '\n       expected ' + JSON.stringify(expected) + '\n       actual   ' + JSON.stringify(actual)) }
}

// --- varint (mirrors FUN_140017ce0's decoder) ------------------------------
check('varint 0 is one byte', encodeVarint(0).toString('hex'), '00')
check('varint 254 is one byte', encodeVarint(254).toString('hex'), 'fe')
check('varint 255 switches to the 3-byte form', encodeVarint(255).toString('hex'), 'ff0000')
check('varint 255 encodes 0 as the offset', encodeVarint(255).readUInt16LE(1), 0)
check('varint 256 carries the offset', encodeVarint(256).readUInt16LE(1), 1)
check('varint 65534 stays 3 bytes', encodeVarint(65534).toString('hex'), 'fffffe')
check('varint 65535 switches to 7 bytes', encodeVarint(65535).length, 7)
check('varint 65535 has the 0xffff marker', encodeVarint(65535).readUInt16LE(1), 0xffff)
check('varint rejects a negative', (() => { try { encodeVarint(-1); return 'no-throw' } catch { return 'threw' } })(), 'threw')

// --- payload shape ---------------------------------------------------------
const p = buildSearchPayload('*.md', 0, 5)
check('payload starts with the flags', p.readUInt32LE(0), 0x4000)
check('payload uses a VARINT length, not a u32', p[4], 4)
check('payload carries the query next', p.subarray(5, 9).toString('utf8'), '*.md')
// The bug this pins: a u32 length would make Everything see a bogus query and
// answer with a total of 0 while still returning a well-formed reply.
check('payload does NOT write a u32 length field', p.readUInt32LE(4) !== 4 || p[8] === 0x6f, true)

// --- reply decoding --------------------------------------------------------
// A hand-built body matching the layout FUN_140018670 walks.
function body(total, paths) {
  const head = Buffer.alloc(36)
  head.writeUInt32LE(0x4000, 0)          // flags, wide
  head.writeBigUInt64LE(2n, 4)           // field1
  head.writeBigUInt64LE(BigInt(total), 12) // field2 = total
  head.writeBigUInt64LE(0n, 20)          // field3
  head.writeBigUInt64LE(0n, 28)          // field4
  const parts = [head, Buffer.from([1]), Buffer.alloc(8), Buffer.from([1]), Buffer.from([240, 0, 0, 0, 0, 0, 0, 0, 15])]
  for (const { path: pp, directory } of paths) {
    const pb = Buffer.from(pp, 'utf8')
    parts.push(Buffer.from([directory ? 1 : 0]), encodeVarint(pb.length), pb)
  }
  return Buffer.concat(parts)
}

const d = decodeReply(body(1234, [{ path: 'C:\\a\\b.md', directory: false }, { path: 'C:\\dir', directory: true }]))
check('decodes the total', d.total, 1234)
check('decodes both records', d.records.length, 2)
check('decodes a file path', d.records[0].path, 'C:\\a\\b.md')
check('flags 0 means file', d.records[0].directory, false)
check('flags 1 means directory', d.records[1].directory, true)
check('a truncated body throws rather than inventing records', (() => {
  try { decodeReply(Buffer.alloc(10)); return 'no-throw' } catch { return 'threw' }
})(), 'threw')

// --- live pipe (only when Everything is running) ---------------------------
try {
  const live = await searchEverything('package.json', { count: 3, timeoutMs: 3000 })
  check('live: reports a plausibly large total', live.total > 100, true)
  check('live: returns the requested page size', live.records.length, 3)
  // Naive on purpose: an over-escaped regex here previously produced a false
  // failure and hid whether the decoder was actually right.
  // Takes a PATH, not a record: the earlier version passed the record objects
  // straight to every(), whose callback then read .length off an object and
  // returned false for every element. The predicate was right; the call site
  // was wrong, which is why it failed while manual iteration said true.
  const isAbsolute = (s) =>
    typeof s === 'string' &&
    s.length > 3 &&
    s.charCodeAt(1) === 58 &&
    (s.charCodeAt(2) === 92 || s.charCodeAt(2) === 47)
  check('live: every record is an absolute path', live.records.every((r) => isAbsolute(r.path)), true)

} catch (error) {
  console.log('  SKIP live pipe tests (' + (error instanceof Error ? error.message : String(error)) + ')')
}

console.log('')
console.log('---- ' + passed + '/' + (passed + failed) + ' passed ----')
if (failed > 0) process.exitCode = 1
