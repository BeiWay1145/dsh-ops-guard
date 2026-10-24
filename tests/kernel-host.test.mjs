/**
 * Guard: tests must run against the kernel the desktop app actually loads.
 *
 * This exists because they did not, for several sessions, and nothing noticed.
 * Every test carried its own copy of a resolver that scanned
 * a pnpm store under ~/.dsh (one directory level deep) and took the first
 * dsh-tools it found. On this machine that was dsh-android-fork@0.1.5-rc.1, while
 * DSH Desktop loads 0.2.1-rc.2 from its own resources/app. Both exist; only one runs.
 *
 * The cost was real: a listener registered on tools/ptc-dispatch-log passed 17
 * assertions against 0.1.5-rc.1 and did nothing in the running app, because the
 * two kernels reach that hook differently. It took a restart and a live
 * `sleep 21` producing silence to find.
 *
 * So this file asserts the RESOLUTION itself, not the feature:
 *
 *   - the resolved root must be the packaged app, when that app exists
 *   - the resolved root must be marked trusted
 *   - the version must match the app's own dsh-tools, not a stray fork
 *
 * If a future refactor reintroduces a pnpm scan ahead of the packaged app, this
 * fails immediately instead of silently testing the wrong build again.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findDshKernel, requireDshKernel } from './kernel-host.mjs'

let pass = 0, fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

const kernel = findDshKernel()

if (kernel === undefined) {
  console.log('  SKIP: no DSH kernel on this machine')
  console.log('')
  console.log('---- 0/0 passed (skipped) ----')
  process.exit(0)
}

console.log('kernel: ' + kernel.version + ' @ ' + kernel.root)
console.log('')

// --- the resolution itself -------------------------------------------------
check('a kernel was found', kernel !== undefined)
check('it is marked trusted', kernel.trusted === true)
check('the reason names the packaged app', kernel.reason === 'packaged desktop app')
check('the root looks like a packaged app', /resources[\\/]app[\\/]node_modules$/.test(kernel.root.replace(/\\/g, '/')) || kernel.root.includes('resources'))
check('a version was read', typeof kernel.version === 'string' && kernel.version.length > 0)

// --- it must not be the android fork ---------------------------------------
// That specific tree is what produced the false green; naming it keeps the
// regression legible rather than merely "some assertion failed".
check('it is NOT the dsh-android-fork tree', !kernel.root.includes('dsh-android-fork'))

// --- the version must equal what the app itself ships ----------------------
{
  const pkgPath = join(kernel.root, '@deepseek-ai', 'dsh-tools', 'package.json')
  const shipped = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8')).version
    : undefined
  check('the version matches the app\'s own dsh-tools', kernel.version === shipped)
}

// --- the packages a test imports must actually be here ---------------------
for (const pkg of ['cordis', 'dsh-tools']) {
  check('resolves @deepseek-ai/' + pkg, existsSync(join(kernel.root, '@deepseek-ai', pkg)))
}

// --- requireDshKernel returns the same thing -------------------------------
{
  const again = requireDshKernel()
  check('requireDshKernel agrees with findDshKernel', again.root === kernel.root)
}

// --- the hook this project needs must exist in this kernel ----------------
// A cheap canary: ptc-dispatch-log is what the PTC advisory listens on, and its
// absence in a kernel would mean the advisory cannot work there.
{
  const entry = join(kernel.root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  const source = existsSync(entry) ? readFileSync(entry, 'utf8') : ''
  check('this kernel exposes tools/ptc-dispatch-log', source.includes('tools/ptc-dispatch-log'))
  check('this kernel exposes tools/post-execute', source.includes('tools/post-execute'))
}

console.log('')
console.log('---- ' + pass + '/' + (pass + fail) + ' passed ----')
if (fail > 0) process.exitCode = 1
