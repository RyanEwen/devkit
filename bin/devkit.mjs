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
import { chmodSync, cpSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkoutIdentity, deriveCheckoutIdentity, readGitCheckout } from '../src/checkout-identity.mjs'
import { devkitConfig, devkitConfigDir, devkitMarkerPath } from '../src/config.mjs'
import {
  dropDatabase,
  ensureCheckoutDatabase,
  findOrphanDatabases,
  snapshotBaseline
} from '../src/database.mjs'
import { baselineArchivePath, captureDataBaseline, restoreDataBaseline } from '../src/data-baseline.mjs'
import { execFileSync } from 'node:child_process'

import { composeUp, infraComposeEnv, probeDocker } from '../src/docker.mjs'
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

  // Copied OUT of the package rather than run from inside node_modules: the stack is shared by
  // every project on the machine, so it must not stop working when one project is deleted or its
  // dependencies are reinstalled. Never overwritten, so local edits to the proxy config survive.
  if (existsSync(infraDir)) {
    console.log(`  + infra stack already installed at ${infraDir} (left as-is)`)
  } else {
    cpSync(path.join(packageDir, 'infra'), infraDir, { recursive: true })
    console.log(`  + infra stack installed to ${infraDir}`)
  }

  const config = {
    configDir,
    infraProject: 'devkit-infra',
    infraDir,
    routesDir: path.join(configDir, 'routes'),
    baselineDir: path.join(configDir, 'baselines'),
    proxyPort: 80,
    postgres: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres' },
    baselineMaxAgeDays: 14
  }

  if (!composeUp(config.infraProject, [path.join(infraDir, 'compose.yml')], {
    cwd: infraDir,
    env: infraComposeEnv(config)
  })) {
    fail(
      'the shared infrastructure could not be started',
      `Inspect it with: docker compose -p ${config.infraProject} -f ${path.join(infraDir, 'compose.yml')} logs`
    )
  }
  console.log('  + proxy and postgres running')

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
  const identity = checkoutIdentity(repoRoot)
  if (!identity) fail(`${repoRoot} is not a git checkout`)
  const project = await loadProjectConfig(repoRoot)

  if (!identity.isPrimary) {
    console.log(`Note: capturing from worktree "${identity.worktreeName}" rather than the primary checkout.`)
  }
  const result = snapshotBaseline(config, identity)
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

function reset(config, args) {
  const identity = checkoutIdentity(repoRoot)
  if (!identity) fail(`${repoRoot} is not a git checkout`)
  if (identity.isPrimary) {
    fail(
      'refusing to reset the primary checkout',
      'That database is the real dev data a baseline is captured FROM, not a disposable copy.'
    )
  }

  const dropped = dropDatabase(config, identity.databaseName)
  if (!dropped.ok) fail(`could not drop ${identity.databaseName}: ${dropped.error}`)

  if (args.includes('--empty')) {
    return console.log(`  + ${identity.databaseName} dropped; the next dev start builds it from migrations`)
  }
  const created = ensureCheckoutDatabase(config, identity)
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
function prune(config, args) {
  const identity = checkoutIdentity(repoRoot)
  if (!identity) fail(`${repoRoot} is not a git checkout`)

  const orphans = findOrphanDatabases(config, identity, liveDatabaseNames())
  if (orphans.length === 0) return console.log('Nothing to prune: every worktree database has a matching worktree.')

  if (!args.includes('--yes')) {
    console.log('Would drop:')
    for (const name of orphans) console.log(`  ${name}`)
    return console.log('\nRe-run with --yes to actually drop them.')
  }
  for (const name of orphans) {
    const dropped = dropDatabase(config, name)
    console.log(dropped.ok ? `  + dropped ${name}` : `  ! ${name}: ${dropped.error}`)
  }
}

/** Every checkout of this clone that still exists, re-derived rather than read from a registry. */
function liveDatabaseNames() {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .map((dir) => readGitCheckout(dir))
    .filter(Boolean)
    .map((checkout) => deriveCheckoutIdentity(checkout).databaseName)
}

function infra(config) {
  const started = composeUp(config.infraProject, [path.join(config.infraDir, 'compose.yml')], {
    cwd: config.infraDir,
    env: infraComposeEnv(config)
  })
  if (!started) fail('the shared stack could not be started', `docker compose -p ${config.infraProject} logs`)
  console.log('  + proxy and postgres running')
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
    reset(requireConfig(), args)
    break
  case 'prune':
    prune(requireConfig(), args)
    break
  case 'infra':
    infra(requireConfig())
    break
  default:
    console.log(`devkit gives every checkout and worktree on this machine its own *.localhost
hostname, its own database and its own ports, all derived from its path.

  devkit bootstrap    once per machine: install and start the shared proxy + Postgres
  devkit doctor       the state of every precondition, and the command that fixes each
  devkit snapshot     capture this checkout's dev data as the baseline new ones clone
  devkit reset        drop and re-clone this worktree's database (--empty skips the baseline)
  devkit prune        drop databases whose worktree is gone (--yes to actually drop)
  devkit infra        restart the shared stack, e.g. after Docker Desktop restarted

A project opts in with a devkit.config.mjs and by calling preflight() from its dev script.
Without the marker that bootstrap writes, devkit does nothing at all.`)
    process.exit(command ? 1 : 0)
}
