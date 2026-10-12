/**
 * dsh-ops-guard — move two advisory rules from prose into the runtime:
 * large-file downloads go through aria2, and file search goes through Everything.
 *
 * Why this exists: the aria2-download skill states the rule in prose, and
 * prose is advisory. An agent holding a hand-rolled downloader will use it —
 * observed directly, when a 4.76 GB ISO was pulled through
 * dsh-download-progress' download.cjs at 0.13 MB/s while the aria2 engine sat
 * idle (the same file moves at ~12 MB/s through aria2, roughly 90x).
 *
 * This plugin moves the rule from prose into the runtime: it listens on
 * tools/pre-execute and DENIES a shell call that would write bytes to disk,
 * returning a reason that names the aria2 forwarder to use instead.
 *
 * Why tools/pre-execute and not the approval chain: under an approval policy
 * of 'never', ApprovalService.decide() returns 'rejected' BEFORE it dispatches
 * the approval/request waterfall, so an approval listener is never invoked at
 * all. The tools pipeline is a separate waterfall with no such short-circuit,
 * and a 'deny' decision stops dispatch before the tool body runs (verified
 * against the real ToolRuntime, not just against the type definitions).
 *
 * The second guard, added later and living in search.ts, applies the same
 * argument to file search: the everything-cli skill states its rule in prose,
 * and an agent holding the built-in glob tool has no reason to reach for
 * es.exe. Only the NAME-based search tool (glob) is redirected. The
 * CONTENT-based tool (grep) is deliberately left alone — Everything can only
 * replace it when the user has opted into content indexing, which was measured
 * as off on this machine, and denying grep there would replace a slow search
 * with no search at all.
 *
 * Scope, by decision: large-file downloads and name-based file search only.
 * Package managers (pip, npm) are explicitly out of scope — neither detected
 * nor blocked.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inspect } from './detect.ts'
import { inspectSearch, searchDenialMessage, searchAnsweredMessage, buildEverythingQuery } from './search.ts'
import { findEsExe } from './es.ts'
import { searchEverything } from './everything-ipc.ts'

/**
 * Plugin identifier used in log lines and refusal text.
 *
 * Declared before every consumer: `const` has no hoisting, so a binding that
 * a function body reads must be initialised before that function can run.
 * esbuild happens to hoist `const` to `var` in the bundle, which masked the
 * ordering during the build — but the SOURCE must be correct on its own.
 */
export const PLUGIN_NAME = 'dsh-ops-guard'

/**
 * Absolute path of the forwarder BUNDLED WITH THIS PACKAGE.
 *
 * Earlier this was the literal `~/.dsh/skills/aria2-download/scripts/aria2-dl.js`
 * — a machine-private path. On any machine without that skill the guard would
 * refuse a download and then name a file that does not exist, which is worse
 * than not blocking at all: it breaks the workflow and offers no way out.
 *
 * `import.meta.url` resolves to <package>/lib/index.js at runtime, so the
 * bundled script sits one level up in scripts/.
 */
function forwarderPath(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'aria2-dl.cjs')
  } catch {
    // Never let path discovery turn a refusal into a crash.
    return 'aria2-dl.cjs'
  }
}

/**
 * Build the denial text: what was blocked, why, and the exact replacement
 * command. An agent that gets a bare refusal has to guess the sanctioned
 * path; handing it the command makes compliance the path of least effort,
 * which is the whole point of the plugin.
 */
export function denialMessage(rule: string, url: string | undefined, command: string): string {
  const target = url === undefined ? '<URL>' : url
  const lines = [
    'BLOCKED by ' + PLUGIN_NAME + ': this command downloads a file to disk',
    '(matched: ' + rule + '), and downloads must go through the local aria2 engine',
    '(Motrix Next) so they are multithreaded, resumable and visible in the download manager.',
    '',
    'Use instead:',
    '  node "' + forwarderPath() + '" "' + target + '" --out=<filename>',
    '',
    'Options: --dir=<dir> for the destination, --header="K: V" for headers,',
    '--no-wait to enqueue and return immediately (then query with --status <gid>).',
    'A blocked command is never partially executed.',
  ]
  const shown = command.length > 240 ? command.slice(0, 240) + '...' : command
  lines.push('', 'Blocked command: ' + shown)
  return lines.join('\n')
}

/** Minimal structural views, so the package needs no DSH type dependency. */
interface PreExecuteExec {
  name?: unknown
  arguments?: unknown
}
interface PluginContext {
  on(event: string, listener: (exec: PreExecuteExec, next: () => Promise<unknown>) => Promise<unknown>): () => void
  logger?: { info(msg: string): void; warn(msg: string): void }
}

