/**
 * Search latency benchmark: built-in glob (ripgrep) vs Everything (es.exe).
 *
 * This measures the premise of the search guard. The guard refuses the built-in
 * glob tool and redirects the model to es.exe, which is only justified if
 * es.exe is actually faster — so the claim gets a number instead of a story.
 *
 * Fairness rules, and why each one is here:
 *
 * 1. The ripgrep argv is the kernel's OWN, copied from buildGlobCommand in
 *    dsh-tool-fs-search — not a hand-rolled approximation. Comparing against a
 *    command nobody runs would measure nothing.
 *
 * 2. Both sides spawn a real process per repetition. That spawn cost is part of
 *    what an agent actually pays, so it is included rather than subtracted.
 *
 * 3. es.exe talks to Everything over IPC, so the first call after Everything
 *    starts pays a connect cost. Repetitions are preceded by warm-up calls that
 *    are not measured.
 *
 * 4. es.exe is capped with -n so it stops producing output at roughly the depth
 *    ripgrep's 100-path cap would; otherwise the comparison would just measure
 *    "one produced more output".
 *
 * 5. Result counts are reported for both. A latency win that also loses matches
 *    is not a win, and the report must make that visible rather than hide it
 *    behind a single "faster" number.
 */
import { spawnSync } from 'node:child_process'
import { translateToEsPattern } from '../src/search.ts'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The ripgrep binary the kernel bundles. */
const RG = 'D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'

/** es.exe, resolved the same way the guard resolves it. */
function findEs() {
  const cands = [
    join(homedir(), 'bin', 'es.exe'),
    'C:/Program Files/Everything/es.exe',
    'D:/Everything/es.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  return undefined
}
const ES = findEs()

/** VCS metadata the kernel keeps out of every glob result. */
const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** Repetitions per query, per engine. Odd, so the median is a real sample. */
const REPS = Number(process.env.BENCH_REPS ?? 9)

/**
 * The query set.
 *
 * Chosen to span the shapes an agent actually asks for: a broad extension
 * sweep across a whole drive subtree, narrow in-project patterns, and one query
 * whose answer is large enough that OUTPUT volume, not scan time, could decide
 * the winner. A benchmark that only measures one shape would let the guard's
 * premise look true or false by construction.
 */
const QUERIES = [
  { label: 'narrow: src/*.ts in one project', root: 'D:/VibeCoding/project/dsh-plugin/dsh-ops-guard/src', pattern: '**/*.ts' },
  { label: 'project-wide: **/*.ts', root: 'D:/VibeCoding/project/dsh-plugin/dsh-ops-guard', pattern: '**/*.ts' },
  { label: 'project-wide: **/*.json', root: 'D:/VibeCoding/project/dsh-plugin/dsh-ops-guard', pattern: '**/*.json' },
  { label: 'drive-wide: */**/*.mjs under projects', root: 'D:/VibeCoding/project', pattern: '**/*.mjs' },
  { label: 'drive-wide: **/*.log under projects', root: 'D:/VibeCoding/project', pattern: '**/*.log' },
  { label: 'big: **/*.dll under projects', root: 'D:/VibeCoding/project', pattern: '**/*.dll' },
]

/** Build the kernel's exact ripgrep argv for one glob call. */
function rgArgv(q) {
  return [
    '--files',
    '--glob=' + q.pattern,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    ...VCS_EXCLUDES.flatMap((n) => ['--glob=!**/' + n, '--glob=!**/' + n + '/**']),
    '--',
    q.root,
  ]
}

/**
 * The argv the guard ACTUALLY suggests today (pattern translated).
 *
 * This is the column that matters: it is what an agent would really run after
 * the guard refuses a glob call.
 */
function esArgv(q) {
  const tr = translateToEsPattern(q.pattern, q.root)
  const argv = ['-n', '100']
  if (tr.root !== undefined && tr.root !== '') argv.push('-path', tr.root)
  argv.push(tr.pattern)
  return argv
}

/**
 * The argv the guard used to suggest: the raw glob pattern passed straight
 * through. Kept as a control because it is the bug the benchmark found — the
 * raw form is both slower AND, with a directory prefix, returns nothing.
 */
function esArgvRaw(q) {
  return ['-n', '100', '-path', q.root, q.pattern]
}

/** Run one command, returning wall-clock ms and the line count of stdout. */
function runOnce(bin, argv) {
  const t0 = process.hrtime.bigint()
  const r = spawnSync(bin, argv, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true })
  const t1 = process.hrtime.bigint()
  const out = (r.stdout ?? '').toString()
  const lines = out === '' ? 0 : out.split('\n').filter((l) => l.trim() !== '').length
  return { ms: Number(t1 - t0) / 1e6, lines, failed: r.status !== 0 && lines === 0 }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p90 = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]
}

