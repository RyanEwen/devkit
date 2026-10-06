import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Reads Linux process fields after the command name, which can itself contain spaces or ')'. */
function linuxProcessFields(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
}

/** Returns an OS process birth identity, or null if the process is gone or cannot be inspected. */
export function processBirth(pid) {
  try {
    if (process.platform === 'linux') {
      const startTicks = linuxProcessFields(pid)[19]
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return `${boot}:${startTicks}`
    }
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().Ticks`
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null
  } catch {
    return null
  }
}

/** Tests liveness, optionally distinguishing the recorded process from a later PID reuse. */
export function processIsAlive(pid, birth) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code !== 'EPERM') return false
  }
  if (process.platform === 'linux') {
    try {
      // Zombies still answer kill(pid, 0), but cannot own a runner or complete cleanup.
      if (['Z', 'X'].includes(linuxProcessFields(pid)[0])) return false
    } catch {
      // Preserve the conservative liveness result when /proc is not readable.
    }
  }
  if (!birth) return true
  const current = processBirth(pid)
  // Lack of permission is not proof that the owner died. Keep its reservation conservatively.
  return current === null || current === birth
}
