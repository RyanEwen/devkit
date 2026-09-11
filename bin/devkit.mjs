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

import { checkoutIdentity, deriveCheckoutIdentity, readGitCheckout } from '../src/checkout-identity.mjs'
import { devkitConfig, devkitConfigDir, devkitMarkerPath } from '../src/config.mjs'
import {
  dropDatabase,
  ensureCheckoutDatabase,
  findOrphanDatabases,
  resolveDatabaseIdentity,
  snapshotBaseline
} from '../src/database.mjs'
import { baselineArchivePath, captureDataBaseline, restoreDataBaseline } from '../src/data-baseline.mjs'
import { execFileSync } from 'node:child_process'

import { composeUp, databaseCompose, infraComposeEnv, probeDocker } from '../src/docker.mjs'
import { selectDatabaseProfile } from '../src/database-profile.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'
import { runDoctor } from '../src/doctor.mjs'

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
function bootstrap() {
  if (existsSync('/.dockerenv')) {
    fail(
      'this configures the HOST machine, but it is running inside a container',
      'Run it from a terminal on the machine itself, not from a devcontainer.'
    )
  }

  const docker = probeDocker()
  if (!docker.ok) fail(docker.reason, docker.fix)
  console.log(`  + docker ${docker.version}`)

  const configDir = devkitConfigDir()
  const infraDir = path.join(configDir, 'infra')
  for (const dir of [configDir, path.join(configDir, 'routes'), path.join(configDir, 'baselines')]) {
    mkdirSync(dir, { recursive: true })
  }

  // Copied OUT of node_modules because the stack is machine-wide. These two files are managed by
  // devkit and refreshed on bootstrap so an existing install gains new services. A changed file is
  // retained as `.previous` before replacement; unrelated files in the directory are untouched.
  mkdirSync(infraDir, { recursive: true })
  for (const filename of ['compose.yml', 'postgres.yml', 'mariadb.yml', 'traefik.yml']) {
    const source = path.join(packageDir, 'infra', filename)
    const target = path.join(infraDir, filename)
    if (existsSync(target) && readFileSync(target, 'utf8') !== readFileSync(source, 'utf8')) {
      copyFileSync(target, `${target}.previous`)
    }
    copyFileSync(source, target)
  }
  console.log(`  + managed infra refreshed at ${infraDir}`)

  const config = {
    configDir,
    infraProject: 'devkit-infra',
    infraDir,
    routesDir: path.join(configDir, 'routes'),
    baselineDir: path.join(configDir, 'baselines'),
    proxyPort: 80,
    postgres: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres' },
    mariadb: {
      host: '127.0.0.1',
      port: 3307,
      user: 'root',
      password: 'root',
      volume: 'devkit-mariadb'
    },
    baselineMaxAgeDays: 14
  }

  if (!composeUp(config.infraProject, [path.join(infraDir, 'compose.yml')], {
    cwd: infraDir,
    env: infraComposeEnv(config),
    services: ['proxy']
  })) {
    fail(
      'the shared infrastructure could not be started',
      `Inspect it with: docker compose -p ${config.infraProject} -f ${path.join(infraDir, 'compose.yml')} logs`
    )
  }
  console.log('  + proxy running; project database profiles start on demand')

  linkOntoPath('devkit')
  linkOntoPath('devproxy')

  const markerPath = devkitMarkerPath()
  if (existsSync(markerPath)) {
    console.log(`  + marker already present at ${markerPath} (left as-is)`)
  } else {
    writeFileSync(markerPath, `${JSON.stringify({ enabled: true, ...config }, null, 2)}\n`, 'utf8')
    console.log(`  + marker written to ${markerPath}`)
  }

  console.log('\nDone. devkit is on for this machine.\n')
  console.log('Next:')
  console.log('  devkit snapshot              capture a project\'s current dev data as its baseline')
  console.log('  devkit doctor                show the state of every precondition')
  console.log('  devproxy add <name> <port>   give any other dev server a *.localhost name')
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
  config = selectDatabaseProfile(config, project)
  const identity = resolveDatabaseIdentity(checkout, project)

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
  config = selectDatabaseProfile(config, project)
  const identity = resolveDatabaseIdentity(checkout, project)
  if (identity.isPrimary) {
    fail(
      'refusing to reset the primary checkout',
      'That database is the real dev data a baseline is captured FROM, not a disposable copy.'
    )
  }

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
  config = selectDatabaseProfile(config, project)
  const identity = resolveDatabaseIdentity(checkout, project)

  const orphans = findOrphanDatabases(config, identity, liveDatabaseNames(project), project)
  if (orphans.length === 0) return console.log('Nothing to prune: every worktree database has a matching worktree.')

  if (!args.includes('--yes')) {
    console.log('Would drop:')
    for (const name of orphans) console.log(`  ${name}`)
    return console.log('\nRe-run with --yes to actually drop them.')
  }
  for (const name of orphans) {
    const dropped = dropDatabase(config, name, project)
    console.log(dropped.ok ? `  + dropped ${name}` : `  ! ${name}: ${dropped.error}`)
  }
}

/** Every checkout of this clone that still exists, re-derived rather than read from a registry. */
function liveDatabaseNames(project) {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .map((dir) => readGitCheckout(dir))
    .filter(Boolean)
    .map((checkout) => resolveDatabaseIdentity(deriveCheckoutIdentity(checkout), project).databaseName)
}

async function infra(config) {
  const composeFile = path.join(config.infraDir, 'compose.yml')
  const proxyStarted = composeUp(config.infraProject, [composeFile], {
    cwd: config.infraDir,
    env: infraComposeEnv(config),
    services: ['proxy']
  })
  if (!proxyStarted) fail('the shared proxy could not be started', `docker compose -p ${config.infraProject} logs proxy`)

  const checkout = checkoutIdentity(repoRoot)
  if (!checkout) {
    const defaultsStarted = composeUp(config.infraProject, [composeFile], {
      cwd: config.infraDir,
      env: infraComposeEnv(config),
      services: ['postgres', 'mariadb']
    })
    if (!defaultsStarted) fail('the default database profiles could not be started')
    return console.log('  + proxy and default postgres:16-bookworm and mariadb:12.3.2 profiles running')
  }

  const project = await loadProjectConfig(repoRoot)
  config = selectDatabaseProfile(config, project)
  const database = databaseCompose(config)
  const databaseStarted = composeUp(database.project, database.files, {
    cwd: config.infraDir,
    env: database.env,
    services: [database.service]
  })
  if (!databaseStarted) fail(`the ${project.database.engine}:${config.databaseProfile.version} profile could not be started`)
  console.log(`  + proxy and ${project.database.engine}:${config.databaseProfile.version} profile running`)
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'bootstrap':
    bootstrap()
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
  default:
    console.log(`devkit gives every checkout and worktree on this machine its own *.localhost
hostname, its own database and its own ports, all derived from its path.

  devkit bootstrap    once per machine: install or upgrade the proxy + database definitions
  devkit doctor       the state of every precondition, and the command that fixes each
  devkit snapshot     capture this checkout's dev data as the baseline new ones clone
  devkit reset        drop and re-clone this worktree's database (--empty skips the baseline)
  devkit prune        drop databases whose worktree is gone (--yes to actually drop)
  devkit infra        restart the proxy + this project's database profile (defaults outside a repo)

A project opts in with a devkit.config.mjs and by calling preflight() from its dev script.
Without the marker that bootstrap writes, devkit does nothing at all.`)
    process.exit(command ? 1 : 0)
}
