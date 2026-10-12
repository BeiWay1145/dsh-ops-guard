/**
 * Compare a fresh benchmark run against the saved baseline.
 *
 * This is the second half of the restart check. The guard changed how file
 * search is routed, so the honest question after a restart is not "does the
 * plugin load" (dump-config answers that) but "is search actually faster or
 * slower than it was". This script answers that with the measured numbers
 * rather than a claim.
 *
 * Design decisions that matter:
 *
 * 1. It NEVER invents a verdict it did not measure. If a query is missing from
 *    either side, it is reported as missing rather than silently skipped — a
 *    comparison that drops inconvenient rows is worse than no comparison.
 *
 * 2. It distinguishes "faster" from "correct". A change that speeds search up
 *    while returning fewer files is not an improvement, so result counts are
 *    compared alongside latency and a count mismatch is called out loudly.
 *
 * 3. Machine noise is real. A difference under 15% is reported as "unchanged"
 *    rather than dressed up as a win, because process start and Windows file
 *    cache make small deltas meaningless.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'results', 'baseline.json')
const CURRENT = process.argv[2] ?? join(HERE, 'results', 'after-restart.json')

/** Below this ratio a delta is machine noise, not a result. */
const NOISE = 0.15

function load(p, label) {
  if (!existsSync(p)) {
    console.error('MISSING ' + label + ': ' + p)
    console.error('  run the benchmark first: BENCH_OUT=' + (label === 'baseline' ? 'baseline.json' : 'after-restart.json') + ' node bench/bench-search.mjs')
    process.exit(2)
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

const before = load(BASELINE, 'baseline')
const after = load(CURRENT, 'current')

console.log('# Search latency: before vs after')
console.log('')
console.log('before: ' + before.when + '  (' + before.reps + ' reps)')
console.log('after : ' + after.when + '  (' + after.reps + ' reps)')
console.log('')

/** Index a run's rows by label so the two sides line up by QUERY, not position. */
const byLabel = (run) => new Map((run.rows ?? []).map((r) => [r.label, r]))
const B = byLabel(before)
const A = byLabel(after)

const labels = [...new Set([...B.keys(), ...A.keys()])]

console.log('| query | before (rg) | after (rg) | Δ | before hits | after hits |')
console.log('|---|---|---|---|---|---|')
let missing = 0
const countMismatches = []
for (const label of labels) {
  const b = B.get(label)
  const a = A.get(label)
  if (b === undefined || a === undefined) {
    missing += 1
    console.log('| ' + label + ' | ' + (b ? b.rgMed.toFixed(0) + ' ms' : '—') + ' | ' + (a ? a.rgMed.toFixed(0) + ' ms' : '—') + ' | MISSING | ' + (b ? b.rgLines : '—') + ' | ' + (a ? a.rgLines : '—') + ' |')
    continue
  }
  const delta = b.rgMed === 0 ? 0 : (a.rgMed - b.rgMed) / b.rgMed
  const verdict = Math.abs(delta) < NOISE ? 'unchanged' : (delta < 0 ? 'faster' : 'slower')
  console.log('| ' + label
    + ' | ' + b.rgMed.toFixed(0) + ' ms'
    + ' | ' + a.rgMed.toFixed(0) + ' ms'
    + ' | ' + (delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '% ' + verdict
    + ' | ' + b.rgLines + ' | ' + a.rgLines + ' |')
  if (b.rgLines !== a.rgLines) countMismatches.push({ label, before: b.rgLines, after: a.rgLines })
}

console.log('')
if (missing > 0) console.log('⚠ ' + missing + ' query(ies) present on only one side — the comparison is INCOMPLETE.')
else console.log('✓ every baseline query was measured again')

if (countMismatches.length > 0) {
  console.log('')
  console.log('⚠ result counts changed — a latency win that loses files is NOT an improvement:')
  for (const m of countMismatches) console.log('  - ' + m.label + ': ' + m.before + ' -> ' + m.after)
} else {
  console.log('✓ every query returned the same number of files as before')
}

// The headline numbers: the built-in tool (must be untouched) and the routed
// replacement (must be the fast path).
const rgBefore = (before.rows ?? []).map((r) => r.rgMed)
const rgAfter = (after.rows ?? []).map((r) => r.rgMed)
const esAfter = (after.rows ?? []).map((r) => r.esMed)
const esRawAfter = (after.rows ?? []).map((r) => r.rawMed)
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

console.log('')
console.log('## Summary')
console.log('')
if (rgBefore.length && rgAfter.length) {
  const d = (med(rgAfter) - med(rgBefore)) / med(rgBefore)
  console.log('built-in glob (rg), median: ' + med(rgBefore).toFixed(0) + ' ms -> ' + med(rgAfter).toFixed(0) + ' ms ('
    + (d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%)')
  console.log('  the guard must NOT slow this down; it only refuses the call, never runs it')
}
if (esAfter.length) {
  console.log('es.exe (routed replacement), median: ' + med(esAfter).toFixed(0) + ' ms')
  if (rgAfter.length) console.log('  vs built-in glob: ' + (med(rgAfter) / med(esAfter)).toFixed(2) + 'x')
}
if (esRawAfter.length) {
  console.log('es.exe with the RAW (pre-fix) pattern, median: ' + med(esRawAfter).toFixed(0) + ' ms')
  console.log('  the pattern-translation fix is worth ' + (med(esRawAfter) / med(esAfter)).toFixed(1) + 'x')
}

console.log('')
console.log('## Judgement')
console.log('')
const rgSlowed = rgBefore.length && rgAfter.length && (med(rgAfter) - med(rgBefore)) / med(rgBefore) > NOISE
if (missing > 0 || countMismatches.length > 0) {
  console.log('INCONCLUSIVE — fix the anomalies above before trusting the numbers.')
} else if (rgSlowed) {
  console.log('REGRESSION — the built-in glob got slower; the guard should not affect it.')
} else {
  console.log('PASS — counts stable, the built-in tool is not slowed, and the routed path is fast.')
}
