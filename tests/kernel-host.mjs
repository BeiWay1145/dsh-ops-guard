/**
 * Resolve the DSH kernel that is ACTUALLY RUNNING, for tests and benchmarks.
 *
 * WHY THIS MODULE EXISTS
 *
 * Every test and both benchmarks used to carry their own copy of this logic, and
 * every copy had the same defect: it scanned `~/.dsh/<tree>/node_modules/.pnpm`
 * and returned the FIRST `@deepseek-ai/dsh-tools` it found. On this machine that
 * was `dsh-android-fork` at 0.1.5-rc.1 — an old fork the desktop app never loads.
 *
 * The consequence was the worst kind of green: assertions passed against a kernel
 * that was not running. A feature was reported working, deployed, restarted, and
 * silently did nothing, because the real kernel (0.2.1-rc.2) takes a different
 * code path through `tools/ptc-dispatch-log`.
 *
 * The order below is deliberate:
 *
 *   1. The packaged app's own node_modules — this is what DSH Desktop loads.
 *   2. An explicit DSH_KERNEL_ROOT override, to point a test at another build.
 *   3. A pnpm scan, as a last resort for a source checkout.
 *
 * Step 3 is what caused the bug, so it is now LAST, it never wins over a packaged
 * app, and its `reason` says plainly that it may not be the running build — so a
 * caller can print it and notice.
 *
 * @module dsh-ops-guard/test-host
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * A resolved kernel root plus how it was chosen.
 *
 * @typedef {object} DshKernel
 * @property {string} root Directory to resolve `@deepseek-ai/<pkg>` from.
 * @property {string} reason Why this root was chosen; a caller should print it.
 * @property {string} [version] Version from dsh-tools' package.json.
 * @property {boolean} trusted False when this may not be the loaded build.
 */

function safeReaddir(path) {
  try { return readdirSync(path) } catch { return [] }
}

function hasKernel(root) {
  try {
    return statSync(join(root, '@deepseek-ai', 'dsh-tools')).isDirectory()
  } catch {
    return false
  }
}

function versionOf(root) {
  try {
    const raw = readFileSync(join(root, '@deepseek-ai', 'dsh-tools', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the running kernel.
 *
 * @param env - environment to read; defaults to process.env.
 * @returns the kernel, or undefined when none exists.
 */
export function findDshKernel(env = process.env) {
  // 1) The packaged desktop app. This is the only root guaranteed to be the build
  //    the running application loaded.
  const packaged = []
  if (typeof env.DSH_DESKTOP_ROOT === 'string' && env.DSH_DESKTOP_ROOT !== '') {
    packaged.push(join(env.DSH_DESKTOP_ROOT, 'resources', 'app', 'node_modules'))
  }
  packaged.push('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules')
  for (const root of packaged) {
    if (hasKernel(root)) {
      return { root, reason: 'packaged desktop app', version: versionOf(root), trusted: true }
    }
  }

  // 2) Explicit override.
  const override = env.DSH_KERNEL_ROOT
  if (typeof override === 'string' && override !== '' && hasKernel(override)) {
    return { root: override, reason: 'DSH_KERNEL_ROOT override', version: versionOf(override), trusted: true }
  }

  // 3) Last resort: a pnpm store under DSH_HOME. This is the path that caused the
  //    false-green, so it is tried last and marked untrusted.
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const tree of safeReaddir(home)) {
    const pnpm = join(home, tree, 'node_modules', '.pnpm')
    for (const dir of safeReaddir(pnpm)) {
      if (!dir.startsWith('@deepseek-ai+dsh-tools@')) continue
      const root = join(pnpm, dir, 'node_modules')
      if (hasKernel(root)) {
        return {
          root,
          reason: 'pnpm store under DSH_HOME — NOT necessarily the build the app loaded',
          version: versionOf(root),
          trusted: false,
        }
      }
    }
  }
  return undefined
}

/**
 * Same as {@link findDshKernel} but throws when nothing is found.
 *
 * @param env - environment to read; defaults to process.env.
 * @returns the kernel.
 */
export function requireDshKernel(env = process.env) {
  const kernel = findDshKernel(env)
  if (kernel === undefined) {
    throw new Error(
      'no DSH kernel found: expected the packaged app at '
      + 'DSH_DESKTOP_ROOT/resources/app/node_modules, or a pnpm store under DSH_HOME. '
      + 'Set DSH_KERNEL_ROOT to point at a specific build.',
    )
  }
  return kernel
}