function main() {
  if (ES === undefined) {
    console.error('es.exe not found — cannot benchmark the replacement.')
    process.exit(2)
  }
  if (!existsSync(RG)) {
    console.error('ripgrep not found at ' + RG)
    process.exit(2)
  }

  console.log('# Search latency: built-in glob (ripgrep) vs Everything (es.exe)')
  console.log('')
  console.log('rg    : ' + RG)
  console.log('es    : ' + ES)
  console.log('reps  : ' + REPS + ' per engine per query (median reported)')
  console.log('when  : ' + new Date().toISOString())
  console.log('')

  // Warm up both engines: es.exe pays an IPC connect on first use, and the OS
  // file cache needs a pass before either number means anything.
  for (const q of QUERIES) {
    runOnce(RG, rgArgv(q))
    runOnce(ES, esArgv(q))
  }

  const rows = []
  for (const q of QUERIES) {
    const rgTimes = [], esTimes = [], rawTimes = []
    let rgLines = 0, esLines = 0, rawLines = 0
    for (let i = 0; i < REPS; i += 1) {
      const a = runOnce(RG, rgArgv(q)); rgTimes.push(a.ms); rgLines = a.lines
      const b = runOnce(ES, esArgv(q)); esTimes.push(b.ms); esLines = b.lines
      const c = runOnce(ES, esArgvRaw(q)); rawTimes.push(c.ms); rawLines = c.lines
    }
    rows.push({
      label: q.label,
      rgMed: median(rgTimes), rgP90: p90(rgTimes), rgLines,
      esMed: median(esTimes), esP90: p90(esTimes), esLines,
      rawMed: median(rawTimes), rawLines,
    })
  }

  console.log('| query | rg (built-in) | es (after fix) | hits rg/es | es RAW (before fix) | raw hits | rg→es |')
  console.log('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const speedup = r.esMed > 0 ? (r.rgMed / r.esMed) : Infinity
    const rawSpeedup = r.rawMed > 0 ? (r.rgMed / r.rawMed) : Infinity
    console.log('| ' + r.label
      + ' | ' + r.rgMed.toFixed(0) + ' ms'
      + ' | **' + r.esMed.toFixed(0) + ' ms**'
      + ' | ' + r.rgLines + '/' + r.esLines
      + ' | ' + r.rawMed.toFixed(0) + ' ms'
      + ' | ' + r.rawLines
      + ' | ' + (Number.isFinite(speedup) ? speedup.toFixed(1) + 'x' : 'n/a')
      + ' vs raw ' + (Number.isFinite(rawSpeedup) ? rawSpeedup.toFixed(1) + 'x' : 'n/a') + ' |')
  }

  // Honest summary: the median speedup overall, and whether the two engines
  // agreed on how many files exist. A fast answer to a different question is
  // not the same answer.
  const ratios = rows.map((r) => (r.esMed > 0 ? r.rgMed / r.esMed : 0)).filter((x) => x > 0)
  const rawRatios = rows.map((r) => (r.rawMed > 0 ? r.rgMed / r.rawMed : 0)).filter((x) => x > 0)
  const overall = median(ratios)
  const overallRaw = median(rawRatios)
  console.log('median rg→es speedup, guard AS-ISSUED (translated): ' + overall.toFixed(2) + 'x')
  console.log('median rg→es speedup, guard RAW pattern (the bug):  ' + overallRaw.toFixed(2) + 'x')
  console.log('')
  console.log('median speedup across queries: ' + overall.toFixed(1) + 'x')
  const mismatches = rows.filter((r) => r.rgLines !== r.esLines)
  if (mismatches.length === 0) {
    console.log('result counts: both engines agreed on every query')
  } else {
    console.log('result counts DIFFER on ' + mismatches.length + ' query(ies) — speed is not the whole story:')
    for (const m of mismatches) console.log('  - ' + m.label + ': rg ' + m.rgLines + ' vs es ' + m.esLines)
  }

  // --- The crossover, which decides whether this guard is a net win --------
  //
  // es.exe pays a fixed ~40 ms (process start + Everything IPC); ripgrep's cost
  // grows with the tree it walks. So es.exe wins LARGE and loses SMALL, and a
  // guard that claims "always faster" would be wrong. This section measures the
  // crossover instead of assuming it.
  console.log('')
  console.log('## Fixed-cost floor and crossover')
  console.log('')
  const SCALES = [
    { label: 'one project src/', root: 'D:/VibeCoding/project/dsh-plugin/dsh-ops-guard/src' },
    { label: 'one project', root: 'D:/VibeCoding/project/dsh-plugin/dsh-ops-guard' },
    { label: 'D:/VibeCoding', root: 'D:/VibeCoding' },
    { label: 'whole drive D:/', root: 'D:/' },
  ]
  console.log('| scope | rg | es | winner |')
  console.log('|---|---|---|---|')
  const scaleRows = []
  for (const s of SCALES) {
    const q = { pattern: '**/*.ts', root: s.root, label: s.label }
    runOnce(RG, rgArgv(q)); runOnce(ES, esArgv(q))
    const rgs = [], ess = []
    for (let i = 0; i < REPS; i += 1) {
      rgs.push(runOnce(RG, rgArgv(q)).ms)
      ess.push(runOnce(ES, esArgv(q)).ms)
    }
    const rm = median(rgs), em = median(ess)
    scaleRows.push({ label: s.label, rgMed: rm, esMed: em })
    console.log('| ' + s.label + ' | ' + rm.toFixed(0) + ' ms | ' + em.toFixed(0) + ' ms | '
      + (em < rm ? 'es (' + (rm / em).toFixed(1) + 'x)' : 'rg (' + (em / rm).toFixed(1) + 'x)') + ' |')
  }

  const outDir = join(HERE, 'results')
  mkdirSync(outDir, { recursive: true })
  // BENCH_OUT lets a caller pin the filename — the restart task compares a
  // fresh run against bench/baseline.json, so a timestamped-only name would
  // make that comparison impossible.
  const pinned = process.env.BENCH_OUT
  const out = pinned ? join(outDir, pinned) : join(outDir, 'result-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
  writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), rg: RG, es: ES, reps: REPS, rows, scaleRows, overallSpeedup: overall, overallSpeedupRaw: overallRaw }, null, 2))
  console.log('')
  console.log('json written: ' + out)
}

main()
