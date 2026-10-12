/**
 * Search-command detection: route file discovery through Everything.
 *
 * Why this exists, and why it mirrors detect.ts rather than merging with it:
 * the SAME argument that justifies the download guard applies to file search.
 * The everything-cli skill states the rule in prose, and prose is advisory. An
 * agent holding a built-in glob tool has no reason to reach for es.exe, so the
 * rule has to live in the runtime.
 *
 * Scope, decided by measurement rather than assumption. The built-in search
 * surface is two tools, and they are NOT equally replaceable:
 *
 *   glob — find files by path/name. Everything is a full-disk real-time name
 *          index; es.exe answers a 2.5M-file index in milliseconds. REPLACED.
 *
 *   grep — find files by CONTENT. Everything can do this only when the user has
 *          enabled content indexing, which is OFF on the machine this was
 *          written for (es.exe "content:..." returns nothing). If the guard
 *          denied grep on a machine in that state, content search would stop
 *          working entirely — a visible regression far worse than the slowness
 *          it would prevent. NOT REPLACED, deliberately.
 *
 * That asymmetry is the same bias detect.ts documents: prefer a missed
 * optimisation over a blocked workflow.
 *
 * What was measured against es.exe 1.1.0.37 before writing this:
 * - The double-star segment is recursive: a pattern like "src/<star><star>/*.ts"
 *   matches a file at any depth beneath src, while a bare "src/*.ts" does NOT
 *   recurse, so a pattern's shape must be preserved rather than flattened.
 * - Everything does not apply .gitignore. Neither does the built-in glob tool
 *   (it runs ripgrep with --no-ignore --hidden), so the two already agree, and
 *   node_modules appears in both. No exclusion is invented here.
 * - es.exe lives on PATH but only for the user's shell; the guard therefore
 *   probes for it and reports the resolved path rather than assuming one.
 */

/** Tool names whose invocation this detector may refuse. */
const SEARCH_TOOL = 'glob'

/**
 * The tool this detector deliberately does NOT touch, named so the omission is
 * visible in the source rather than inferred from its absence.
 *
 * Everything's content search requires an index the user must opt into and
 * that was measured as disabled here; denying grep would replace a slow search
 * with no search at all.
 */
export const UNTOUCHED_SEARCH_TOOL = 'grep'

/** A search detection result: which tool matched, and the arguments worth echoing. */
export interface SearchHit {
  /** Short machine name of the matched rule (for tests and messages). */
  rule: string
  /** The glob pattern the model asked for. */
  pattern: string
  /** The search root the model asked for, when it named one. */
  path?: string
}

/** Extract the glob arguments from a tool call, tolerating malformed input. */
export function globArgsOf(args: unknown): { pattern: string; path?: string } | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const raw = args as { pattern?: unknown; path?: unknown }
  if (typeof raw.pattern !== 'string' || raw.pattern.trim() === '') return undefined
  const out: { pattern: string; path?: string } = { pattern: raw.pattern }
  if (typeof raw.path === 'string' && raw.path.trim() !== '') out.path = raw.path
  return out
}

/**
 * Whether one tool call is a built-in search this guard redirects.
 *
 * @param name - the tool name from the pre-execute hook.
 * @param args - the raw arguments object.
 * @returns a hit when the call should be refused, else undefined.
 */
export function inspectSearch(name: string, args: unknown): SearchHit | undefined {
  if (name !== SEARCH_TOOL) return undefined
  const parsed = globArgsOf(args)
  if (parsed === undefined) return undefined
  return { rule: 'glob', pattern: parsed.pattern, path: parsed.path }
}

/**
 * Build the es.exe argv for one glob call.
 *
 * The mapping is nearly the identity because es.exe's pattern language is a
 * superset for this purpose — `<star><star>` is recursive in both. The only translation
 * is the root: the built-in tool takes a `path` argument, es.exe takes `-path`.
 *
 * When the model names no root the built-in tool defaults to the session
 * workspace. Callers pass that default in as `defaultRoot` so the suggestion
 * searches the same tree the refused call would have.
 *
 * @param hit - the detection result.
 * @param esPath - the resolved absolute path of es.exe.
 * @param defaultRoot - workspace root used when the call named no path.
 * @returns the argv vector, excluding the executable itself.
 */
export function esArgvFor(hit: SearchHit, defaultRoot?: string): string[] {
  const translated = translateToEsPattern(hit.pattern, hit.path ?? defaultRoot)
  const argv = ['-n', '50']
  if (translated.root !== undefined && translated.root !== '') argv.push('-path', translated.root)
  argv.push(translated.pattern)
  return argv
}

