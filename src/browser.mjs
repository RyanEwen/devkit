/** Opens a checkout after its proxied route becomes healthy. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)
const bridgeManifestUrl = new URL('../vscode-extension/package.json', import.meta.url)
const bridgeManifest = JSON.parse(readFileSync(bridgeManifestUrl, 'utf8'))
const bridgeExtensionId = `${bridgeManifest.publisher}.${bridgeManifest.name}`
const bridgeVersion = bridgeManifest.version
const bridgeVsix = fileURLToPath(new URL(
  `../vscode-extension/${bridgeManifest.name}-${bridgeVersion}.vsix`,
  import.meta.url
))

/**
 * Resolves an explicit opening request from a runner's arguments or environment.
 * CLI options win over the environment; absent requests leave the browser alone.
 */
export function browserOpenTarget(args = process.argv.slice(2), env = process.env) {
  const option = args.find((arg) => arg === '--open' || arg.startsWith('--open='))
  const value = option === '--open' ? true : option?.slice('--open='.length) ?? env.DEVKIT_OPEN_BROWSER
  return validateBrowserTarget(value)
}

/** Validates runner options before infrastructure starts, returning false for no request. */
export function validateBrowserTarget(value) {
  if (value == null || value === false || value === '0') return false
  if (value === true || value === '1') return 'auto'
  if (['auto', 'native', 'vscode'].includes(value)) return value
  throw new Error('Browser target must be auto, native, or vscode (use --open or --open=<target>)')
}

/** Resolves the configured destination and readiness probe against the checkout origin. */
export function checkoutBrowserUrls(origin, browser) {
  const base = `${origin.replace(/\/$/, '')}/`
  return {
    openUrl: new URL(browser.path.replace(/^\//, ''), base).href,
    healthUrl: new URL((browser.healthPath ?? browser.path).replace(/^\//, ''), base).href
  }
}

export function isVsCodeTerminal(env = process.env) {
  return env.TERM_PROGRAM === 'vscode'
    || Boolean(env.VSCODE_IPC_HOOK_CLI)
    || Boolean(env.VSCODE_GIT_ASKPASS_NODE)
    || Boolean(env.VSCODE_NLS_CONFIG)
}

/** Starts a detached waiter so preflight never delays the project's actual server process. */
export function scheduleBrowserOpen(openUrl, healthUrl, { target = false, spawnImpl = spawn, env = process.env } = {}) {
  target = validateBrowserTarget(target)
  if (!target) return false
  const child = spawnImpl(process.execPath, [modulePath, '--wait', openUrl, healthUrl, target], {
    detached: true,
    env,
    // Keep readiness timeouts and failed handoffs visible for every requested browser.
    stdio: ['ignore', 'inherit', 'inherit']
  })
  child.on?.('error', (error) => {
    console.error(`[devkit] browser waiter failed: ${error.message}`)
  })
  child.unref()
  return true
}

/** Finds VS Code Server's native URL bridge from the environment inherited by its terminal. */
export function vsCodeBrowserHelper(env = process.env, { existsSyncImpl = existsSync } = {}) {
  if (!isVsCodeTerminal(env)) return null
  if (env.BROWSER && existsSyncImpl(env.BROWSER)) return env.BROWSER

  if (env.VSCODE_GIT_ASKPASS_NODE) {
    const helper = path.join(path.dirname(env.VSCODE_GIT_ASKPASS_NODE), 'bin/helpers/browser.sh')
    if (existsSyncImpl(helper)) return helper
  }

  try {
    const messagesFile = JSON.parse(env.VSCODE_NLS_CONFIG ?? '{}').defaultMessagesFile
    if (!messagesFile) return null
    const serverRoot = path.dirname(path.dirname(messagesFile))
    const helper = path.join(serverRoot, 'bin/helpers/browser.sh')
    return existsSyncImpl(helper) ? helper : null
  } catch {
    return null
  }
}

export function browserCommand(url, {
  platform = process.platform,
  env = process.env,
  existsSyncImpl = existsSync
} = {}) {
  const editorHelper = vsCodeBrowserHelper(env, { existsSyncImpl })
  if (editorHelper) return { command: editorHelper, args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return { command: 'cmd.exe', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

export function vsCodeBrowserUri(url, callbackUri = `vscode://${bridgeExtensionId}/open`) {
  const uri = new URL(callbackUri)
  uri.searchParams.set('url', url)
  return uri.href
}

/** Installs or updates the bundled bridge in the remote extension host used by this terminal. */
export function ensureVsCodeBrowserBridge({ spawnSyncImpl = spawnSync } = {}) {
  const listed = spawnSyncImpl('code', ['--list-extensions', '--show-versions'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (listed.status !== 0) return false

  const expected = `${bridgeExtensionId}@${bridgeVersion}`
  if (listed.stdout.split(/\r?\n/).includes(expected)) return true

  const installed = spawnSyncImpl('code', ['--install-extension', bridgeVsix, '--force'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return installed.status === 0
}

/** Uses a URI handler because only extensions can invoke the integrated-browser command. */
export function integratedBrowserCommand(url, {
  env = process.env,
  existsSyncImpl = existsSync,
  spawnSyncImpl = spawnSync
} = {}) {
  const helper = vsCodeBrowserHelper(env, { existsSyncImpl })
  if (!helper || !ensureVsCodeBrowserBridge({ spawnSyncImpl })) return null

  const callbackUri = env.DEVKIT_VSCODE_BROWSER_URI
  if (!callbackUri) return null
  return { command: helper, args: [vsCodeBrowserUri(url, callbackUri)] }
}

/** Opens in the selected browser; an unavailable explicit VS Code target throws. */
export function openBrowser(url, {
  target = 'auto',
  env = process.env,
  platform = process.platform,
  existsSyncImpl = existsSync,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  log = console.log
} = {}) {
  target = validateBrowserTarget(target)
  if (!target) return false

  const integrated = target === 'native'
    ? null
    : integratedBrowserCommand(url, { env, existsSyncImpl, spawnSyncImpl })
  if (!integrated && target === 'vscode') {
    throw new Error('VS Code integrated browser unavailable; relaunch a terminal with the Devkit bridge installed')
  }
  if (!integrated && target === 'auto' && isVsCodeTerminal(env)) {
    log('[devkit] integrated browser bridge unavailable; opening the desktop browser instead')
  }

  const { command, args } = integrated ?? browserCommand(url, { platform, env, existsSyncImpl })
  const browser = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  browser.on?.('error', (error) => {
    log(`[devkit] browser opening failed: ${error.message}`)
  })
  browser.unref()
  return integrated ? 'vscode' : 'native'
}

/** Polls readiness with a bounded deadline, then performs one browser handoff. */
async function waitAndOpen(openUrl, healthUrl, {
  target = 'auto',
  fetchImpl = fetch,
  spawnImpl = spawn,
  log = console.log,
  env = process.env,
  timeoutMs = 120_000,
  pollMs = 500
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let ready = false
    try {
      const response = await fetchImpl(healthUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(2_000)
      })
      ready = response.ok
    } catch {
      // The route and server normally become reachable at different moments during startup.
    }
    if (ready) {
      openBrowser(openUrl, { target, env, spawnImpl, log })
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  log(`[devkit] browser opening timed out waiting for ${healthUrl}`)
  return false
}

if (process.argv[1] === modulePath && process.argv[2] === '--wait') {
  try {
    await waitAndOpen(process.argv[3], process.argv[4], { target: process.argv[5] })
  } catch (error) {
    console.error(`[devkit] browser opening failed: ${error.message}`)
    process.exitCode = 1
  }
}
