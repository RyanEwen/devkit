#!/usr/bin/env node
/**
 * The devkit command line: everything a person does to the shared infrastructure, as opposed to
 * what a project's `npm run dev` does through `preflight()`.
 *
 * Split that way because the two have different rules. `preflight()` runs on every dev start and
 * may only ever REPAIR preconditions idempotently; these commands are destructive or expensive
 * (dropping a database, capturing a baseline, restarting the stack) and must be asked for.
 *
 * Reachable without installing anything globally: consuming projects get it as a `devDependency`
 * bin, so `npx devkit doctor` works in any of them. `bootstrap` additionally links it onto PATH so
 * a directory that is not a project (or is not Node at all) can still drive the machine's stack.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkoutIdentity } from '../src/checkout-identity.mjs'
import { devkitConfig, devkitConfigDir, devkitMarkerPath } from '../src/config.mjs'
import {
  dropDatabase,
  ensureCheckoutDatabase,
  resolveDatabaseIdentity,
  snapshotBaseline
} from '../src/database.mjs'
import { baselineArchivePath, captureDataBaseline, restoreDataBaseline } from '../src/data-baseline.mjs'
import { execFileSync } from 'node:child_process'

import {
  checkoutDatabaseVolumes,
  composeUp,
  databaseCompose,
  probeDocker,
  removeVolume
} from '../src/docker.mjs'
import { selectDatabaseRuntime } from '../src/database-runtime.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'
import { proxyCompose, reconcileProxy } from '../src/proxy.mjs'
import { bootstrapSettings, nginxConfig, traefikConfig } from '../src/host-setup.mjs'
import { runDoctor } from '../src/doctor.mjs'
import { waitForDatabase } from '../src/preflight.mjs'
import { prepareCheckout } from '../src/checkout-prepare.mjs'
import { enterProjectRuntime, runProjectCommand } from '../src/project-runtime.mjs'
import { cleanupCheckout } from '../src/checkout-cleanup.mjs'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = process.cwd()

function fail(message, fix) {
  console.error(`\n  x ${message}`)
  if (fix) console.error(`    ${fix}`)
  process.exit(1)
}

function requireConfig() {
  const config = devkitConfig()
  if (!config) {
    fail(
      `devkit is not enabled on this machine (no marker at ${devkitMarkerPath()})`,
      'Run `devkit bootstrap` once per machine.'
    )
  }
  return config
}

/**
 * One-time machine setup: the shared stack, the marker that switches devkit on, and a PATH link.
 *
 * Writing the marker is the LAST step on purpose. Until it exists every project behaves exactly as
 * it always has, so a bootstrap that fails halfway leaves a working machine rather than one that
 * has opted into infrastructure it does not have.
 */
