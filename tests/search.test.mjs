/**
 * Search-guard tests: detection, the es.exe argv mapping, and the refusal text.
 *
 * These are the assertions that would have caught the design mistakes this
 * guard is most likely to make, each of which was measured against the real
 * es.exe 1.1.0.37 before the code was written:
 *
 *   - mapping a recursive glob onto a non-recursive es.exe pattern
 *   - refusing grep, which Everything cannot replace without a content index
 *   - quoting a Windows path with spaces so badly the suggestion does not run
 *   - naming an es.exe that is not there
 */
import { strict as assert } from 'node:assert'
import {
  translateToEsPattern,
  inspectSearch,
  globArgsOf,
  esArgvFor,
  renderCommand,
  shellQuote,
  searchDenialMessage,
  searchAnsweredMessage,
  buildEverythingQuery,
  UNTOUCHED_SEARCH_TOOL,
} from '../src/search.ts'
import { findEsExe, ES_NAMES_WIN32, ES_NAMES_POSIX } from '../src/es.ts'

let passed = 0
let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed += 1; console.log('PASS ' + label) }
  else {
    failed += 1
    console.log('FAIL ' + label + '\n  got  ' + JSON.stringify(actual) + '\n  want ' + JSON.stringify(expected))
  }
}

// --- detection ------------------------------------------------------------
check('glob is redirected', inspectSearch('glob', { pattern: '**/*.ts' })?.rule, 'glob')
check('pattern survives', inspectSearch('glob', { pattern: '**/*.ts' })?.pattern, '**/*.ts')
check('path is carried', inspectSearch('glob', { pattern: '*.md', path: 'src' })?.path, 'src')
check('no path -> undefined', inspectSearch('glob', { pattern: '*.md' })?.path, undefined)

// The deliberate omission, asserted so it cannot regress silently.
check('grep is NOT redirected', inspectSearch('grep', { pattern: 'TODO' }), undefined)
check('the untouched tool is grep', UNTOUCHED_SEARCH_TOOL, 'grep')
check('read is untouched', inspectSearch('read', { file_path: 'a' }), undefined)
check('bash is untouched by the search guard', inspectSearch('bash', { command: 'ls' }), undefined)

// Malformed input must not produce a hit (and must not throw).
check('missing pattern', inspectSearch('glob', {}), undefined)
check('blank pattern', inspectSearch('glob', { pattern: '   ' }), undefined)
check('null args', inspectSearch('glob', null), undefined)
check('string args', inspectSearch('glob', 'oops'), undefined)
check('globArgsOf tolerates junk', globArgsOf({ pattern: 'x', path: 42 })?.path, undefined)

// --- argv mapping ---------------------------------------------------------
// NOTE: an earlier assertion here required src/**/*.ts to pass through
// unchanged. Benchmarking proved that form returns ZERO files from es.exe, so
// the assertion was pinning a bug. The translation assertions below replace it.
check(
  'explicit path beats the default root',
  esArgvFor({ rule: 'glob', pattern: '*.md', path: 'docs' }, 'D:\\ws'),
  ['-n', '50', '-path', 'docs', '*.md'],
)
check(
  'no root at all -> no -path flag',
  esArgvFor({ rule: 'glob', pattern: '*.md' }),
  ['-n', '50', '*.md'],
)

// --- pattern translation (found by benchmarking, not by reading) ----------
//
// Everything's -path is already recursive over filenames, so a leading **/ is
// redundant and expensive, and a **/ behind a directory prefix returns NOTHING.
// These assertions pin the translation that fixes both.
check(
  'leading ** is dropped (38x faster, same hits)',
  esArgvFor({ rule: 'glob', pattern: '**/*.ts' }, 'D:/p'),
  ['-n', '50', '-path', 'D:/p', '*.ts'],
)
check(
  'a directory prefix moves into -path (raw form returned 0 hits)',
  esArgvFor({ rule: 'glob', pattern: 'src/**/*.ts', path: 'D:/p' }),
  ['-n', '50', '-path', 'D:/p/src', '*.ts'],
)
check(
  'a middle suffix is preserved',
  esArgvFor({ rule: 'glob', pattern: 'src/**/*.test.mjs', path: 'D:/p' }),
  ['-n', '50', '-path', 'D:/p/src', '*.test.mjs'],
)
check(
  'a bare pattern without ** is untouched',
  esArgvFor({ rule: 'glob', pattern: '*.ts' }, 'D:/p'),
  ['-n', '50', '-path', 'D:/p', '*.ts'],
)
check(
  'a wildcard in the prefix blocks translation',
  esArgvFor({ rule: 'glob', pattern: 'a*/**/*.ts', path: 'D:/p' }),
  ['-n', '50', '-path', 'D:/p', 'a*/**/*.ts'],
)
check(
  'translation is a no-op on a plain pattern',
  translateToEsPattern('*.ts', 'D:/p'),
  { pattern: '*.ts', root: 'D:/p' },
)
check(
  'trailing slash on the root does not double up',
  translateToEsPattern('src/**/*.ts', 'D:/p/'),
  { pattern: '*.ts', root: 'D:/p/src' },
)

