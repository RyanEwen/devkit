/**
 * The gate for devkit, and the only place that decides whether it is on.
 *
 * Contract, and the reason this module exists at all: when devkit is OFF, a project's `npm run dev`
 * must behave exactly as it did before devkit was ever installed. Not "fails gracefully" -- it must
 * not RUN. Every Docker call, database probe and proxy write in this package sits behind
 * `devkitConfig()` returning non-null, so a contributor who clones a consuming repo cannot be
 * broken by machine infrastructure they were never told about. Consuming repos are often public and
 * ship their dev scripts, so that promise is load-bearing rather than theoretical.
 *
 * Three ways it stays off, checked in this order:
 *   - `DEVKIT=0`, the explicit kill switch, so a bad day is one env var from the old behaviour
 *     without editing files;
 *   - running inside a container, because the devcontainer owns ports and networking there and a
 *     marker file leaking in via a mounted home directory must not change that;
 *   - no marker file, which is the case for everybody who has not run `devkit bootstrap`.
 *
 * The marker lives OUTSIDE every repo on purpose: it cannot be committed, cannot reach a public
 * snapshot, and cannot switch itself on in CI or in a fresh clone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * `~/.config/devkit/`, honouring XDG_CONFIG_HOME.
 *
 * `DEVKIT_CONFIG_DIR` overrides it, which keeps tests and disposable installs separate.
 */
export function devkitConfigDir() {
  if (process.env.DEVKIT_CONFIG_DIR) return process.env.DEVKIT_CONFIG_DIR
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'devkit')
}

export function devkitMarkerPath() {
  return path.join(devkitConfigDir(), 'host.json')
}

/** True inside any container. Docker writes `/.dockerenv`; the cgroup check covers podman. */
function inContainer() {
  if (existsSync('/.dockerenv')) return true
  try {
    return /docker|containerd|podman|kubepods/.test(readFileSync('/proc/self/cgroup', 'utf8'))
  } catch {
    return false
  }
}

/**
 * Resolved host-mode settings, or `null` when host mode is off.
 *
 * Never throws: a malformed marker disables host mode with a warning rather than taking down a dev
 * server, because the failure mode of "your JSON has a typo" should not be "you cannot work".
 *
 * `containerCheck` is a test seam, not a way to force the mode on. The container branch is the one
 * rule that cannot be exercised from inside the devcontainer the tests run in, and it is also the
 * rule most worth pinning, so it is injectable. Production callers pass nothing.
 */
export function devkitConfig({ warn = console.warn, containerCheck = inContainer } = {}) {
  if (process.env.DEVKIT === '0') return null
  if (containerCheck()) return null

  const markerPath = devkitMarkerPath()
  if (!existsSync(markerPath)) return null

  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch (error) {
    warn(`[dev] ignoring ${markerPath}: ${error.message}`)
    return null
  }
  if (marker?.enabled === false) return null

  const configDir = devkitConfigDir()
  return {
    markerPath,
    configDir,
    infraProject: 'devkit-infra',
    infraDir: path.join(configDir, 'infra'),
    routesDir: path.join(configDir, 'routes'),
    baselineDir: path.join(configDir, 'baselines'),
    proxyPort: 80,
    postgres: { user: 'postgres', password: 'postgres' },
    mariadb: { user: 'root', password: 'root' },
    baselineMaxAgeDays: 14
  }
}

/**
 * Connection string for one checkout's own database.
 *
 * There is deliberately no admin/maintenance equivalent here: every CREATE/DROP runs inside the
 * selected database container via `docker.mjs`, so nothing on the host needs a database client.
 */
export function checkoutConnectionUrl(config, databaseName, engine = 'postgres') {
  const settings = config[engine]
  const credentials = `${encodeURIComponent(settings.user)}:${encodeURIComponent(settings.password)}`
  const origin = `${settings.host}:${settings.port}/${databaseName}`
  return engine === 'mariadb'
    ? `mysql://${credentials}@${origin}`
    : `postgresql://${credentials}@${origin}?schema=public`
}

/** Complete checkout database descriptor passed to project env functions and doctor checks. */
export function checkoutDatabase(config, databaseName, engine = 'postgres') {
  const { host, port, user, password } = config[engine]
  return {
    engine,
    ...(config.databaseRuntime?.version ? { version: config.databaseRuntime.version } : {}),
    name: databaseName,
    host,
    port,
    user,
    password,
    url: checkoutConnectionUrl(config, databaseName, engine)
  }
}