function bootstrap(args) {
  if (existsSync('/.dockerenv')) {
    fail(
      'this configures the HOST machine, but it is running inside a container',
      'Run it from a terminal on the machine itself, not from a devcontainer.'
    )
  }

  let settings
  try {
    const marker = devkitMarkerPath()
    settings = bootstrapSettings(args, existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {})
  } catch (error) {
    fail(`invalid host settings: ${error.message}`)
  }

  const docker = probeDocker()
  if (!docker.ok) fail(docker.reason, docker.fix)
  console.log(`  + docker ${docker.version}`)

  const configDir = devkitConfigDir()
  const infraDir = path.join(configDir, 'infra')
  for (const dir of [configDir, path.join(configDir, 'routes'), path.join(configDir, 'baselines')]) {
    mkdirSync(dir, { recursive: true })
  }

  // Copied out of node_modules because the proxy is machine-wide.
  mkdirSync(infraDir, { recursive: true })
  for (const filename of ['compose.yml', 'compose.host.yml', 'postgres.yml', 'mariadb.yml']) {
    // Older installed clients always read compose.yml; keep that entry point on the chosen network too.
    const sourceName = filename === 'compose.yml' && settings.proxyNetwork === 'host' ? 'compose.host.yml' : filename
    const source = path.join(packageDir, 'infra', sourceName)
    const target = path.join(infraDir, filename)
    copyFileSync(source, target)
  }
  writeFileSync(path.join(infraDir, 'traefik.yml'), traefikConfig(
    readFileSync(path.join(packageDir, 'infra', 'traefik.yml'), 'utf8'), settings
  ), 'utf8')
  console.log(`  + managed infra refreshed at ${infraDir}`)

  const config = {
    configDir,
    infraProject: 'devkit-infra',
    infraDir,
    routesDir: path.join(configDir, 'routes'),
    baselineDir: path.join(configDir, 'baselines'),
    ...settings
  }

  const proxy = reconcileProxy(config)
  if (!proxy.ok) {
    fail(
      'the shared proxy lifecycle could not be reconciled',
      `Inspect it with: docker compose -p ${config.infraProject} -f ${proxyCompose(config).files[0]} logs`
    )
  }
  console.log(
    proxy.running
      ? '  + proxy refreshed for active routes; it stops when the last one closes'
      : '  + proxy installed and idle; it starts with the first project'
  )

  linkOntoPath('devkit')
  linkOntoPath('devproxy')

  const markerPath = devkitMarkerPath()
  writeFileSync(markerPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  console.log(`  + marker written to ${markerPath}`)

  console.log('\nDone. devkit is on for this machine.\n')
  console.log('Next:')
  console.log('  devkit snapshot              capture a project\'s current dev data as its baseline')
  console.log('  devkit doctor                show the state of every precondition')
  console.log(`  devproxy add <name> <port>   give another dev server a *.${config.preferredDomain} name`)
  if (config.secondaryDomains.length) {
    console.log(`\n  Domains: ${[config.domain, ...config.secondaryDomains].join(', ')}; preferred: ${config.preferredDomain}`)
    console.log('  Restart existing development runners to apply hostnames and application origins.')
  }
}

/**
 * Links a bin onto PATH, replacing a stale link rather than leaving it.
 *
 * Skipped rather than created when ~/.local/bin does not exist: inventing a PATH entry is more than
 * a bootstrap should do, and the message then says so instead of failing.
 */
function linkOntoPath(name) {
  const source = path.join(packageDir, 'bin', `${name}.mjs`)
  if (existsSync(source)) chmodSync(source, 0o755)

  const localBin = path.join(os.homedir(), '.local', 'bin')
  if (!existsSync(localBin)) {
    console.log(`  ! ${localBin} does not exist, so ${name} was not put on your PATH`)
    return
  }
  const link = path.join(localBin, name)
  try {
    if (existsSync(link)) unlinkSync(link)
    symlinkSync(source, link)
    console.log(`  + ${name} linked into ${localBin}`)
  } catch (error) {
    console.log(`  ! could not link ${name}: ${error.message}`)
  }
}

async function snapshot(config) {
  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) fail(`${repoRoot} is not a git checkout`)
  const project = await loadProjectConfig(repoRoot)
  config = selectDatabaseRuntime(config, project, checkout)
  const identity = resolveDatabaseIdentity(checkout, project)
  startDatabase(config, project)

  if (!identity.isPrimary) {
    console.log(`Note: capturing from worktree "${identity.worktreeName}" rather than the primary checkout.`)
  }
  const result = snapshotBaseline(config, identity, project)
  if (!result.ok) fail(`database snapshot failed: ${result.error}`)
  console.log(`  + ${result.baseline} captured from ${result.source} (previous kept as ${result.previous})`)

  if (project.baselinePaths.length === 0) {
    console.log('  + no baselinePaths configured, so only the database was captured')
  } else {
    const captured = captureDataBaseline(config, identity, repoRoot, project.baselinePaths)
    if (captured.ok) console.log(`  + ${baselineArchivePath(config, identity)} (${(captured.bytes / 1_048_576).toFixed(1)} MB)`)
    else console.log(`  ! data capture failed: ${captured.error}`)
  }
  console.log('\nNew checkouts will clone from this. Existing ones are untouched.')
}