/**
 * Register the guard.
 * @param ctx - the cordis context; only the event bus is required.
 */
export function apply(ctx: PluginContext): void {
  /**
   * Resolve es.exe once at load.
   *
   * Doing this here rather than per call keeps the pre-execute hook free of
   * filesystem work — the hook runs in front of EVERY tool call, so a probe
   * that stats a dozen directories belongs at mount time, not inline.
   */
  let esPath: string | undefined
  try {
    esPath = findEsExe()
  } catch {
    // A probe failure means "cannot name a replacement", not "crash".
    esPath = undefined
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    // --- guard 1: downloads must go through aria2 -------------------------
    let hit: ReturnType<typeof inspect>
    try {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      hit = inspect(name, exec?.arguments)
    } catch {
      // A detector bug must never block an unrelated tool call.
      return next()
    }
    if (hit !== undefined) {
      const args = exec?.arguments as { command?: unknown } | undefined
      const command = typeof args?.command === 'string' ? args.command : ''
      const reason = denialMessage(hit.rule, hit.url, command)
      try {
        ctx.logger?.info(PLUGIN_NAME + ': blocked ' + hit.rule + (hit.url === undefined ? '' : ' (' + hit.url + ')'))
      } catch {
        /* logging must never affect the decision */
      }
      return { kind: 'deny', reason }
    }

    // --- guard 2: file search must go through Everything -------------------
    //
    // This guard tries the RESIDENT pipe first, and that ordering is the whole
    // design. Handing the model a command to run costs it a round trip plus a
    // process start, and measured on this machine a bare `node -e ""` is 58.5 ms
    // against es.exe's 38.9 ms — so a CLI wrapper would be SLOWER than what it
    // replaced. The pipe only pays off from inside a live process, which the
    // guard is, so the guard answers the query itself and puts the results in
    // the denial. Nothing is left for the model to execute.
    //
    // Every failure here degrades to the original command suggestion. A search
    // guard that stops working because Everything is not running would trade a
    // slow search for no search.
    let searchHit: ReturnType<typeof inspectSearch>
    try {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      // The session workspace is the built-in tool's own default root, so the
      // suggested command searches the same tree the refused call would have.
      const workspace = workspaceRootOf(exec)
      searchHit = inspectSearch(name, exec?.arguments)
      if (searchHit !== undefined) {
        let reason: string | undefined

        {
          const started = Date.now()
          try {
            // Scoping rides inside the query: the pipe has no -path option.
            const query = buildEverythingQuery(searchHit.pattern, searchHit.path, workspace)
            const answer = await searchEverything(query, { count: 50, timeoutMs: 2500 })
            reason = searchAnsweredMessage(
              searchHit,
              answer,
              Date.now() - started,
              esPath,
              workspace,
            )
            try {
              ctx.logger?.info(
                PLUGIN_NAME + ': answered ' + searchHit.rule + ' over IPC in '
                  + (Date.now() - started) + 'ms (' + answer.total + ' matches)',
              )
            } catch {
              /* logging must never affect the decision */
            }
          } catch {
            // Pipe unavailable, timed out, or the protocol changed. Fall through
            // to the command suggestion rather than failing the tool call.
            reason = undefined
          }
        }

        if (reason === undefined) {
          reason = searchDenialMessage(searchHit, esPath, workspace)
          try {
            ctx.logger?.info(
              PLUGIN_NAME + ': redirected ' + searchHit.rule + ' -> es.exe'
                + (esPath === undefined ? ' (es.exe NOT FOUND)' : ''),
            )
          } catch {
            /* logging must never affect the decision */
          }
        }

        return { kind: 'deny', reason }
      }
    } catch {
      return next()
    }

    return next()
  })
}

/**
 * Best-effort session workspace, used as the search root when the refused call
 * named none.
 *
 * The built-in glob tool resolves a relative `path` against the workdir, and
 * omitting `path` searches the workspace — so the suggestion must do the same
 * or it would silently search a different tree. Returns undefined when no
 * workdir is reachable, in which case es.exe falls back to its own cwd, which
 * for a DSH-spawned command IS the session workdir.
 */
function workspaceRootOf(exec: PreExecuteExec): string | undefined {
  try {
    const anyExec = exec as { agent?: { session?: { header?: { cwd?: unknown } } } }
    const cwd = anyExec.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}