/**
 * Translate one glob pattern into the es.exe form that is both CORRECT and FAST.
 *
 * This exists because passing the pattern through unchanged was measured to be
 * wrong twice over, and the benchmark is what caught it:
 *
 *   es -path D "**<slash>*.ts"    1525 ms   223 hits
 *   es -path D "*.ts"               40 ms   223 hits   <- identical result, 38x faster
 *   es -path D "src/**<slash>*.ts"  218 ms     0 hits   <- WRONG, loses every match
 *   es -path D/src "*.ts"           41 ms     5 hits   <- correct
 *
 * Everything's -path is ALREADY recursive over filenames, so a **<slash> segment
 * is redundant when it is the leading one — it costs a full drive walk for the
 * same answer. With a directory prefix in front of it (src/**<slash>*.ts) it is
 * not merely slow, it returns nothing at all.
 *
 * The translation is deliberately narrow. It only fires when:
 *   - the pattern contains the double-star segment, and
 *   - everything before it is a plain directory prefix with no wildcard, and
 *   - something follows it.
 * Any other shape is passed through untouched, because guessing at a pattern is
 * how a search returns the wrong files while still looking like it worked.
 *
 * @param pattern - the glob pattern the model asked for.
 * @param root - the search root, when one is known.
 * @returns the es.exe pattern and the possibly-deepened root.
 */
export function translateToEsPattern(
  pattern: string,
  root: string | undefined,
): { pattern: string; root: string | undefined } {
  const STAR = '**/'
  const at = pattern.indexOf(STAR)
  if (at === -1) return { pattern, root }

  const prefix = pattern.slice(0, at)
  const rest = pattern.slice(at + STAR.length)
  if (rest === '') return { pattern, root }
  // A wildcard inside the prefix means it is not a plain directory, so it
  // cannot move into -path; leave the pattern alone.
  if (/[*?[\]]/.test(prefix)) return { pattern, root }

  const dir = prefix.replace(/[/\\]+$/, '')
  if (dir === '') return { pattern: rest, root }
  const joined = root === undefined || root === '' ? dir : root.replace(/[/\\]+$/, '') + '/' + dir
  return { pattern: rest, root: joined }
}

/**
 * Render one shell-safe argument: double-quote it when it contains a space or a
 * shell metacharacter, escaping embedded double quotes.
 *
 * The suggested command is handed to a model that will paste it into a shell,
 * so a Windows path with spaces ("C:\Program Files") must survive verbatim.
 */