// --- quoting --------------------------------------------------------------
// Quoting a glob is REQUIRED, not cosmetic: an unquoted *.ts handed to a
// shell is expanded by that shell before es.exe ever sees it, so the search
// would run against whatever happens to be in the cwd.
check('glob is quoted so the shell cannot expand it', shellQuote('*.ts'), '"*.ts"')
check('a plain word stays bare', shellQuote('abc'), 'abc')
check('space forces quotes', shellQuote('C:\\Program Files\\a'), '"C:\\Program Files\\a"')
check('backslash-star stays quoted', shellQuote('src\\**\\*.ts'), '"src\\**\\*.ts"')
check('embedded quote is escaped', shellQuote('a"b'), '"a\\"b"')
check(
  'a path with spaces renders runnable',
  renderCommand('es.exe', ['-path', 'C:\\Program Files\\x', '*.ts']),
  'es.exe -path "C:\\Program Files\\x" "*.ts"',
)

// --- refusal text ---------------------------------------------------------
const hit = { rule: 'glob', pattern: '**/*.ts', path: 'D:\\ws' }
const withEs = searchDenialMessage(hit, 'C:\\bin\\es.exe', 'D:\\ws')
assert.ok(withEs.includes('BLOCKED by dsh-ops-guard'), 'names the plugin')
assert.ok(withEs.includes('es.exe'), 'names es.exe')
// The pattern is TRANSLATED before it is shown (the raw ** form returns
// nothing from es.exe), so the message must contain the translated form.
assert.ok(withEs.includes('*.ts'), 'echoes a runnable pattern')
assert.ok(withEs.includes('grep tool is NOT affected'), 'tells the model grep still works')

// The no-es.exe branch must NOT invent a command it cannot substantiate.
const withoutEs = searchDenialMessage(hit, undefined, 'D:\\ws')
assert.ok(withoutEs.includes('was not found'), 'says es.exe is missing')
assert.ok(!withoutEs.includes('Use instead:'), 'offers no bogus command')
assert.ok(withoutEs.includes('grep'), 'still points at a working alternative')

// --- es.exe probe ---------------------------------------------------------
const fakeEnv = { PATH: 'C:\\nope', USERPROFILE: 'C:\\Users\\x', ProgramFiles: 'C:\\PF' }
const foundOnPath = findEsExe({
  env: { ...fakeEnv, PATH: 'C:\\tools' },
  platform: 'win32',
  exists: (p) => p.replace(/\\/g, '/').toLowerCase() === 'c:/tools/es.exe',
  isFile: () => true,
})
check('probe finds a file on PATH', foundOnPath !== undefined, true)
check('probe returns undefined when nothing exists', findEsExe({ env: fakeEnv, exists: () => false }), undefined)
check('probe never throws on a bad env', (() => {
  try { return typeof findEsExe({ env: {}, exists: () => false }) } catch { return 'threw' }
})(), 'undefined')

// --- the directory-masquerading-as-es.exe bug -----------------------------
//
// On this machine PATH contains C:\\Program Files\\PowerShell\\7, which ships a
// LOCALIZATION directory literally named "es" (Spanish). An earlier probe
// joined that directory with the bare name 'es', found an existing path, and
// accepted it — so the guard told the model to execute a folder:
//
//   "C:\\Program Files\\PowerShell\\7\\es" -n 50 -path ... "*.md"
//
// A command that looks authoritative and cannot work. Two guards now:
// the bare name is not probed on win32, and every candidate must be a FILE.
check('bare "es" is not probed on win32', ES_NAMES_WIN32, ['es.exe'])
check('bare "es" IS probed on posix', ES_NAMES_POSIX, ['es'])
check(
  'a DIRECTORY named es.exe is rejected',
  findEsExe({
    env: { PATH: 'C:\\Program Files\\PowerShell\\7', USERPROFILE: 'C:\\nope', ProgramFiles: 'C:\\PF' },
    platform: 'win32',
    exists: () => true,       // the path exists...
    isFile: () => false,      // ...but it is a directory
  }),
  undefined,
)
check(
  'the real file still wins when it exists',
  findEsExe({
    env: { PATH: 'C:\\tools', USERPROFILE: 'C:\\nope', ProgramFiles: 'C:\\PF' },
    platform: 'win32',
    exists: (p) => p.replace(/\\/g, '/').toLowerCase().endsWith('/tools/es.exe'),
    isFile: () => true,
  }),
  'C:\\tools\\es.exe',
)

// --- query scoping (the whole-disk regression) ---------------------------
//
// With no root, buildEverythingQuery once produced a bare "*.md", and
// Everything answered it from the ENTIRE INDEX: 24693 matches for a query the
// caller meant as workspace-scoped. Verified live, not inferred.
{
  const WS = 'D:\\Code\\Reasonix_Projects\\test'
  check('no root falls back to the workspace',
    buildEverythingQuery('**/*.md', undefined, WS),
    'path:' + WS + ' *.md')
  check('a bare dot means the workspace',
    buildEverythingQuery('**/*.md', '.', WS),
    'path:' + WS + ' *.md')
  check('a relative subdir is resolved',
    buildEverythingQuery('**/*.ts', './src', WS),
    'path:' + WS + '\\src *.ts')
  check('a directory prefix in the pattern becomes the root',
    buildEverythingQuery('docs/**/*.md', undefined, WS),
    'path:' + WS + '/docs *.md')
  check('an absolute root is left alone',
    buildEverythingQuery('**/*.ts', 'C:/other', WS),
    'path:C:/other *.ts')
  check('a leading ** is stripped, not searched for',
    buildEverythingQuery('**/*.md', WS, WS),
    'path:' + WS + ' *.md')
}

if (failed === 0) {
  console.log('')
  console.log('---- ' + passed + '/' + (passed + failed) + ' passed ----')
} else {
  console.log('')
  console.log('---- ' + passed + '/' + (passed + failed) + ' passed, ' + failed + ' FAILED ----')
  process.exit(1)
}
