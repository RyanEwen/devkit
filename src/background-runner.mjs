import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'

const CHILD_FLAG = 'DEVKIT_BACKGROUND_CHILD'

/**
 * Detaches the same Node entry point with its arguments and private log. Resolves with its PID
 * and log path after preflight acknowledgement, or rejects on startup failure or cancellation.
 * The runtime options are test seams; startupTimeoutMs bounds setup, not application readiness.
 */
export async function launchBackgroundRunner(
  config,
  identity,
  { spawnImpl = spawn, processTarget = process, startupTimeoutMs = 300_000 } = {}
) {
  if (!processTarget.argv[1]) throw new Error('devkit: background mode requires a Node runner entry point')
  const logDir = path.join(config.configDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = path.join(logDir, `${identity.slug}.log`)
  const output = openSync(logPath, 'a', 0o600)
  let child
  try {
    child = spawnImpl(processTarget.execPath, [
      ...processTarget.execArgv,
      ...processTarget.argv.slice(1).filter((argument) => argument !== '--background')
    ], {
      cwd: processTarget.cwd(),
      env: { ...processTarget.env, [CHILD_FLAG]: '1' },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, output, 'ipc']
    })
  } finally {
    closeSync(output)
  }

  // The parent exits only after the child owns the checkout and completes preflight. A spawn
  // event alone cannot establish that setup or duplicate-instance checks succeeded.
  return await new Promise((resolve, reject) => {
    let settled = false
    const signalHandlers = new Map()

    /** Removes startup-only listeners; the detached runner owns itself after acknowledgement. */
    function cleanup() {
      clearTimeout(timer)
      for (const [signal, handler] of signalHandlers) {
        processTarget.removeListener(signal, handler)
      }
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('message', onMessage)
      if (child.connected) child.disconnect()
      child.unref()
    }

    function fail(error) {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      cleanup()
      reject(error)
    }

    function onError(error) {
      fail(error)
    }
    function onExit(code, signal) {
      fail(new Error(`devkit: background runner exited during startup (${signal ?? code}). See ${logPath}`))
    }
    function onMessage(message) {
      if (settled || message?.type !== 'devkit-preflight-ready') return
      settled = true
      cleanup()
      resolve({ pid: child.pid, logPath })
    }

    const timer = setTimeout(() => {
      fail(new Error(`devkit: background startup timed out. See ${logPath}`))
    }, startupTimeoutMs)
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      const handler = () => fail(new Error(`devkit: background startup cancelled by ${signal}. See ${logPath}`))
      signalHandlers.set(signal, handler)
      processTarget.once(signal, handler)
    }
    child.once('error', onError)
    child.once('exit', onExit)
    child.on('message', onMessage)
  })
}

/** Consumes the inherited child flag so an API background option does not recursively detach. */
export function isBackgroundChild() {
  const child = process.env[CHILD_FLAG] === '1'
  delete process.env[CHILD_FLAG]
  return child
}

/** Announces setup completion after the caller has had a turn to start its servers. */
export function reportBackgroundReady() {
  setImmediate(() => {
    if (process.connected) process.send({ type: 'devkit-preflight-ready' })
  })
}
