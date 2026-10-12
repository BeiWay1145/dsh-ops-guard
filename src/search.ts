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
  const root = hit.path ?? defaultRoot
  const argv = ['-n', '50']
  if (root !== undefined && root !== '') argv.push('-path', root)
  argv.push(hit.pattern)
  return argv
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
