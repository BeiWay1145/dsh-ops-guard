/**
 * E2E: the sleep advisory fires once, never blocks, and never fails a call.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

function safeReaddir(p) { try { return readdirSync(p) } catch { return [] } }
function findHost() {
  const out = []
  const dh = join(homedir(), '.dsh')
  for (const e of safeReaddir(dh)) {
    for (const d of safeReaddir(join(dh, e, 'node_modules', '.pnpm'))) {
      if (!d.startsWith('@deepseek-ai+dsh-tools@')) continue
      const nm = join(dh, e, 'node_modules', '.pnpm', d, 'node_modules')
      if (existsSync(join(nm, '@deepseek-ai', 'dsh-tools'))) out.push(nm)
    }
  }
  return out
}
const hosts = findHost()
if (!hosts.length) { console.log('SKIP: no DSH tree'); process.exit(0) }
const load = (x) => import(pathToFileURL(join(hosts[0], '@deepseek-ai', x, 'lib', 'index.js')).href)
const { Context, Service } = await load('cordis')
const { ToolRuntime, defineTool } = await load('dsh-tools')

class FakePrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
  context() { return () => {} }
}

let ran = []
const mkShell = (name) => defineTool({
  name, description: 'fake shell',
  parameters: { command: { type: 'string', description: 'c' } },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  async execute(a) { ran.push(name + ':' + a.command); return { ok: true } },
})

const ctx = new Context()
new FakePrompt(ctx)
const runtime = new ToolRuntime(ctx, { mode: 'native' })
runtime.register(mkShell('pwsh'))
runtime.register(mkShell('bash'))
runtime.register(mkShell('read'))

const guard = await import(pathToFileURL(join("D:/VibeCoding/project/dsh-plugin/dsh-ops-guard", 'lib', 'index.js')).href)
guard.apply(ctx)

const SESSION = { id: 's1', header: { cwd: 'D:/x' } }
async function call(name, command, session = SESSION) {
  ran = []
  const r = await runtime.execute({
    name, arguments: { command }, signal: new AbortController().signal,
    agent: { session },
  })
  return { text: (r.content ?? []).map((c) => c.text).join('\n'), isError: r.isError === true, ran: [...ran] }
}

let pass = 0, fail = 0
const check = (n, ok) => { if (ok) { pass++; console.log('  PASS ' + n) } else { fail++; console.log('  FAIL ' + n) } }

// 1. 长 sleep 得到提示
const a = await call('pwsh', 'sleep 60')
check('advisory appears on a long sleep', a.text.includes('dsh-ops-guard'))
check('advisory names job_output', a.text.includes('job_output'))
check('the command STILL RAN (no block)', a.ran.length === 1)
check('the call is not an error', a.isError === false)
check('original output is preserved', a.text.includes('ok'))

// 2. 同一会话第二次不再提示
const b = await call('pwsh', 'sleep 90')
check('advisory fires only once per session', !b.text.includes('dsh-ops-guard'))
check('second call still ran', b.ran.length === 1)

// 3. 另一个会话仍有自己的那一次
const c = await call('bash', 'sleep 45', { id: 's2', header: { cwd: 'D:/y' } })
check('a different session gets its own advisory', c.text.includes('dsh-ops-guard'))

// 4. 短 sleep 不提示
const d = await call('pwsh', 'sleep 3', { id: 's3' })
check('short sleeps are ignored', !d.text.includes('dsh-ops-guard'))

// 5. 非 shell 工具不受影响
const e = await call('read', 'sleep 600', { id: 's4' })
check('non-shell tools are untouched', !e.text.includes('dsh-ops-guard'))

// 6. 循环里的 sleep 不提示
const f = await call('pwsh', 'for i in 1..20; do sleep 50; done', { id: 's5' })
check('a sleep inside a loop is not advised', !f.text.includes('dsh-ops-guard'))

// 7. 普通命令无提示
const g = await call('pwsh', 'ls -la', { id: 's6' })
check('ordinary commands are silent', !g.text.includes('dsh-ops-guard'))

console.log('')

// --- PTC sub-dispatches ----------------------------------------------------
//
// In PTC mode the model calls ONE tool (run_code) and every bash inside it is a
// sub-dispatch that never reaches tools/post-execute. Found in a LIVE session
// whose preset was still ptc: a real `sleep 21` produced no advisory, because
// the listener above guards only the outer call.
//
// PTC counterpart is tools/ptc-dispatch-log. Both share one once-per-session
// flag, so switching preset mid-session does not repeat the lecture.
{
  // Reuse the SAME context the plugin was applied to above. In production apply()
  // runs once, so both listeners share one "already advised" flag; a second
  // apply() would create a second set and the once-per-session test below would
  // fail for a reason that cannot happen in a real session.
  const ctxPtc = ctx
  const S = { id: "ptc-session" }
  const mkDispatch = (cmd) => ({
    name: "bash",
    exec: { arguments: { command: cmd } },
    agent: { session: S },
    content: [{ type: "text", text: "OUTPUT" }],
  })
  const run = (cmd) => ctxPtc.waterfall("tools/ptc-dispatch-log", mkDispatch(cmd), (d) => Promise.resolve(d.content))

  const one = await run("sleep 60")
  const oneText = (one ?? []).map((c) => c.text ?? "").join("\n")
  check("ptc: advisory appears", oneText.includes("dsh-ops-guard") === true)
  check("ptc: original content preserved", oneText.includes("OUTPUT") === true)

  const two = await run("sleep 90")
  const twoText = (two ?? []).map((c) => c.text ?? "").join("\n")
  check("ptc: fires once per session", twoText.includes("dsh-ops-guard") === false)

  const short = await run("sleep 3")
  const shortText = (short ?? []).map((c) => c.text ?? "").join("\n")
  check("ptc: short sleeps ignored", shortText.includes("dsh-ops-guard") === false)

  const loop = await run("for i in 1..9; do sleep 50; done")
  const loopText = (loop ?? []).map((c) => c.text ?? "").join("\n")
  check("ptc: loop sleeps ignored", loopText.includes("dsh-ops-guard") === false)
}

console.log(pass + '/' + (pass + fail) + ' passed')
if (fail > 0) process.exitCode = 1
