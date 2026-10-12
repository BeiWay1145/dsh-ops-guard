/**
 * End-to-end: a denied glob must come back carrying real RESULTS.
 *
 * The unit tests prove the protocol; this proves the guard spends it. If this
 * regresses to a bare command suggestion, the guard is back to costing the model
 * a round trip and a process start, which is the entire thing it exists to avoid.
 *
 * Driven through a real cordis Context and the real ToolRuntime, with the same
 * dispatch shape guard.runtime.mjs uses, because that is what the scheduler
 * accepts — a hand-rolled exec object is silently not routed through the gate.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

function safeReaddir(p) { try { return readdirSync(p) } catch { return [] } }

function findHostModules() {
  const candidates = []
  const dshHome = join(homedir(), '.dsh')
  const stores = []
  for (const entry of safeReaddir(dshHome)) {
    const pnpm = join(dshHome, entry, 'node_modules', '.pnpm')
    if (existsSync(pnpm)) stores.push(pnpm)
  }
  for (const store of stores) {
    for (const dir of safeReaddir(store)) {
      if (!dir.startsWith('@deepseek-ai+dsh-tools@')) continue
      const nm = join(store, dir, 'node_modules')
      if (existsSync(join(nm, '@deepseek-ai', 'dsh-tools'))) candidates.push(nm)
    }
  }
  return candidates
}

const hosts = findHostModules()
if (hosts.length === 0) {
  console.log('SKIP ipc guard e2e: no installed DSH tree with dsh-tools found.')
  process.exit(0)
}
const load = (pkg) => import(pathToFileURL(join(hosts[0], '@deepseek-ai', pkg, 'lib', 'index.js')).href)
const { Context, Service } = await load('cordis')
const { ToolRuntime, defineTool } = await load('dsh-tools')

class FakeSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools(_cb) { return () => {} }
  context(_cb) { return () => {} }
}

let globRan = false
const globTool = defineTool({
  name: 'glob',
  description: 'fake glob',
  parameters: {
    pattern: { type: 'string', required: true, description: 'glob pattern' },
    path: { type: 'string', description: 'root' },
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  },
  async execute() { globRan = true; return { ok: true } },
})

const ctx = new Context()
new FakeSystemPrompt(ctx)
const runtime = new ToolRuntime(ctx, { mode: 'native' })
runtime.register(globTool)

const guardUrl = pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\//, '')).href
const guard = await import(guardUrl)
assert.equal(typeof guard.apply, 'function', 'plugin exports apply')
guard.apply(ctx)

const WORKDIR = "D:/VibeCoding/project/dsh-plugin/dsh-ops-guard"
const signal = new AbortController().signal
// The session cwd is what the guard scopes the query to; without it the search
// would answer from the whole disk.
const agent = { session: { header: { cwd: WORKDIR } } }
const result = await runtime.execute({
  name: 'glob',
  arguments: { pattern: '**/*.md', path: WORKDIR },
  signal,
  agent,
})

const text = (result.content ?? []).map((c) => c.text).join('\n')
assert.equal(globRan, false, 'the glob tool body never ran')
assert.equal(result.isError, true, 'the call is reported as an error')
assert.ok(text.includes('dsh-ops-guard'), 'the denial names the guard')
assert.ok(text.includes('total matches:'), 'the denial carries RESULTS, not just a command')
assert.ok(text.includes('.md'), 'real file paths are present')
assert.ok(/in [0-9.]+ ms/.test(text), 'it reports how long the query took')
assert.ok(text.includes('grep tool is NOT affected'), 'grep is still declared untouched')
console.log('PASS the guard answered the query itself')

console.log('')
console.log('--- denial text ---')
console.log(text.split('\n').slice(0, 14).join('\n'))
