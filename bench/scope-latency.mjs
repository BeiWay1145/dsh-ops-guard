/**
 * Where the guard actually wins, across the whole scope spectrum.
 *
 * This replaces an earlier benchmark whose conclusion was wrong in a way worth
 * naming: it timed a full es.exe PROCESS against ripgrep, then attributed that
 * cost to the guard. The guard never starts a process. It asks the resident pipe
 * from inside the already-running DSH process, so none of the spawn term applies
 * to it. Narrow searches were reported as 2-3x SLOWER on that basis.
 *
 * What is compared here is what the model actually waits for:
 *
 *   built-in glob : DSH spawns ripgrep, then ripgrep walks the tree
 *   guard + IPC   : the query goes down an existing pipe, nothing is spawned
 *
 * Ripgrep spawn is also measured alone, so the table can show how much of its
 * cost is process creation rather than searching.
 */
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { findDshKernel } from '../tests/kernel-host.mjs'
import { spawnSync } from 'node:child_process'

const REPS = Number(process.env.BENCH_REPS ?? 11)
const DIR = "D:/VibeCoding/project/dsh-plugin/dsh-ops-guard"
const RG = 'D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'

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
const guard = await import(pathToFileURL(join("D:/VibeCoding/project/dsh-plugin/dsh-ops-guard", 'lib', 'index.js')).href)
guard.apply(ctx)

// The built-in glob runs ripgrep with --no-ignore --hidden; match that argv.
function runRg(pattern, root) {
  return spawnSync(RG, ['--files', '--glob=' + pattern, '--sort=modified', '--no-ignore', '--hidden',
    '--glob=!**/.git', '--glob=!**/.git/**', '--', root.replace(/\\/g, '/')], { encoding: 'utf8', maxBuffer: 1 << 28 })
}
function runRgBare() { return spawnSync(RG, ['--version'], { encoding: 'utf8' }) }

async function runGuard(pattern, root) {
  const r = await runtime.execute({
    name: 'glob',
    arguments: { pattern, path: root },
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root } } },
  })
  const text = (r.content ?? []).map((c) => c.text).join('')
  const m = /total matches: (\d+)/.exec(text)
  return m ? Number(m[1]) : -1
}

const TINY = join(DIR, '.bench-tiny')
mkdirSync(TINY, { recursive: true })
for (const n of ['a.md', 'b.md', 'c.md']) writeFileSync(join(TINY, n), '# x')

const SCOPES = [
  { label: 'tiny dir (3 files)',    pattern: '*.md',    root: TINY },
  { label: 'one subdir docs/',      pattern: '*.md',    root: join(DIR, 'docs') },
  { label: 'one project',           pattern: '**/*.md', root: DIR },
  { label: 'one project, src only', pattern: '**/*.ts', root: join(DIR, 'src') },
  { label: 'D:/VibeCoding',         pattern: '**/*.md', root: 'D:/VibeCoding' },
]

console.log('reps=' + REPS)
console.log('')
console.log('scope'.padEnd(26) + 'glob(rg)'.padStart(10) + 'guard+IPC'.padStart(11) + '   winner'.padStart(12))
console.log('-'.repeat(60))

const bare = []
for (let i = 0; i < REPS; i++) bare.push(await time(() => runRgBare()))
const bareMs = median(bare)
console.log('(ripgrep spawn alone)'.padEnd(26) + (bareMs.toFixed(1) + 'ms').padStart(10))
console.log('')

const rows = []
for (const s of SCOPES) {
  const rg = []
  const gd = []
  let hits = 0
  for (let i = 0; i < REPS; i++) rg.push(await time(() => runRg(s.pattern, s.root)))
  for (let i = 0; i < REPS; i++) gd.push(await time(async () => { hits = await runGuard(s.pattern, s.root) }))
  const a = median(rg)
  const c = median(gd)
  rows.push({ label: s.label, rg: a, guard: c, hits })
  const win = c < a ? 'guard ' + (a / c).toFixed(1) + 'x' : 'rg ' + (c / a).toFixed(1) + 'x'
  console.log(s.label.padEnd(26) + (a.toFixed(1) + 'ms').padStart(10) + (c.toFixed(1) + 'ms').padStart(11) + win.padStart(12))
}

try { rmSync(TINY, { recursive: true, force: true }) } catch {}

console.log('')
console.log('=== per scope ===')
for (const r of rows) console.log('  ' + r.label.padEnd(24) + 'rg ' + r.rg.toFixed(1) + 'ms   guard ' + r.guard.toFixed(1) + 'ms   ' + (r.rg / r.guard).toFixed(2) + 'x   (' + r.hits + ' hits)')