async function reset(config, args) {
  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) fail(`${repoRoot} is not a git checkout`)
  const project = await loadProjectConfig(repoRoot)
  config = selectDatabaseRuntime(config, project, checkout)
  const identity = resolveDatabaseIdentity(checkout, project)
  if (identity.isPrimary) {
    fail(
      'refusing to reset the primary checkout',
      'That database is the real dev data a baseline is captured FROM, not a disposable copy.'
    )
  }
  startDatabase(config, project)

  const dropped = dropDatabase(config, identity.databaseName, project)
  if (!dropped.ok) fail(`could not drop ${identity.databaseName}: ${dropped.error}`)

  if (args.includes('--empty')) {
    return console.log(`  + ${identity.databaseName} dropped; the next dev start builds it from migrations`)
  }
  const created = ensureCheckoutDatabase(config, identity, project)
  if (created.error) fail(created.error)
  console.log(`  + ${identity.databaseName} re-created from ${created.sourced}`)
  const restored = restoreDataBaseline(config, identity, repoRoot)
  console.log(restored.ok ? '  + data/ left as-is (delete it and re-run dev to reseed)' : '  + database reset')
}

function startDatabase(config, project) {
  const database = databaseCompose(config)
  const started = composeUp(database.project, database.files, {
    cwd: config.infraDir,
    env: database.env,
    services: [database.service]
  })
  if (!started) fail(`the ${project.database.engine}:${config.databaseRuntime.version} database could not be started`)
  try {
    waitForDatabase(config, project)
  } catch (error) {
    fail(error.message)
  }
}

/**
 * Drops databases whose worktree is gone, found by re-deriving the live set and diffing.
 *
 * Never reads a registry, because there isn't one: names are derived from paths, so "which
 * checkouts exist" is answered by `git worktree list` and nothing can drift out of sync with it.
 */
async function prune(config, args) {
  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) fail(`${repoRoot} is not a git checkout`)
  const project = await loadProjectConfig(repoRoot)
  config = selectDatabaseRuntime(config, project, checkout)
  const identity = resolveDatabaseIdentity(checkout, project)

  const live = new Set(liveComposeProjects())
  const orphans = checkoutDatabaseVolumes(identity.repoName).filter(({ project }) => !live.has(project))
  if (orphans.length === 0) {
    return console.log('Nothing to prune: every checkout database volume has a matching worktree.')
  }
  if (!args.includes('--yes')) {
    console.log('Would remove database volumes:')
    for (const orphan of orphans) console.log(`  ${orphan.name} (${orphan.project})`)
    return console.log('\nRe-run with --yes to actually remove them.')
  }
  for (const orphan of orphans) {
    const removed = removeVolume(orphan.name)
    console.log(removed.ok ? `  + removed ${orphan.name}` : `  ! ${orphan.name}: ${removed.error}`)
  }
}

function liveComposeProjects() {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .map((dir) => checkoutIdentity(dir)?.composeProject)
    .filter(Boolean)
}

async function infra(config) {
  const proxy = proxyCompose(config)
  const proxyStarted = composeUp(proxy.project, proxy.files, {
    cwd: proxy.cwd,
    env: proxy.env,
    services: ['proxy']
  })
  if (!proxyStarted) fail('the shared proxy could not be started', `docker compose -p ${config.infraProject} logs proxy`)

  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) {
    return console.log('  + proxy running')
  }

  const project = await loadProjectConfig(repoRoot)
  config = selectDatabaseRuntime(config, project, checkout)
  const database = databaseCompose(config)
  const databaseStarted = composeUp(database.project, database.files, {
    cwd: config.infraDir,
    env: database.env,
    services: [database.service]
  })
  if (!databaseStarted) fail(`the ${project.database.engine}:${config.databaseRuntime.version} database could not be started`)
  console.log(`  + proxy and ${project.database.engine}:${config.databaseRuntime.version} database running`)
}

