/**
 * Docker access for multi-checkout dev mode: probing the daemon, bringing the shared infra stack
 * up, and running commands inside the shared Postgres container.
 *
 * One deliberate decision shapes everything here: **every psql/pg_dump call runs INSIDE the
 * Postgres container**, never on the host. The point of this mode is to avoid installing service
 * packages on the machine, and requiring `postgresql-client` on the host to create a database would
 * concede exactly that. It also removes a whole class of version-skew bug, since the client and
 * server are then always the same build.
 *
 * Nothing here is imported unless `devkitConfig()` returned non-null, so a contributor without
 * any of this infrastructure never reaches a Docker call. See `config.mjs`.
 */
import { spawnSync } from 'node:child_process'

/** Postgres service name inside the infra Compose project. */
export const POSTGRES_SERVICE = 'postgres'

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

/**
 * Whether the Docker daemon is reachable, with the reason when it is not.
 *
 * Docker Desktop is the expected host here: it starts with Windows and exposes the daemon to WSL,
 * so an unreachable daemon almost always means Desktop is not running yet rather than a broken
 * install. The message says so, because "Cannot connect to the Docker daemon" alone sends people
 * to reinstall things.
 */
export function probeDocker() {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (result.error?.code === 'ENOENT') {
    return { ok: false, reason: 'the `docker` CLI is not on PATH', fix: 'Install Docker Desktop and enable WSL integration for this distro.' }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'the Docker daemon is not reachable',
      fix: 'Start Docker Desktop on Windows (Settings -> Resources -> WSL Integration must include this distro).'
    }
  }
  return { ok: true, version: result.stdout.trim() }
}

/** Names of the running containers in a Compose project, empty when the project is down. */
export function composeContainers(project) {
  const result = run('docker', ['compose', '-p', project, 'ps', '--services', '--filter', 'status=running'])
  if (result.status !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Brings the shared infra stack up. Idempotent: Compose no-ops when the containers already match,
 * which is why the preflight can call this on every `npm run dev` without paying for it.
 */
export function composeUp(project, files, { cwd, services = [], env } = {}) {
  const args = ['compose', '-p', project]
  for (const file of files) args.push('-f', file)
  args.push('up', '-d', ...services)
  const result = run('docker', args, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env })
  return result.status === 0
}

/** Environment the infra Compose file interpolates. Keep in sync with `infra/compose.yml`. */
export function infraComposeEnv(config) {
  return {
    PRINTSTREAM_DEV_ROUTES_DIR: config.routesDir,
    PRINTSTREAM_DEV_PROXY_PORT: String(config.proxyPort),
    PRINTSTREAM_DEV_POSTGRES_PORT: String(config.postgres.port),
    PRINTSTREAM_DEV_POSTGRES_USER: config.postgres.user,
    PRINTSTREAM_DEV_POSTGRES_PASSWORD: config.postgres.password
  }
}

/** Resolves a Compose service to its container id, or null when it is not running. */
export function composeContainerId(project, service) {
  const result = run('docker', ['compose', '-p', project, 'ps', '-q', service])
  const id = result.status === 0 ? result.stdout.trim().split('\n')[0] : ''
  return id || null
}

/**
 * Runs a shell command inside the shared Postgres container.
 *
 * `-e PGPASSWORD` is deliberately written WITHOUT a value: that form tells Docker to forward the
 * variable from our own environment, so the password never appears in the `docker` process's argv.
 * Spelling it `-e PGPASSWORD=<value>` would put it in the command line, where any user on the box
 * can read it out of `ps`. It is only a throwaway dev credential, but the habit is the point.
 */
export function postgresExec(config, script, { input } = {}) {
  const containerId = composeContainerId(config.infraProject, POSTGRES_SERVICE)
  if (!containerId) return { ok: false, stderr: 'the shared Postgres container is not running' }

  const result = run(
    'docker',
    ['exec', '-i', '-e', 'PGPASSWORD', containerId, 'sh', '-c', script],
    { input, env: { ...process.env, PGPASSWORD: config.postgres.password } }
  )
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  }
}

/**
 * Runs one SQL statement against the maintenance database and returns trimmed stdout.
 *
 * Callers pass fully-formed SQL. Every identifier this module interpolates comes from
 * `checkout-identity.mjs`, which emits `[a-z0-9_]` only, so there is no injection surface -- but
 * that is a property of the derivation, so do not route user-supplied names through here.
 */
export function postgresSql(config, sql, { database = 'postgres' } = {}) {
  const user = config.postgres.user
  return postgresExec(config, `psql -v ON_ERROR_STOP=1 -U ${user} -d ${database} -tAc ${shellQuote(sql)}`)
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
