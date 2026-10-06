import { spawn, spawnSync } from 'node:child_process'

import { releaseProxy as releaseSharedProxy } from './proxy.mjs'

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
}

const defaultRuntime = {
  process,
  spawn,
  spawnSync
}

/** Adds Compose profiles before an action so profiled services participate in stack teardown. */
function profileArgs(profiles) {
  return profiles.flatMap((profile) => ['--profile', profile])
}

/** Maps a terminating signal to the conventional shell exit status. */
function exitCodeFor(code, signal) {
  if (signal && SIGNAL_EXIT_CODES[signal]) return SIGNAL_EXIT_CODES[signal]
  return code ?? 1
}

/**
 * Owns a checkout Compose stack from the point at which preflight has registered its route.
 *
 * `stop()` tears down every service, including services behind the supplied profiles, while
 * preserving named volumes. `run()` starts one foreground Compose command and guarantees the same
 * teardown after normal exit, failure, Ctrl-C, termination, or a runner startup failure.
 *
 * The runtime option is a test seam; project runners should use the Node defaults.
 */
export function checkoutComposeLifecycle(
  state,
  invocation,
  { profiles = [], runtime = defaultRuntime, releaseProxy = releaseSharedProxy } = {}
) {
  if (!state?.config || !state?.identity) {
    throw new Error('devkit: checkoutComposeLifecycle requires a completed preflight state')
  }
  if (!invocation?.command || !Array.isArray(invocation.args) || !invocation.cwd || !invocation.env) {
    throw new Error('devkit: checkoutComposeLifecycle requires a checkout Compose invocation')
  }

  let stopped = false
  let running = false

  /** Tears down the complete stack once and always removes its proxy route. */
  function stop() {
    if (stopped) return 0
    stopped = true

    let cleanupCode
    let proxyReleased = false
    try {
      const result = runtime.spawnSync(
        invocation.command,
        [
          ...invocation.args,
          ...profileArgs(profiles),
          'down',
          '--remove-orphans'
        ],
        {
          cwd: invocation.cwd,
          env: invocation.env,
          stdio: 'inherit'
        }
      )
      cleanupCode = exitCodeFor(result.status, result.signal)
    } catch (error) {
      console.error(`[devkit] checkout stack cleanup failed: ${error.message}`)
      cleanupCode = 1
    } finally {
      try {
        proxyReleased = releaseProxy(state.config, state.identity)
      } catch (error) {
        console.error(`[devkit] shared proxy cleanup failed: ${error.message}`)
      } finally {
        try {
          state.runner?.release()
        } catch (error) {
          console.error(`[devkit] runner lease cleanup failed: ${error.message}`)
          cleanupCode = 1
        }
      }
    }
    return cleanupCode === 0 && !proxyReleased ? 1 : cleanupCode
  }

  // This covers synchronous setup failures after the lifecycle has been created. `stop` is
  // idempotent, so the normal run path can tear down first without doing duplicate work here.
  // Preflight installs lease cleanup first. Move it after stack cleanup so a new start cannot
  // claim this checkout while the old runner is still removing its containers and route.
  if (state.runner) runtime.process.removeListener('exit', state.runner.release)
  runtime.process.once('exit', stop)
  if (state.runner) runtime.process.once('exit', state.runner.release)

  /** Runs one foreground Compose action and resolves after the full stack has been removed. */
  async function run(args) {
    if (running) throw new Error('devkit: a checkout Compose lifecycle can only run once')
    if (stopped) throw new Error('devkit: a stopped checkout Compose lifecycle cannot run')
    running = true

    let child
    try {
      child = runtime.spawn(
        invocation.command,
        [...invocation.args, ...args],
        {
          cwd: invocation.cwd,
          env: invocation.env,
          stdio: 'inherit'
        }
      )
    } catch (error) {
      stop()
      throw error
    }

    let receivedSignal = null
    const signalHandlers = new Map()
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
      const handler = () => {
        receivedSignal ??= signal
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      }
      signalHandlers.set(signal, handler)
      runtime.process.once(signal, handler)
    }

    function removeSignalHandlers() {
      for (const [signal, handler] of signalHandlers) {
        runtime.process.removeListener(signal, handler)
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false

      child.once('error', (error) => {
        if (settled) return
        settled = true
        removeSignalHandlers()
        stop()
        reject(error)
      })

      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        removeSignalHandlers()
        const cleanupCode = stop()
        const childCode = exitCodeFor(code, receivedSignal ?? signal)
        resolve(childCode === 0 ? cleanupCode : childCode)
      })
    })
  }

  return { run, stop }
}
