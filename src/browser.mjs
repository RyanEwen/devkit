/** Opens a checkout in the host browser after its proxied route becomes healthy. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)

export function checkoutBrowserUrls(origin, browser) {
  const base = `${origin.replace(/\/$/, '')}/`
  return {
    openUrl: new URL(browser.path.replace(/^\//, ''), base).href,
    healthUrl: new URL((browser.healthPath ?? browser.path).replace(/^\//, ''), base).href
  }
}

/** Starts a detached waiter so preflight never delays the project's actual server process. */
export function scheduleBrowserOpen(openUrl, healthUrl, { spawnImpl = spawn } = {}) {
  if (process.env.DEVKIT_OPEN_BROWSER === '0') return false
  const child = spawnImpl(process.execPath, [modulePath, '--wait', openUrl, healthUrl], {
    detached: true,
    env: process.env,
    stdio: 'ignore'
  })
  child.unref()
  return true
}

export function browserCommand(url, { platform = process.platform, env = process.env } = {}) {
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
        const { command, args } = browserCommand(openUrl)
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
