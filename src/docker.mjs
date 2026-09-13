/**
 * Docker access for multi-checkout dev mode: probing the daemon, bringing infrastructure up, and
 * running commands inside the checkout-owned database container.
 *
 * One deliberate decision shapes everything here: every database client and dump command runs
 * inside its matching container, never on the host. This avoids host packages and client/server
 * version skew.
 *
 * Nothing here is imported unless `devkitConfig()` returned non-null, so a contributor without
 * any of this infrastructure never reaches a Docker call. See `config.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DATABASE_HOST_COMPOSE = fileURLToPath(new URL('../infra/database-host.yml', import.meta.url))

/** Postgres service name inside the infra Compose project. */
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
  const result = run('docker', [
    'ps', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'status=running', '--format', '{{.Label "com.docker.compose.service"}}'
  ])
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

/** Environment the proxy Compose file interpolates. */
export function infraComposeEnv(config) {
  return {
    DEVKIT_ROUTES_DIR: config.routesDir,
    DEVKIT_PROXY_PORT: String(config.proxyPort)
  }
}

/** Compose invocation for this checkout's database. */
export function databaseCompose(config) {
  const runtime = config.databaseRuntime
  if (!runtime) throw new Error('devkit: database runtime has not been selected')
  const settings = config[runtime.engine]
  return {
    project: runtime.project,
    files: [
      runtime.composeFile,
      ...(runtime.hostPort ? [DATABASE_HOST_COMPOSE] : [])
    ],
    service: runtime.service,
    env: {
      DEVKIT_DATABASE_IMAGE: `${runtime.engine}:${runtime.version}`,
      DEVKIT_DATABASE_USER: settings.user,
      DEVKIT_DATABASE_PASSWORD: settings.password,
      DEVKIT_DATABASE_VOLUME: runtime.volume,
      DEVKIT_BASELINE_DIR: config.baselineDir,
      ...(runtime.hostPort
        ? {
            DEVKIT_DATABASE_HOST_PORT: String(runtime.hostPort),
            DEVKIT_DATABASE_INTERNAL_PORT: runtime.engine === 'mariadb' ? '3306' : '5432'
          }
        : {})
    }
  }
}

/** Resolves a Compose service to its container id, or null when it is not running. */
export function composeContainerId(project, service) {
  const result = run('docker', [
    'ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', 'status=running'
  ])
  const id = result.status === 0 ? result.stdout.trim().split('\n')[0] : ''
  return id || null
}

/** Checkout database volumes belonging to one repository, including stopped Compose projects. */
export function checkoutDatabaseVolumes(repoName) {
  const result = run('docker', [
    'volume', 'ls',
    '--filter', 'label=com.docker.compose.volume=database',
    '--format', '{{.Name}}\t{{.Label "com.docker.compose.project"}}'
  ])
  if (result.status !== 0) return []

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, project] = line.split('\t')
      return { name, project }
    })
    .filter(({ project }) => project === repoName || project.startsWith(`${repoName}-wt-`))
}

/** Removes one explicitly resolved Docker volume, returning Docker's error when it is still used. */
export function removeVolume(name) {
  const result = run('docker', ['volume', 'rm', name])
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: (result.stderr || result.stdout || 'Docker refused the removal').trim() }
}

/**
 * Runs a shell command inside the selected Postgres container.
 *
 * `-e PGPASSWORD` is deliberately written WITHOUT a value: that form tells Docker to forward the
 * variable from our own environment, so the password never appears in the `docker` process's argv.
 * Spelling it `-e PGPASSWORD=<value>` would put it in the command line, where any user on the box
 * can read it out of `ps`. It is only a throwaway dev credential, but the habit is the point.
 */
export function postgresExec(config, script, { input } = {}) {
  const runtime = selectedDatabaseContainer(config, 'postgres')
  const containerId = composeContainerId(runtime.project, runtime.service)
  if (!containerId) return { ok: false, stderr: 'the checkout Postgres container is not running' }

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

/** Runs a command inside the selected MariaDB container without exposing its password in argv. */
export function mariadbExec(config, script, { input } = {}) {
  const runtime = selectedDatabaseContainer(config, 'mariadb')
  const containerId = composeContainerId(runtime.project, runtime.service)
  if (!containerId) return { ok: false, stderr: 'the checkout MariaDB container is not running' }

  const result = run(
    'docker',
    ['exec', '-i', '-e', 'MYSQL_PWD', containerId, 'sh', '-c', script],
    { input, env: { ...process.env, MYSQL_PWD: config.mariadb.password } }
  )
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  }
}

function selectedDatabaseContainer(config, engine) {
  const runtime = config.databaseRuntime
  if (runtime?.engine !== engine) throw new Error(`devkit: ${engine} is not this checkout's database`)
  return runtime
}

/** Runs one MariaDB statement and returns its unheaded, tab-separated output. */
export function mariadbSql(config, sql, { database } = {}) {
  const user = shellQuote(config.mariadb.user)
  const selected = database ? ` ${shellQuote(database)}` : ''
  return mariadbExec(config, `client=$(command -v mariadb || command -v mysql) && "$client" --batch --skip-column-names -u ${user}${selected} -e ${shellQuote(sql)}`)
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