/** Prepares checkout-local files and dependencies without starting development infrastructure. */
async function prepare() {
  let result
  try {
    result = await prepareCheckout({ repoRoot })
  } catch (error) {
    fail(`could not prepare this checkout: ${error.message}`)
  }
  if (!result) fail(`${repoRoot} is not a git checkout`)

  if (!result.installation.installed && result.inherited.copied.length === 0) {
    console.log('  + checkout already prepared')
  }
}

const [command, ...args] = process.argv.slice(2)

// Select before preparation or service ownership, including in non-interactive worktree hooks.
try {
  if (command) enterProjectRuntime(repoRoot)
} catch (error) {
  fail(error.message)
}

switch (command) {
  case 'cleanup':
    try {
      const unknown = args.find((arg) => !['--yes', '--paseo'].includes(arg))
      if (unknown) throw new Error(`unknown cleanup option: ${unknown}`)
      await cleanupCheckout({ repoRoot, config: requireConfig(), yes: args.includes('--yes'), paseo: args.includes('--paseo') })
    } catch (error) {
      fail(error.message)
    }
    break
  case 'run':
    try {
      runProjectCommand(args)
    } catch (error) {
      fail(error.message)
    }
    break
  case 'bootstrap':
    bootstrap(args)
    break
  case 'nginx':
    try {
      process.stdout.write(nginxConfig(requireConfig(), args))
    } catch (error) {
      fail(error.message)
    }
    break
  case 'doctor':
    process.exit(await runDoctor({ repoRoot }))
    break
  case 'snapshot':
    await snapshot(requireConfig())
    break
  case 'reset':
    await reset(requireConfig(), args)
    break
  case 'prune':
    await prune(requireConfig(), args)
    break
  case 'infra':
    await infra(requireConfig())
    break
  case 'prepare':
    await prepare()
    break
  default:
    console.log(`devkit gives every checkout and worktree on this machine its own hostname (default: *.localhost),
its own database and its own ports, all derived from its path.

  devkit bootstrap    configure the machine proxy and database definitions
  devkit prepare      materialize this checkout's local files and dependencies
  devkit run <cmd>    run a command using this checkout's .nvmrc and pinned npm
  devkit doctor       the state of every precondition, and the command that fixes each
  devkit snapshot     capture this checkout's dev data as the baseline new ones clone
  devkit reset        drop and re-clone this worktree's database (--empty skips the baseline)
  devkit prune        drop databases whose worktree is gone (--yes to actually drop)
  devkit cleanup      preview private worktree resource removal (--yes removes; --paseo checks active references)
  devkit infra        start the proxy + this checkout's database (proxy only outside a repo)
  devkit nginx        print nginx configuration for the configured domains and public port

Bootstrap routing options (persisted in host.json and preserved on later bootstraps):
  --secondary-domain <suffix>   add secondary domains (repeat for multiple; replaces the saved list)
  --preferred-domain <suffix>   choose a configured domain for browser URLs and application origins
  --domain <suffix>             primary domain (default: localhost)
  --proxy-port <port>           private Traefik listener (default: 80)
  --public-port <port>          browser-facing port (default: proxy port, or 443 for HTTPS)
  --public-scheme <http|https>  browser-facing scheme (default: http)
  --proxy-network <bridge|host> host networking supports native Linux loopback application ports
  --proxy-bind-address <ip>     private listener interface in host mode (default: 127.0.0.1)

nginx options: --upstream <http-origin>, --allow <ip-or-cidr> (repeatable),
  --ssl-certificate <path>, --ssl-certificate-key <path> (required for HTTPS).
  Access defaults to loopback only; add your client subnet with --allow.

A project opts in with a devkit.config.mjs and by calling preflight() from its dev script.
Without the marker that bootstrap writes, devkit does nothing at all.`)
    process.exit(command ? 1 : 0)
}
