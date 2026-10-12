/**
 * Filesystem probe for the everything-cli dependency.
 *
 * Kept separate from search.ts so the detector stays a pure function over a
 * tool call — the same split detect.ts keeps from index.ts, and for the same
 * reason: a detector that also touched the disk could not be unit-tested
 * without a fixture, and a probe failure must never be able to turn a decision
 * into a crash.
 *
 * The probe answers one question: is there an es.exe this guard can name in its
 * suggested command? It resolves in the order the everything-cli skill
 * documents, because es.exe is not always on PATH — it ships alongside
 * Everything and is frequently left in the install directory.
 *
 * Scope note: this deliberately does NOT verify that Everything is RUNNING.
 * es.exe talks to Everything over IPC and fails at call time if the service is
 * down; probing that here would mean spawning a process during a tool
 * pre-execute hook, which is the wrong place for it. A stale es.exe is
 * reported as found, and the model sees the real error when it runs the
 * command — which is more useful than a guard that guesses.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Executable names to look for, in probe order. */
const ES_NAMES = ['es.exe', 'es']

/**
 * Candidate directories, in the order the skill documents.
 *
 * PATH wins first because that is where a working install usually puts it —
 * this machine has it at %USERPROFILE%\bin\es.exe. The Everything install
 * directories follow, since the CLI is often shipped beside the GUI and never
 * added to PATH.
 */
function candidateDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const dirs: string[] = []
  const pathValue = env.PATH ?? env.Path ?? ''
  // The separator is a property of the PLATFORM, not of which casing the
  // variable happened to use. Keying it off the variable name split a Windows
  // PATH on ':' and turned "C:\\tools" into the two bogus entries "C" and
  // "\\tools" — caught by the unit test for the probe.
  const sep = platform === 'win32' ? ';' : ':'
  for (const entry of pathValue.split(sep)) {
    if (entry.trim() !== '') dirs.push(entry.trim())
  }
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (home !== '') dirs.push(join(home, 'bin'))
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  dirs.push(join(programFiles, 'Everything'))
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  dirs.push(join(programFilesX86, 'Everything'))
  dirs.push('C:\\Program Files\\Everything')
  dirs.push('D:\\Everything')
  dirs.push('C:\\Everything')
  return dirs
}

/** Whether a path names an existing regular file. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve es.exe, or undefined when none is found.
 *
 * @param options - probe inputs.
 * @param options.env - environment to read (defaults to process.env).
 * @param options.exists - existence test, injectable for tests.
 * @returns the absolute path, or undefined.
 */
export function findEsExe(options: {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  platform?: string
} = {}): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  try {
    for (const dir of candidateDirs(env, platform)) {
      if (dir === '') continue
      for (const name of ES_NAMES) {
        const p = join(dir, name)
        if (exists(p)) return p
      }
    }
  } catch {
    // A probe failure must never become a crash; "not found" is a safe answer.
  }
  return undefined
}

/** Whether a resolved candidate is a real file rather than a directory. */
export { isFile as isRegularFile }
