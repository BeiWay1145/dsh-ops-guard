/**
 * Sleep-advisory unit tests.
 *
 * The advisory is deliberately conservative: it must fire on a bounded sleep
 * and stay silent on everything else, because a false positive costs the model
 * a line of noise on every future call while a false negative costs nothing.
 */
import { sleepSecondsOf, inspectSleep, sleepAdvisory } from '../src/sleep-advisory.ts'

let pass = 0, fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + ' | expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual)) }
}

// fires on bounded sleeps
check('plain seconds', sleepSecondsOf('sleep 45'), 45)
check('one-liner poll', sleepSecondsOf('sleep 100; cat /tmp/run.log'), 100)
check('mid chain', sleepSecondsOf('cd /x && sleep 60 && ls'), 60)
check('minute suffix', sleepSecondsOf('sleep 2m'), 120)
check('fractional suffix', sleepSecondsOf('sleep 1.5m'), 90)
check('sudo prefix', sleepSecondsOf('sudo sleep 100'), 100)
check('powershell seconds', sleepSecondsOf('Start-Sleep -Seconds 45'), 45)
check('powershell millis', sleepSecondsOf('Start-Sleep -Milliseconds 45000'), 45)
check('powershell bare', sleepSecondsOf('Start-Sleep 45'), 45)

// stays silent
check('below threshold', sleepSecondsOf('sleep 5'), undefined)
check('just below threshold', sleepSecondsOf('sleep 19'), undefined)
check('unrelated command', sleepSecondsOf('echo hi'), undefined)
check('grep is not a sleep', sleepSecondsOf('grep -r foo .'), undefined)
check('short powershell millis', sleepSecondsOf('Start-Sleep -Milliseconds 500'), undefined)

// a loop owns its own wait: no single call to convert
check('posix for loop', sleepSecondsOf('for i in $(seq 1 20); do sleep 50; done'), undefined)
check('powershell for loop', sleepSecondsOf('for i in 1..20; do sleep 50; done'), undefined)
check('while loop', sleepSecondsOf('while true; do sleep 5; done'), undefined)

// tool gating
check('pwsh accepted', inspectSleep('pwsh', { command: 'sleep 60' }), 60)
check('bash accepted', inspectSleep('bash', { command: 'sleep 60' }), 60)
check('read rejected', inspectSleep('read', { command: 'sleep 60' }), undefined)
check('no command arg', inspectSleep('pwsh', { file_path: '/x' }), undefined)
check('null args', inspectSleep('pwsh', null), undefined)

// message shape
const m = sleepAdvisory(570)
check('names job_output', m.includes('job_output'), true)
check('states the duration', m.includes('10 分钟'), true)
check('disclaims external waits', m.includes('不适用'), true)
check('short form reads in seconds', sleepAdvisory(45).includes('45 秒'), true)

console.log('')
console.log('---- ' + pass + '/' + (pass + fail) + ' passed ----')
if (fail > 0) process.exitCode = 1