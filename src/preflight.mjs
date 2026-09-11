/**
 * Everything that must be true before a project's dev servers start, and the environment they need.
 *
 * The contract this module keeps: **there are no setup steps, only preconditions.** Each one is
 * checked and repaired on every run, so nothing has an order to remember, nothing can be skipped,
 * and running twice does nothing the second time. A precondition that cannot be repaired (no
 * Docker) stops the run naming the exact command that fixes it, rather than letting a project's
 * watchers start against infrastructure that is not there.
 *
 * Returns `null` before touching Docker, a database, or the filesystem when devkit is off. See
 * `config.mjs` for why that is a hard guarantee rather than best-effort.
 *
 * Counterparts: `infra/compose.yml` (what `ensureInfra` starts) and each project's
 * `devkit.config.mjs` (which supplies the env its servers read).
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { checkoutBrowserUrls, isVsCodeTerminal, scheduleBrowserOpen } from './browser.mjs'
import { checkoutIdentity, checkoutPorts, readGitCheckout } from './checkout-identity.mjs'
import { checkoutDatabase, devkitConfig } from './config.mjs'
import {
  appliedMigrationCount,
  databaseBaselineAgeDays,
  databaseBaselineLabel,
  ensureCheckoutDatabase,
  resolveDatabaseIdentity,
  snapshotBaseline
} from './database.mjs'
import { baselineAgeDays, captureDataBaseline, checkoutNeedsData, restoreDataBaseline } from './data-baseline.mjs'
import { databaseCompose, composeUp, infraComposeEnv, mariadbSql, postgresSql, probeDocker } from './docker.mjs'
import { selectDatabaseProfile } from './database-profile.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { dependencyOrigins, failedProjectDependencies } from './project-dependencies.mjs'
import { writeRoute } from './proxy.mjs'
import { copyWorktreeFiles } from './worktree-files.mjs'

/** Fails the run with a message that names the fix, rather than a stack trace. */
export class PreflightError extends Error {
  constructor(reason, fix) {
    super(fix ? `${reason}\n       fix: ${fix}` : reason)
    this.name = 'PreflightError'
  }
}

/**
 * Runs every precondition and returns what the dev servers need, or `null` when devkit is off.
 *
 * Ordering matters in one place only: the database must exist before the project applies its
 * migrations, which is why this is called before that step rather than alongside it.
 */
export async function preflight({ repoRoot, log = console.log, checkDependencies = true }) {
  const hostConfig = devkitConfig()
  if (!hostConfig) return null

  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) return null

  const project = await loadProjectConfig(repoRoot)
  const config = selectDatabaseProfile(hostConfig, project)
  const identity = resolveDatabaseIdentity(checkout, project)
  const ports = checkoutPorts(identity, project.ports)
  const lines = []

  // Callers that consume one of these files before preflight can invoke inheritWorktreeFiles()
  // early. Everyone else still gets the guarantee here; copying twice is an idempotent no-op.
  const inherited = copyWorktreeFiles({ checkout: readGitCheckout(repoRoot), project })
  for (const file of inherited.copied) lines.push(`${file} inherited from the primary checkout`)
  for (const file of inherited.missing) lines.push(`${file} missing here and in the primary checkout`)

  const docker = probeDocker()
  if (!docker.ok) throw new PreflightError(docker.reason, docker.fix)

  ensureInfra(config, project, log)
  if (checkDependencies) await requireProjectDependencies(config, project)
  waitForDatabase(config, project)

  const provisioned = ensureCheckoutDatabase(config, identity, project)
  if (provisioned.error) throw new PreflightError(`could not create database ${provisioned.name}: ${provisioned.error}`)
  if (provisioned.created) {
    lines.push(
      provisioned.sourced === 'baseline'
        ? `database ${provisioned.name} cloned from ${provisioned.baseline ?? databaseBaselineLabel(config, identity, project)}`
        : `database ${provisioned.name} created EMPTY (no baseline yet -- run \`devkit snapshot\` from the primary checkout)`
    )
    if (provisioned.warning) lines.push(`baseline clone failed, fell back to empty: ${provisioned.warning}`)
  }

  // Only when the project actually seeds files: a project with no `baselinePaths` has nothing on
  // disk to restore, and probing for it would report a missing archive it never wanted.
  if (project.baselinePaths.length > 0 && checkoutNeedsData(repoRoot)) {
    const restored = restoreDataBaseline(config, identity, repoRoot)
    if (restored.ok) lines.push(`data/ restored from baseline (${formatBytes(restored.bytes)})`)
    else if (!restored.missing) lines.push(`data/ could not be restored: ${restored.error}`)
  }

  writeRoute(config, identity, ports.web)

  const age = project.baselinePaths.length > 0
    ? baselineAgeDays(config, identity)
    : databaseBaselineAgeDays(config, identity, project)
  if (age !== null && age > config.baselineMaxAgeDays) {
    lines.push(`baseline is ${Math.floor(age)} days old -- \`devkit snapshot\` refreshes it`)
  }

  const url = `http://${identity.hostname}${config.proxyPort === 80 ? '' : `:${config.proxyPort}`}`
  const directUrl = `http://localhost:${ports.web}`
  // `checkDependencies: false` is used by project `dev:down` commands. Teardown must not schedule
  // a fresh browser tab while it removes the route and containers.
  if (project.browser && checkDependencies) {
    // VS Code recognizes literal localhost URLs, but not Devkit's valid *.localhost hostnames.
    const openOrigin = isVsCodeTerminal() ? directUrl : url
    const browser = checkoutBrowserUrls(url, project.browser, { openOrigin })
    scheduleBrowserOpen(browser.openUrl, browser.healthUrl)
  }
  const engine = project.database.engine
  const database = checkoutDatabase(config, identity.databaseName, engine)
  const databaseUrl = database.url
  const context = {
    identity,
    ports,
    url,
    directUrl,
    database,
    databaseUrl,
    dependencyOrigins: dependencyOrigins(project.dependencies, config.proxyPort),
    configDir: config.configDir
  }

  return {
    ...context,
    config,
    project,
    lines,
    /** Applied-migration count before the project migrates, so a caller can detect a schema move. */
    migrationsBefore: appliedMigrationCount(config, identity.databaseName, project.migrationsTable, project),
    env: { ...baseEnv(context), ...project.env(context) }
  }
}

