/**
 * Readout of every precondition devkit depends on, so a problem is something you READ rather than
 * something you hunt for.
 *
 * Deliberately never repairs anything. A project's dev start is what fixes preconditions; this is
 * what you run when it refused to, or when everything is up and behaving oddly. Keeping the two
 * apart means a diagnostic can be run safely at any time, including against a half-broken machine.
 *
 * Every check degrades to a report rather than an exception: a missing Docker daemon must still
 * produce a readout of the things that do not need Docker.
 */
import { existsSync } from 'node:fs'

import { baselineDatabaseName, checkoutIdentity, checkoutPorts } from './checkout-identity.mjs'
import { devkitConfig, devkitMarkerPath } from './config.mjs'
import { appliedMigrationCount, databaseExists, listCheckoutDatabases } from './database.mjs'
import { baselineAgeDays, baselineArchivePath, checkoutNeedsData } from './data-baseline.mjs'
import { composeContainers, postgresSql, probeDocker } from './docker.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { routeFilePath } from './proxy.mjs'

const OK = '+'
const BAD = 'x'
const WARN = '!'

/**
 * Runs every check and prints the readout. Returns the process exit code.
 *
 * A project contributes extra checks through `checks` in its `devkit.config.mjs`: each is called
 * with the same context `env()` receives and returns `{ state, label, detail, fix }`, so a project
 * can report on its own services without this module knowing anything about them.
 */
export async function runDoctor({ repoRoot, log = console.log }) {
  let problems = 0
  const report = (state, label, detail, fix) => {
    if (state === BAD) problems += 1
    log(`${state} ${label.padEnd(18)} ${detail}`)
    if (fix) log(`${' '.repeat(21)}-> ${fix}`)
  }

  const config = devkitConfig()
  if (!config) {
    log('\ndevkit: OFF (every project behaves exactly as it would without it)\n')
    if (process.env.DEVKIT === '0') report(OK, 'reason', 'DEVKIT=0 is set')
    else if (existsSync('/.dockerenv')) report(OK, 'reason', 'running inside a container, where the devcontainer owns ports and networking')
    else report(OK, 'reason', `no marker at ${devkitMarkerPath()}`, 'devkit bootstrap turns it on')
    return 0
  }

  const identity = checkoutIdentity(repoRoot)
  if (!identity) {
    report(BAD, 'checkout', `${repoRoot} is not a git checkout`)
    return 1
  }
  const project = await loadProjectConfig(repoRoot)
  const ports = checkoutPorts(identity, project.ports)

  log('\ndevkit: ON\n')
  report(OK, 'checkout', `${identity.isPrimary ? 'primary' : `worktree ${identity.worktreeName}`} of ${identity.repoName}`)
  report(OK, 'config', project.configPath ?? 'no devkit.config.mjs, using defaults')
  report(OK, 'url', `http://${identity.hostname}   (direct: http://localhost:${ports.web})`)

  const docker = probeDocker()
  if (!docker.ok) {
    report(BAD, 'docker', docker.reason, docker.fix)
    log('\nNothing below can be checked without Docker.\n')
    return 1
  }
  report(OK, 'docker', `daemon ${docker.version}`)

  const running = composeContainers(config.infraProject)
  for (const service of ['proxy', 'postgres']) {
    if (running.includes(service)) report(OK, service, `running in project ${config.infraProject}`)
    else report(BAD, service, 'not running', 'devkit infra')
  }
  if (!running.includes('postgres')) return 1

  if (!postgresSql(config, 'select 1').ok) {
    report(BAD, 'postgres', 'container is up but not accepting queries', `docker compose -p ${config.infraProject} logs postgres`)
    return 1
  }

  if (databaseExists(config, identity.databaseName)) {
    const applied = appliedMigrationCount(config, identity.databaseName, project.migrationsTable)
    report(OK, 'database', applied === null
      ? identity.databaseName
      : `${identity.databaseName}, ${applied} migration(s) applied`)
  } else {
    report(WARN, 'database', `${identity.databaseName} does not exist yet`, 'the next dev start creates it')
  }

  const baseline = baselineDatabaseName(identity)
  const age = baselineAgeDays(config, identity)
  if (!databaseExists(config, baseline)) {
    report(WARN, 'baseline', 'no baseline database yet', 'devkit snapshot (from the primary checkout)')
  } else if (project.baselinePaths.length === 0) {
    report(OK, 'baseline', `${baseline} (database only; this project seeds no files)`)
  } else if (age === null) {
    report(WARN, 'baseline', `${baseline} exists but ${baselineArchivePath(config, identity)} is missing`, 'devkit snapshot')
  } else if (age > config.baselineMaxAgeDays) {
    report(WARN, 'baseline', `${Math.floor(age)} days old`, 'devkit snapshot refreshes it')
  } else {
    report(OK, 'baseline', `${baseline}, ${Math.floor(age)} day(s) old`)
  }

  if (project.baselinePaths.length > 0) {
    if (checkoutNeedsData(repoRoot)) report(WARN, 'seed data', 'missing', 'the next dev start restores it from the baseline')
    else report(OK, 'seed data', 'present')
  }

  const route = routeFilePath(config, identity)
  if (existsSync(route)) report(OK, 'proxy route', route.split('/').pop())
  else report(WARN, 'proxy route', 'not registered', 'written automatically while the dev servers run')

  // Project checks last: they are the specific ones, and they read better after the general state
  // they depend on has been established.
  const context = { identity, ports, config, url: `http://${identity.hostname}`, repoRoot }
  for (const check of project.checks ?? []) {
    try {
      const result = await check(context)
      if (result) report(result.state ?? OK, result.label ?? 'project', result.detail ?? '', result.fix)
    } catch (error) {
      report(WARN, 'project check', `threw: ${error.message}`)
    }
  }

  const siblings = listCheckoutDatabases(config, identity)
  if (siblings.length) log(`\n  ${siblings.length} worktree database(s): ${siblings.join(', ')}`)

  log(problems ? '\nOne or more preconditions need attention.\n' : '\nAll preconditions healthy.\n')
  return problems ? 1 : 0
}

export { OK, BAD, WARN }
