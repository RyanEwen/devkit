/** Opens a checkout after its proxied route becomes healthy. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)

export function checkoutBrowserUrls(origin, browser) {
  const base = `${origin.replace(/\/$/, '')}/`
  return {
    openUrl: new URL(browser.path.replace(/^\//, ''), base).href,
    healthUrl: new URL((browser.healthPath ?? browser.path).replace(/^\//, ''), base).href
  }
}

export function isVsCodeTerminal(env = process.env) {
  return env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_IPC_HOOK_CLI)
}

/** Starts a detached waiter so preflight never delays the project's actual server process. */
export function scheduleBrowserOpen(openUrl, healthUrl, { spawnImpl = spawn, env = process.env } = {}) {
  if (env.DEVKIT_OPEN_BROWSER === '0') return false
  const editorOpen = isVsCodeTerminal(env)
  const child = spawnImpl(process.execPath, [modulePath, '--wait', openUrl, healthUrl], {
    detached: true,
    env,
    // Surface a failed editor handoff instead of silently losing the browser request.
    stdio: editorOpen ? ['ignore', 'inherit', 'inherit'] : 'ignore'
  })
  child.unref()
  return true
}

/** Finds VS Code Server's native URL bridge from the environment inherited by its terminal. */
export function vsCodeBrowserHelper(env = process.env, { existsSyncImpl = existsSync } = {}) {
  if (!env.VSCODE_IPC_HOOK_CLI) return null
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

async function waitAndOpen(openUrl, healthUrl, {
  fetchImpl = fetch,
  spawnImpl = spawn,
  log = console.log,
  env = process.env,
  timeoutMs = 120_000,
  pollMs = 500
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(healthUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(2_000)
      })
      if (response.ok) {
        const { command, args } = browserCommand(openUrl, { env })
        const browser = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
        browser.unref()
        return true
      }
    } catch {
      // The route and server normally become reachable at different moments during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return false
}

if (process.argv[1] === modulePath && process.argv[2] === '--wait') {
  await waitAndOpen(process.argv[3], process.argv[4])
}
