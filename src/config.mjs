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
 * `DEVKIT_CONFIG_DIR` overrides it, which is what the tests use and what lets one machine run two
 * independent stacks (a throwaway one on another proxy port) without touching the real install.
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
    /** One shared Compose project for the proxy and supported database services. */
    infraProject: marker.infraProject ?? 'devkit-infra',
    /** Where the infra stack was installed. Shared across projects, so it lives outside any repo. */
    infraDir: expandHome(marker.infraDir ?? path.join(configDir, 'infra')),
    /** Traefik watches this directory and hot-reloads; one generated file per running checkout. */
    routesDir: expandHome(marker.routesDir ?? path.join(configDir, 'routes')),
    /** Where `data/` baselines are stored, one tarball per clone. */
    baselineDir: expandHome(marker.baselineDir ?? path.join(configDir, 'baselines')),
    proxyPort: marker.proxyPort ?? 80,
    postgres: {
      host: marker.postgres?.host ?? '127.0.0.1',
      port: marker.postgres?.port ?? 5432,
      user: marker.postgres?.user ?? 'postgres',
      password: marker.postgres?.password ?? 'postgres'
    },
    mariadb: {
      host: marker.mariadb?.host ?? '127.0.0.1',
      port: marker.mariadb?.port ?? 3307,
      user: marker.mariadb?.user ?? 'root',
      password: marker.mariadb?.password ?? 'root',
      volume: marker.mariadb?.volume ?? 'devkit-mariadb'
    },
    /** Refresh nag threshold for the `data/` + database baseline. */
    baselineMaxAgeDays: marker.baselineMaxAgeDays ?? 14
  }
}

function expandHome(value) {
  return value.startsWith('~') ? path.join(homedir(), value.slice(1)) : value
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
    name: databaseName,
    host,
    port,
    user,
    password,
    url: checkoutConnectionUrl(config, databaseName, engine)
  }
}