export function shellQuote(arg: string): string {
  if (arg !== '' && !/[\s"'$&|;<>()^*?\[\]{}!#~`]/.test(arg)) return arg
  return '"' + arg.replace(/"/g, '\\"') + '"'
}

/** Join an argv vector into a paste-ready command line. */
export function renderCommand(exe: string, argv: string[]): string {
  return [exe, ...argv].map(shellQuote).join(' ')
}

/**
 * Build the refusal text for a redirected search.
 *
 * Shape follows denialMessage in index.ts: name what was blocked, say why the
 * replacement is better, and hand over an exact command so compliance is the
 * path of least effort. It additionally names the untouched tool, because a
 * model that wanted a CONTENT search and got a filename suggestion needs to
 * know where to go next rather than retrying the refused tool.
 */
export function searchDenialMessage(
  hit: SearchHit,
  esPath: string | undefined,
  defaultRoot?: string,
): string {
  const argv = esArgvFor(hit, defaultRoot)
  const lines = [
    'BLOCKED by dsh-ops-guard: use Everything (es.exe) for file search instead',
    '(matched: ' + hit.rule + '). Everything keeps a real-time index of every file,',
    'so the same query answers in milliseconds instead of walking the tree.',
    '',
  ]
  if (esPath === undefined) {
    // The guard is configured to refuse regardless, but it must not invent a
    // command it cannot substantiate. Say what is wrong and what still works.
    lines.push(
      'es.exe was not found on PATH, so no replacement command can be given.',
      'Install Everything + es.exe (voidtools.com), or use the grep tool, whose',
      'content search is unaffected by this guard.',
    )
  } else {
    lines.push('Use instead:', '  ' + renderCommand(esPath, argv), '')
    lines.push(
      'Options: -n <count> to change the result cap, -json for machine-readable',
      'output, -path <dir> to change the root. es.exe speaks the same pattern',
      'language, including ** for recursive matches.',
    )
  }
  lines.push(
    '',
    'The grep tool is NOT affected: content search stays on the built-in tool.',
  )
  return lines.join('\n')
}

/**
 * Render an answer that was already computed, instead of a command to run.
 *
 * WHY THIS IS THE POINT OF THE WHOLE DETOUR:
 *
 * A refusal that hands over a command still costs the model a round trip and a
 * process start. Measured on this machine:
 *
 *     es.exe, full process run            38.9 ms
 *     node -e "", bare process start      58.5 ms
 *
 * So wrapping the pipe in a CLI would be WORSE than es.exe, not better — node
 * itself costs more to start than es.exe does. The resident client only pays off
 * when it runs INSIDE a process that is already alive, which is exactly what the
 * guard is. The guard cannot mutate the call (pre-execute may only allow, deny,
 * ask or cancel — verified in dsh-tools lib/index.js), so the way to spend that
 * advantage is to put the finished ANSWER in the denial.
 *
 * The model then reads results instead of running anything: one step, no
 * subprocess, and the answer is already the right shape.
 *
 * @param hit - the redirected search.
 * @param result - the records the resident client returned.
 * @param elapsedMs - how long the query took, for honesty about cost.
 * @returns the denial text carrying the results.
 */
export function searchAnsweredMessage(
  hit: SearchHit,
  result: { total: number; records: { path: string; directory: boolean }[] },
  elapsedMs: number,
  esPath?: string,
  defaultRoot?: string,
): string {
  const shown = result.records.slice(0, 50)
  const lines = [
    'BLOCKED by dsh-ops-guard: the built-in glob tool was not run.',
    '(matched: ' + hit.rule + ' — pattern ' + JSON.stringify(hit.pattern)
      + (hit.path === undefined ? '' : ', path ' + JSON.stringify(hit.path)) + ')',
    '',
    'Everything already answered this query over its resident IPC pipe in '
      + elapsedMs.toFixed(1) + ' ms, so there is nothing for you to run:',
    '',
    '  total matches: ' + result.total + (result.total > shown.length
      ? '   (showing first ' + shown.length + ')' : ''),
  ]
  if (shown.length === 0) {
    lines.push('', '  (no files matched)')
  } else {
    lines.push('')
    for (const rec of shown) lines.push('  ' + (rec.directory ? '[dir] ' : '      ') + rec.path)
  }
  lines.push(
    '',
    'If you need a DIFFERENT query, es.exe speaks the same pattern language:',
    '  ' + renderCommand(esPath ?? 'es.exe', esArgvFor(hit, defaultRoot)),
    '',
    'The grep tool is NOT affected: content search stays on the built-in tool.',
  )
  return lines.join('\n')
}

/**
 * Build the Everything query string for one glob call.
 *
 * The IPC pipe has no -path option — that flag belongs to the es.exe command
 * line and does not exist in the wire format (the cmd-7 payload carries flags,
 * the query, an offset and a count, and nothing else). Scoping therefore has to
 * ride inside the query itself, and Everything supports exactly that:
 *
 *   es -path D:/proj "*.md"         11 results
 *   query:  path:D:\proj *.md       11 results, identical set
 *
 * Verified by comparing the full result lists rather than the counts: 11 vs 11,
 * zero records unique to either side. Without this the guard would answer a
 * request scoped to one project with matches from the entire disk — a wrong
 * answer, which is worse than the refusal it replaced.
 *
 * The pattern itself is passed through translateToEsPattern first, because the
 * same trap applies here as on the command line: -path is already recursive,
 * and a leading **<slash> segment makes Everything walk the whole drive (or,
 * with a directory prefix, match nothing at all).
 *
 * @param pattern - the glob pattern the model asked for.
 * @param root - the search root, when one is known.
 * @returns the query string for the pipe.
 */
export function buildEverythingQuery(
  pattern: string,
  root: string | undefined,
  workspace?: string,
): string {
  const translated = translateToEsPattern(pattern, root)
  let scope = translated.root
  if (scope === undefined || scope === '') return translated.pattern

  // Resolve a relative root against the session workspace before it reaches the
  // query. Everything does NOT resolve relative paths the way a shell does:
  // measured, "path:. *.md" returned 24693 results — the entire disk — rather
  // than the current directory. A guard that answered a project-scoped question
  // with whole-disk results would be handing over a wrong answer that looks
  // authoritative, so an unresolvable root is safer dropped than guessed.
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(scope) || scope.startsWith('\\\\')
  if (!isAbsolute) {
    if (workspace === undefined || workspace === '') return translated.pattern
    // "." and "./" mean the workspace itself; anything else is a subdirectory.
    const trimmed = scope.replace(/^[.][\\/]?/, '').replace(/[\\/]+$/, '')
    const base = workspace.replace(/[\\/]+$/, '')
    scope = trimmed === '' ? base : base + '\\' + trimmed
  }
  return 'path:' + scope + ' ' + translated.pattern
}
