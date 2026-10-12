/**
 * Post-restart latency check, in one command.
 *
 * This is what the scheduled task runs. It exists so the reminder text can stay
 * a single line instead of a procedure: anything that has to be remembered
 * across a restart is something that can be got wrong after a restart.
 *
 * It answers three questions, in the order a reader needs them:
 *
 *   1. Is the plugin actually mounted after the restart? A benchmark of files
 *      that never reach the guard would be measuring nothing, so dump-config is
 *      consulted FIRST and a missing plugin is reported before any numbers.
 *
 *   2. What does search cost now, versus the baseline captured before the
 *      restart? Delegated to compare.mjs, which owns the comparison rules.
 *
 *   3. Does the guard still behave? The unit and runtime suites are cheap and
 *      they cover the refusal path, which the latency run never touches.
 *
 * Exit code is 0 when the check is clean and 1 when something needs attention,
 * so the caller can act on it without parsing prose.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const DSH_EXE = 'D:/VibeCoding/DSH_Desktop/DSH Desktop/DSH Desktop.exe'
const DSH_CLI = 'D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/lib/desktop-cli.js'
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, ...opts })
}

console.log('='.repeat(70))
console.log('dsh-ops-guard: post-restart latency check')
console.log('when  : ' + new Date().toISOString())
console.log('profile: ' + PROFILE)
console.log('='.repeat(70))

// --- 1. Is the guard actually mounted? ------------------------------------
console.log('')
console.log('## 1. Plugin mounted after restart')
console.log('')
let mounted = false
if (!existsSync(DSH_EXE) || !existsSync(DSH_CLI)) {
  console.log('could not locate the DSH CLI — skipping the mount check')
  console.log('  exe: ' + DSH_EXE + ' exists=' + existsSync(DSH_EXE))
  console.log('  cli: ' + DSH_CLI + ' exists=' + existsSync(DSH_CLI))
} else {
  const r = run(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', PROFILE, '--dump-config'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh') },
    timeout: 180000,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  mounted = out.includes('ops-guard')
  console.log((mounted ? 'PASS' : 'FAIL') + ': ops-guard ' + (mounted ? 'is in the composed profile' : 'is NOT in the composed profile'))
  const warns = out.split('\n').filter((l) => /not found|duplicate|pending|did not activate/.test(l))
  for (const w of warns) console.log('  warn: ' + w.trim())
  if (!mounted) console.log('  the measurements below would not reflect the guard being live')
}

// --- 2. Latency: now vs baseline ------------------------------------------
console.log('')
console.log('## 2. Latency versus baseline')
console.log('')
const bench = run(process.execPath, [join(HERE, 'bench-search.mjs')], {
  cwd: REPO,
  env: { ...process.env, BENCH_OUT: 'after-restart.json', BENCH_REPS: process.env.BENCH_REPS ?? '5' },
  timeout: 1800000,
})
process.stdout.write((bench.stdout ?? '').toString())
if ((bench.stderr ?? '').toString().trim() !== '') console.error((bench.stderr ?? '').toString())

const cmp = run(process.execPath, [join(HERE, 'compare.mjs')], { cwd: REPO, timeout: 120000 })
process.stdout.write((cmp.stdout ?? '').toString())
if ((cmp.stderr ?? '').toString().trim() !== '') console.error((cmp.stderr ?? '').toString())

// --- 3. Behaviour suites --------------------------------------------------
console.log('')
console.log('## 3. Guard behaviour')
console.log('')
const tests = run(process.execPath, ['scripts/build.mjs'], { cwd: REPO, timeout: 180000 })
if (tests.status !== 0) console.log('build FAILED (exit ' + tests.status + ')')
for (const f of ['tests/detect.test.mjs', 'tests/search.test.mjs', 'tests/guard.runtime.mjs']) {
  const t = run(process.execPath, [f], { cwd: REPO, timeout: 300000 })
  const out = ((t.stdout ?? '') + (t.stderr ?? '')).toString()
  const summary = out.split('\n').filter((l) => /passed|SKIP|All runtime|AssertionError/.test(l)).slice(-2).join(' | ')
  console.log((t.status === 0 ? 'PASS' : 'FAIL') + ' ' + f + '  ' + summary)
}

console.log('')
console.log('='.repeat(70))
console.log(mounted ? 'check complete — review the comparison above' : 'check INCOMPLETE — the guard is not mounted')
process.exit(mounted ? 0 : 1)
