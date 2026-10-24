/**
 * Latency: the guard answering a glob over IPC, against the two things it
 * replaced.
 *
 * Three paths are timed, and they are NOT interchangeable:
 *
 *   1. built-in glob (ripgrep) - what the model would have run
 *   2. es.exe                  - what the old refusal told the model to run
 *   3. guard + IPC             - what happens now: answered inside the
 *                                already-running DSH process, with the results
 *                                handed back in the denial
 *
 * The third is the only one that pays no process start, which is why it is the
 * only one that can beat es.exe rather than merely match it.
 *
 * WHAT IS NOT IN THE MILLISECOND COLUMNS: the model-side round trip. Running a
 * command costs the model a tool call; reading results out of a denial costs
 * none. That difference is real and in the guard favour, but it is a step count
 * rather than a duration, so it is stated rather than folded in.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { findDshKernel } from '../tests/kernel-host.mjs'
import { spawnSync } from 'node:child_process'

const REPS = Number(process.env.BENCH_REPS ?? 9)
const DIR = "D:/VibeCoding/project/dsh-plugin/dsh-ops-guard"
const ES = join(homedir(), 'bin', 'es.exe')
const RG = "D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
async function time(fn) { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6 }
function safeReaddir(x) { try { return readdirSync(x) } catch { return [] } }

// Shared kernel resolution; see tests/kernel-host.mjs.
const kernel = findDshKernel()
if (kernel === undefined) { console.log('SKIP: no DSH kernel found'); process.exit(0) }
if (kernel.trusted === false) console.log('WARN: untrusted kernel root (' + kernel.reason + ')')
console.log('kernel: ' + kernel.version + ' @ ' + kernel.root)
const load = (x) => import(pathToFileURL(join(kernel.root, '@deepseek-ai', x, 'lib', 'index.js')).href)
const { Context, Service } = await load('cordis')
const { ToolRuntime, defineTool } = await load('dsh-tools')

class FakePrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
  context() { return () => {} }
}

const ctx = new Context()
new FakePrompt(ctx)
const runtime = new ToolRuntime(ctx, { mode: 'native' })
runtime.register(defineTool({
  name: 'glob',
  description: 'fake glob',
  parameters: { pattern: { type: 'string', required: true, description: 'p' }, path: { type: 'string', description: 'r' } },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  async execute() { return { ok: true } },
}))

const guardUrl = pathToFileURL(join("D:/VibeCoding/project/dsh-plugin/dsh-ops-guard", 'lib', 'index.js')).href
const guard = await import(guardUrl)
guard.apply(ctx)

function runRg(pattern, root) {
  return spawnSync(RG, ['--files', '--glob=' + pattern, '--sort=modified', '--no-ignore', '--hidden',
    '--glob=!**/.git', '--glob=!**/.git/**', '--', root.replace(/\\/g, '/')], { encoding: 'utf8', maxBuffer: 1 << 28 })
}
// The pattern MUST go through the same translation the guard applies. Passing it
// raw measures the defect this project already found and fixed: es -path D
// "**/*.ts" walks the whole tree (1500 ms) where "*.ts" answers in 40 ms, and
// with a directory prefix it returns nothing at all. Benchmarking against the
// broken invocation would make the guard look far better than it is.
const { translateToEsPattern } = await import('../src/search.ts')
function runEs(pattern, root) {
  const tr = translateToEsPattern(pattern, root.replace(/\\/g, '/'))
  const argv = ['-n', '50']
  if (tr.root !== undefined && tr.root !== '') argv.push('-path', tr.root)
  argv.push(tr.pattern)
  return spawnSync(ES, argv, { encoding: 'utf8' })
}
async function runGuard(pattern, root) {
  return runtime.execute({
    name: 'glob',
    arguments: { pattern, path: root },
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root } } },
  })
}

const QUERIES = [
  { label: 'one project: **/*.md',       pattern: '**/*.md',   root: DIR },
  { label: 'one project: **/*.ts',       pattern: '**/*.ts',   root: DIR },
  { label: 'one project: **/*.json',     pattern: '**/*.json', root: DIR },
  { label: 'wide: D:/VibeCoding **/*.md', pattern: '**/*.md',  root: 'D:/VibeCoding' },
]

console.log('reps=' + REPS + '   dir=' + DIR)
console.log('')
console.log('query'.padEnd(38) + 'glob(rg)'.padStart(10) + 'es.exe'.padStart(10) + 'guard+IPC'.padStart(11) + 'vs rg'.padStart(9) + 'vs es'.padStart(8))
console.log('-'.repeat(86))

const rows = []
for (const q of QUERIES) {
  const rg = []
  const es = []
  const gd = []
  for (let i = 0; i < REPS; i++) rg.push(await time(() => runRg(q.pattern, q.root)))
  for (let i = 0; i < REPS; i++) es.push(await time(() => runEs(q.pattern, q.root)))
  for (let i = 0; i < REPS; i++) gd.push(await time(() => runGuard(q.pattern, q.root)))
  const a = median(rg)
  const b = median(es)
  const c = median(gd)
  rows.push({ label: q.label, rg: a, es: b, guard: c })
  console.log(q.label.padEnd(38) + (a.toFixed(1) + 'ms').padStart(10) + (b.toFixed(1) + 'ms').padStart(10)
    + (c.toFixed(1) + 'ms').padStart(11) + ((a / c).toFixed(2) + 'x').padStart(9) + ((b / c).toFixed(2) + 'x').padStart(8))
}

console.log('')
console.log('=== median across queries ===')
const mrg = median(rows.map((x) => x.rg))
const mes = median(rows.map((x) => x.es))
const mg = median(rows.map((x) => x.guard))
console.log('  built-in glob (rg) : ' + mrg.toFixed(1) + ' ms')
console.log('  es.exe             : ' + mes.toFixed(1) + ' ms')
console.log('  guard + IPC        : ' + mg.toFixed(1) + ' ms')
console.log('')
console.log('  vs the glob it replaces : ' + (mrg / mg).toFixed(1) + 'x faster')
console.log('  vs the es.exe it used to suggest : ' + (mes / mg).toFixed(1) + 'x faster')
