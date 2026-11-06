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

import { checkoutIdentity, checkoutPorts } from './checkout-identity.mjs'
import { checkoutDatabase, devkitConfig, devkitMarkerPath } from './config.mjs'
import {
  appliedMigrationCount,
  databaseBaselineAgeDays,
  databaseBaselineExists,
  databaseBaselineLabel,
  databaseExists,
  resolveDatabaseIdentity
} from './database.mjs'
import { baselineAgeDays, baselineArchivePath, checkoutNeedsData } from './data-baseline.mjs'
import { composeContainers, mariadbSql, postgresSql, probeDocker } from './docker.mjs'
import { selectDatabaseRuntime } from './database-runtime.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { dependencyOrigins, probeProjectDependencies } from './project-dependencies.mjs'
import { declaredDependencyTargets, readDependencyTargets } from './dependency-targets.mjs'
import { routeFilePath, optionalProxyListeners } from './proxy.mjs'
import { fetchHealth } from './health-request.mjs'
import { checkoutOrigins, containerProxyAddress, publicOrigin } from './host-routing.mjs'

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

  const hostConfig = devkitConfig()
  if (!hostConfig) {
    log('\ndevkit: OFF (every project behaves exactly as it would without it)\n')
    if (process.env.DEVKIT === '0') report(OK, 'reason', 'DEVKIT=0 is set')
    else if (existsSync('/.dockerenv')) report(OK, 'reason', 'running inside a container, where the devcontainer owns ports and networking')
    else report(OK, 'reason', `no marker at ${devkitMarkerPath()}`, 'devkit bootstrap turns it on')
    return 0
  }

  const checkout = checkoutIdentity(repoRoot, hostConfig)
  if (!checkout) {
    report(BAD, 'checkout', `${repoRoot} is not a git checkout`)
    return 1
  }
  const project = await loadProjectConfig(repoRoot)
  const config = selectDatabaseRuntime(hostConfig, project, checkout)
  const identity = resolveDatabaseIdentity(checkout, project)
  const ports = checkoutPorts(identity, project.ports)

  log('\ndevkit: ON\n')
  report(OK, 'checkout', `${identity.isPrimary ? 'primary' : `worktree ${identity.worktreeName}`} of ${identity.repoName}`)
  report(OK, 'config', project.configPath ?? 'no devkit.config.mjs, using defaults')
  report(OK, 'url', `${publicOrigin(identity.hostname, config)}   (server-local: http://localhost:${ports.web})`)
  for (const url of checkoutOrigins(identity, config).slice(1)) report(OK, 'alternate url', url)
  report(OK, 'local listener', `127.0.0.1:${config.proxyPort} (${config.proxyNetwork})`)

  const docker = probeDocker()
  if (!docker.ok) {
    report(BAD, 'docker', docker.reason, docker.fix)
    log('\nNothing below can be checked without Docker.\n')
    return 1
  }
  report(OK, 'docker', `daemon ${docker.version}`)

  const proxyRunning = composeContainers(config.infraProject)
  const databaseService = config.databaseRuntime.service
  const databaseRunning = composeContainers(config.databaseRuntime.project)
  if (proxyRunning.includes('proxy')) report(OK, 'proxy', `running in project ${config.infraProject}`)
  else report(BAD, 'proxy', 'not running', 'the next dev start repairs it')
  for (const listener of [{ service: 'proxy', address: '127.0.0.1', available: true }, ...optionalProxyListeners(config).filter((listener) => listener.enabled !== false)]) {
    const required = listener.service === 'proxy'
    const address = listener.address.includes(':') ? `[${listener.address}]` : listener.address
    let answering = false
    if (listener.available && proxyRunning.includes(listener.service)) {
      try {
        await fetchHealth(`http://${address}:${config.proxyPort}/`, { signal: AbortSignal.timeout(1_000) })
        answering = true // A Traefik 404 still proves this listener accepts HTTP.
      } catch { /* Report below, without making optional listeners fatal. */ }
    }
    report(answering ? OK : required ? BAD : WARN, listener.service,
      `${address}:${config.proxyPort} ${answering ? 'accepting HTTP' : listener.available ? 'not answering' : 'interface unavailable'}`,
      answering ? null : required ? 'the next dev start repairs the loopback proxy' : 'optional listener; local development uses IPv4 loopback')
  }

  // An unreadable selection must not be replaced by the primary checkout: report every dependency
  // as unknown instead, and give project checks no origins rather than possibly wrong ones.
  let targets = null
  try {
    targets = declaredDependencyTargets(readDependencyTargets(config, identity), project.dependencies)
  } catch (error) {
    report(BAD, 'dependency targets', error.message.replace(/^devkit: /, ''))
    for (const dependency of project.dependencies) {
      report(BAD, `needs ${dependency.name}`, 'checkout unknown until the targets file is fixed')
    }
  }
  for (const result of targets ? await probeProjectDependencies(project.dependencies, { config, targets }) : []) {
    const where = result.worktree ? ` (${result.worktree} worktree)` : ''
    report(
      result.ok ? OK : BAD,
      `needs ${result.dependency.name}`,
      `${result.url}${where} (${result.detail})`,
      result.ok
        ? null
        : result.worktree
          ? `start ${result.dependency.name}'s ${result.worktree} worktree, or \`devkit use ${result.dependency.name} --primary\``
          : `start ${result.dependency.name} independently`
    )
  }

  const databaseLabel = `${project.database.engine}:${config.databaseRuntime.version}`
  if (databaseRunning.includes(databaseService)) {
    report(OK, project.database.engine, `${databaseLabel} running in ${config.databaseRuntime.project}`)
  } else report(BAD, project.database.engine, `${databaseLabel} not running`, 'the next dev start starts it')
  if (!databaseRunning.includes(databaseService)) return 1

  const ready = project.database.engine === 'mariadb'
    ? mariadbSql(config, 'select 1').ok
    : postgresSql(config, 'select 1').ok
  if (!ready) {
    report(
      BAD,
      project.database.engine,
      'container is up but not accepting queries',
      `docker compose -p ${config.databaseRuntime.project} logs ${databaseService}`
    )
    return 1
  }

  if (databaseExists(config, identity.databaseName, project)) {
    const applied = appliedMigrationCount(config, identity.databaseName, project.migrationsTable, project)
    report(OK, 'database', applied === null
      ? identity.databaseName
      : `${identity.databaseName}, ${applied} migration(s) applied`)
  } else {
    report(WARN, 'database', `${identity.databaseName} does not exist yet`, 'the next dev start creates it')
  }

  const baseline = databaseBaselineLabel(config, identity, project)
  const age = project.baselinePaths.length > 0
    ? baselineAgeDays(config, identity)
    : databaseBaselineAgeDays(config, identity, project)
  if (!databaseBaselineExists(config, identity, project)) {
    report(WARN, 'baseline', 'no baseline yet', 'devkit snapshot (from the primary checkout)')
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
  const database = checkoutDatabase(config, identity.databaseName, project.database.engine)
  const context = {
    identity,
    ports,
    config,
    database,
    url: publicOrigin(identity.hostname, config),
    urls: checkoutOrigins(identity, config),
    domain: config.preferredDomain,
    dependencyOrigins: targets ? dependencyOrigins(project.dependencies, config, targets) : {},
    proxyAddress: containerProxyAddress(config),
    repoRoot
  }
  for (const check of project.checks ?? []) {
    try {
      const result = await check(context)
      if (result) report(result.state ?? OK, result.label ?? 'project', result.detail ?? '', result.fix)
    } catch (error) {
      report(WARN, 'project check', `threw: ${error.message}`)
    }
  }

  log(problems ? '\nOne or more preconditions need attention.\n' : '\nAll preconditions healthy.\n')
  return problems ? 1 : 0
}

export { OK, BAD, WARN }
