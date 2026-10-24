/**
 * Advisory: a blind `sleep` while a background job is already running.
 *
 * WHY THIS IS AN ADVISORY AND NOT A GUARD
 *
 * Measured across 342 sessions: 772 sleep calls, of which the large majority
 * ran in sessions that ALSO had a `run_in_background` job in flight. The model
 * slept for a fixed duration, then asked for the result on the next step, when
 * it could have blocked once on the job itself.
 *
 *   run_in_background jobs started   513
 *   job_output calls                 351   (wait:true on only 109)
 *   sleep calls                      772
 *
 * Every background task was queried 0.68 times on average — fewer than one.
 *
 * BUT BLOCKING HERE WOULD BE WRONG, and the measurement says why:
 *
 *   - 87% of those sleeps had a background job in the session, so the advice
 *     applies to most of them
 *   - 13% did NOT, and were waiting on something external (a remote build, a
 *     Kaggle kernel, a service coming up). No job exists to wait on, so denying
 *     the call would break a legitimate workflow.
 *   - The advisory cannot see the job registry (it lives on the host plane), so
 *     it cannot tell the two apart with certainty. Even if it could, a wrong
 *     denial costs the user a broken session while a wrong hint costs one line
 *     of text.
 *
 * So this NEVER denies. It appends one sentence to the tool's result, once per
 * session, only when the command is clearly a bounded sleep. The model keeps
 * full authority; it just learns the cheaper option exists.
 *
 * WHY ONCE PER SESSION: an advisory repeated on all 772 calls becomes noise the
 * model learns to skip, and it would bloat every result.
 *
 * @module dsh-ops-guard/sleep-advisory
 */

/** Shell tools whose `command` argument may contain a sleep. */
const SLEEP_TOOL_NAMES = new Set(['pwsh', 'bash', 'shell'])

/**
 * A bare sleep long enough that blocking on the job would clearly have been
 * better. Below this, the round-trip saved is smaller than the noise added.
 */
const MIN_SLEEP_SECONDS = 20

/**
 * Extract a sleep command, tolerating every shape that appears in practice:
 *
 *   sleep 45
 *   sleep 570
 *   Start-Sleep -Seconds 45
 *   Start-Sleep -Milliseconds 45000
 *   sleep 100; cat /tmp/run.log        (a poll)
 *
 * Returns undefined for anything else — including a sleep nested inside a
 * loop, because there the whole command is one intentional wait and there is
 * no single call to convert.
 *
 * @param command - the tool's raw command string.
 * @returns the sleep duration in seconds, when this is a plain bounded sleep.
 */
export function sleepSecondsOf(command: string): number | undefined {
  const text = command.trim()
  if (text === '') return undefined

  // A loop owns its own wait: `for ...; do sleep 50; done` cannot be turned into
  // one job_output, so there is no actionable advice. Leave it alone.
  if (/(?:^|[;&|(]\s*)(?:for|while|until)\b/i.test(text)) return undefined

  // POSIX coreutils: `sleep 45`, with an optional suffix. A leading wrapper
  // such as `sudo` or `time` is allowed because the sleep still dominates the
  // call; without it `sudo sleep 100` would silently escape the advisory.
  const posix = /(?:^|[;&|(]\s*)(?:[a-z_][\w.-]*\s+){0,3}sleep\s+([0-9]+(?:\.[0-9]+)?)([smhd]?)\b/i.exec(text)
  if (posix !== null) {
    const value = Number(posix[1])
    if (!Number.isFinite(value)) return undefined
    const unit = (posix[2] ?? 's').toLowerCase()
    const scale = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1
    const seconds = value * scale
    return seconds >= MIN_SLEEP_SECONDS ? seconds : undefined
  }

  // PowerShell: -Seconds / -Milliseconds. A bare `Start-Sleep 45` is seconds.
  const ps = /Start-Sleep\b([^;&|]*) /i.exec(text + ' ')
  if (ps !== null) {
    const body = ps[1] ?? ''
    const millis = /-Milliseconds?\s+([0-9]+)/i.exec(body)
    if (millis !== null) {
      const seconds = Number(millis[1]) / 1000
      return Number.isFinite(seconds) && seconds >= MIN_SLEEP_SECONDS ? seconds : undefined
    }
    const secs = /(?:-Seconds?\s+)?([0-9]+)/.exec(body.replace(/-\w+/g, ''))
    if (secs !== null) {
      const seconds = Number(secs[1])
      return Number.isFinite(seconds) && seconds >= MIN_SLEEP_SECONDS ? seconds : undefined
    }
  }
  return undefined
}

/**
 * Whether one tool call is a bounded sleep worth advising about.
 *
 * @param name - the tool name from the post-execute hook.
 * @param args - the raw arguments object.
 * @returns the sleep duration in seconds, when advice applies.
 */
export function inspectSleep(name: string, args: unknown): number | undefined {
  if (!SLEEP_TOOL_NAMES.has(name)) return undefined
  if (args === null || typeof args !== 'object') return undefined
  const command = (args as { command?: unknown }).command
  if (typeof command !== 'string') return undefined
  return sleepSecondsOf(command)
}

/**
 * The advisory text appended once to a tool result.
 *
 * Kept to one short paragraph: it shares space with the actual command output,
 * and a long lecture would bury what the model asked for.
 *
 * @param seconds - how long the command slept.
 * @returns the sentence to append.
 */
export function sleepAdvisory(seconds: number): string {
  const shown = seconds >= 60 ? Math.round(seconds / 60) + ' 分钟' : Math.round(seconds) + ' 秒'
  return [
    '',
    '[dsh-ops-guard] 这条命令盲等了约 ' + shown + '。',
    '如果它是在等一个后台任务，用 job_output({ wait: true, timeout_ms: N }) 可以一次阻塞到完成 ——',
    '省掉这次 sleep 和下一次查询的往返。若是在等外部服务（远程构建、Kaggle 内核等），本提示不适用。',
  ].join('\n')
}