/** Verifies declared applications are alive but deliberately never starts or manages them. */
async function requireProjectDependencies(config, project) {
  const failures = await failedProjectDependencies(project.dependencies, { proxyPort: config.proxyPort })
  if (failures.length === 0) return

  const failed = failures.map(({ dependency, url, detail }) => `${dependency.name} at ${url} (${detail})`).join(', ')
  const names = failures.map(({ dependency }) => dependency.name).join(', ')
  throw new PreflightError(
    `required Devkit project${failures.length === 1 ? '' : 's'} not running: ${failed}`,
    `start ${names} independently, then run this project again`
  )
}

/**
 * The environment devkit publishes for every project, before the project's own `env()` runs.
 *
 * Only values devkit alone can know: where the database is, what this checkout is called, and the
 * two Vite settings that the PROXY requires rather than the project. Everything else is the
 * project's to name, because only it knows which variables its servers read.
 */
function baseEnv({ identity, ports, url, databaseUrl }) {
  return {
    DATABASE_URL: databaseUrl,
    DEVKIT_URL: url,
    DEVKIT_HOSTNAME: identity.hostname,
    /**
     * The proxy reaches this checkout over `host.docker.internal`, and Docker Desktop's forwarding
     * on Windows/WSL only relays IPv4-bound listeners: Vite's `host: true` binds the IPv6 wildcard,
     * which that path refuses, so the route 502s while the direct port serves fine. Binding all
     * IPv4 interfaces is what the proxy needs and costs nothing here, since these are
     * loopback-published dev servers either way.
     */
    VITE_DEV_HOST: '0.0.0.0',
    /** Vite rejects an unknown Host header, and every request arrives from the proxy carrying it. */
    VITE_DEV_ALLOWED_HOSTS: [identity.hostname, 'localhost', '127.0.0.1'].join(',')
  }
}

/** Brings the shared stack up. Idempotent, so this runs on every start without costing anything. */
function ensureInfra(config, project, log) {
  const composeFile = path.join(config.infraDir, 'compose.yml')
  mkdirSync(config.routesDir, { recursive: true })
  const proxyStarted = composeUp(config.infraProject, [composeFile], {
    cwd: config.infraDir,
    env: infraComposeEnv(config),
    services: ['proxy']
  })
  const database = databaseCompose(config)
  const databaseStarted = composeUp(database.project, database.files, {
    cwd: config.infraDir,
    env: database.env,
    services: [database.service]
  })
  if (!proxyStarted || !databaseStarted) {
    throw new PreflightError(
      `the shared dev infrastructure at ${config.infraDir} could not be started`,
      'run `devkit bootstrap` to (re)install it, or `devkit doctor` to see what is wrong'
    )
  }
  log?.(`[devkit] shared infrastructure ready (${project.database.engine}:${config.databaseProfile.version})`)
}

/** A container accepts TCP before it accepts queries; poll until a trivial query succeeds. */
function waitForDatabase(config, project, { attempts = 30, delayMs = 500 } = {}) {
  const engine = project.database.engine
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((engine === 'mariadb' ? mariadbSql(config, 'select 1') : postgresSql(config, 'select 1')).ok) return
    sleepSync(delayMs)
  }
  throw new PreflightError(
    `the shared ${engine === 'mariadb' ? 'MariaDB' : 'Postgres'} did not become ready`,
    `check \`docker compose -p ${config.databaseProfile.project} logs ${config.databaseProfile.service}\``
  )
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  const mb = bytes / 1_048_576
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Refreshes the baseline after the PRIMARY checkout moves the schema forward.
 *
 * This is the event that matters, not the calendar: a migration reaching the primary checkout is
 * exactly when every future checkout should start from newer data. Worktrees never trigger it,
 * because their schema is a branch's, not the trunk's.
 *
 * Best-effort by contract: it runs after the dev servers are already up, and a failure logs rather
 * than interrupting a working session. `state` is what `preflight()` returned.
 */
export function refreshBaselineAfterMigrations(state, { log = console.log } = {}) {
  if (!state?.identity.isPrimary) return
  const after = appliedMigrationCount(
    state.config,
    state.identity.databaseName,
    state.project.migrationsTable,
    state.project
  )
  if (after === null || state.migrationsBefore === null || after <= state.migrationsBefore) return

  const snapshot = snapshotBaseline(state.config, state.identity, state.project)
  if (!snapshot.ok) {
    log(`[devkit] baseline refresh skipped: ${snapshot.error}`)
    return
  }
  const captured = state.project.baselinePaths.length === 0
    ? { ok: true }
    : captureDataBaseline(state.config, state.identity, state.identity.toplevel, state.project.baselinePaths)
  log(
    captured.ok
      ? `[devkit] baseline refreshed after ${after - state.migrationsBefore} new migration(s); previous kept as ${snapshot.previous}`
      : `[devkit] baseline database refreshed but the data capture failed: ${captured.error}`
  )
}
