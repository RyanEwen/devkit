/**
 * Which checkout of each declared dependency THIS checkout uses.
 *
 * A dependency normally resolves to its project's primary checkout (`platform.localhost`). When two
 * branches must be tested together, a checkout can point a dependency at one of that project's
 * linked worktrees instead (`<worktree>.platform.localhost`).
 *
 * Unlike checkout identity, this is a person's explicit choice, so it is recorded: one small JSON
 * file per checkout under the devkit config dir. Keeping it out of the repository means neither
 * project needs another ignored file, and the choice cannot be committed by accident. The file is
 * named by the checkout's `<worktree>.<repo>` name, which is unambiguous because a label cannot
 * contain a dot, and it records the checkout's path so a later worktree that happens to reuse the
 * name never inherits someone else's choice. Archive cleanup removes it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { sanitizeLabel } from './checkout-identity.mjs'

/** The unambiguous per-checkout key: the hostname's checkout part, without any domain. */
function checkoutKey(identity) {
  return identity.isPrimary ? identity.repoName : `${identity.worktreeName}.${identity.repoName}`
}

/** Where this checkout's dependency targets are stored. */
export function dependencyTargetsPath(config, identity) {
  return path.join(config.configDir, 'dependency-targets', `${checkoutKey(identity)}.json`)
}

/**
 * True when `value` is a worktree label exactly as it appears as the first part of that worktree's
 * hostname (`bulk-email-pickup-limits` in `bulk-email-pickup-limits.platform.localhost`).
 */
export function isWorktreeLabel(value) {
  return typeof value === 'string' && value !== '' && sanitizeLabel(value) === value
}

/** The worktree selected for `name` in `targets`, ignoring inherited object properties. */
export function targetFor(targets, name) {
  return Object.hasOwn(targets, name) ? targets[name] : undefined
}

/** The stored selection was made by a checkout at another path: this one moved, or reuses its name. */
export class ForeignDependencyTargetsError extends Error {}

/**
 * Reads this checkout's targets as `{ <dependency name>: <worktree label> }`; `{}` when none are set.
 * A damaged file, or one recorded for a different checkout path, throws rather than silently falling
 * back to the primary checkout, because quietly testing against the wrong branch is worse than a
 * startup that asks for a decision. `devkit use` resolves either by choosing again.
 */
export function readDependencyTargets(config, identity) {
  const file = dependencyTargetsPath(config, identity)
  if (!existsSync(file)) return {}

  const damaged = () => new Error(`devkit: ${file} is damaged; fix it, or delete it to use primary checkouts`)
  let stored
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw damaged()
  }
  const dependencies = stored?.dependencies
  const valid = stored && typeof stored === 'object' && typeof stored.checkout === 'string'
    && dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
    && Object.values(dependencies).every(isWorktreeLabel)
  if (!valid) throw damaged()

  // A moved worktree, or a new one reusing a removed worktree's name, must decide again explicitly.
  if (path.resolve(stored.checkout) !== path.resolve(identity.toplevel)) {
    throw new ForeignDependencyTargetsError(`devkit: ${file} holds dependency selections recorded for ${stored.checkout}, not this checkout (${identity.toplevel}); choose again with \`devkit use <dependency> <worktree>\`, or use primary checkouts with \`devkit use <dependency> --primary\``)
  }
  return Object.fromEntries(Object.entries(dependencies))
}

/**
 * The targets that apply to `dependencies`. Entries for dependencies the project no longer declares
 * are ignored here; `devkit use` lists them so they can be cleared.
 */
export function declaredDependencyTargets(targets, dependencies) {
  const names = new Set(dependencies.map(({ name }) => name))
  return Object.fromEntries(Object.entries(targets).filter(([name]) => names.has(name)))
}

/**
 * Points `name` at worktree `worktree`, or back at the primary checkout when `worktree` is null.
 * Only a declared dependency can be pointed at a worktree; clearing works for any stored name, so
 * an entry left behind by a dependency the project has since removed can still be cleared.
 * Writes atomically and deletes the file once no targets remain. Returns the resulting targets.
 */
export function setDependencyTarget(config, identity, dependencies, name, worktree) {
  const declared = dependencies.some((dependency) => dependency.name === name)
  // Choosing again here is the explicit decision a moved or reused checkout's selection needs.
  const targets = readOwnTargets(config, identity)
  if (worktree === null && !declared && targetFor(targets, name) === undefined) {
    throw new Error(`devkit: no worktree is selected for ${name}, and it is not a dependency of this project`)
  }
  if (worktree !== null && !declared) {
    const names = dependencies.map((dependency) => dependency.name).join(', ') || '(none)'
    throw new Error(`devkit: ${name} is not a dependency of this project; declared: ${names}`)
  }
  if (worktree !== null && !isWorktreeLabel(worktree)) {
    throw new Error(`devkit: ${JSON.stringify(worktree)} is not a worktree label; use the first part of its hostname, e.g. my-branch in my-branch.${name}.localhost`)
  }

  if (worktree === null) delete targets[name]
  else targets[name] = worktree

  const file = dependencyTargetsPath(config, identity)
  if (Object.keys(targets).length === 0) {
    rmSync(file, { force: true })
    return targets
  }

  // Write then rename, so a concurrent dev start never reads a half-written file.
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ checkout: identity.toplevel, dependencies: targets }, null, 2)}\n`)
  renameSync(temporary, file)
  return targets
}

/** True when the stored file holds selections recorded for another checkout path. */
function hasForeignTargets(config, identity) {
  try {
    readDependencyTargets(config, identity)
    return false
  } catch (error) {
    return error instanceof ForeignDependencyTargetsError
  }
}

/** This checkout's targets, discarding a selection recorded for another checkout path. */
function readOwnTargets(config, identity) {
  try {
    return readDependencyTargets(config, identity)
  } catch (error) {
    if (error instanceof ForeignDependencyTargetsError) return {}
    throw error
  }
}

/** Removes this checkout's targets; used when its private resources are cleaned up. */
export function removeDependencyTargets(config, identity) {
  rmSync(dependencyTargetsPath(config, identity), { force: true })
}

/** True unless `pid` is known to have exited. Routes without an owner pid count as running. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Linked worktrees of dependency `name` that currently have a proxy route, read from the route
 * files their dev runners write: `[{ worktree, checkout }]`, where `checkout` is the worktree's
 * path, or null for a route written by a devkit that did not record it yet.
 */
export function runningDependencyWorktrees(config, name, { alive = ownerAlive } = {}) {
  let files
  try {
    files = readdirSync(config.routesDir).filter((file) => file.endsWith('.yml'))
  } catch {
    return []
  }

  const found = new Map()
  for (const file of files) {
    let contents
    try {
      contents = readFileSync(path.join(config.routesDir, file), 'utf8')
    } catch {
      continue
    }
    const pid = Number.parseInt(contents.match(/^# Devkit checkout owner pid: (\d+)$/m)?.[1] ?? '', 10)
    if (!alive(pid)) continue

    let checkout = null
    try {
      checkout = JSON.parse(contents.match(/^# Devkit checkout path: (.+)$/m)?.[1] ?? 'null')
    } catch { /* A malformed comment only loses the path, not the route. */ }

    for (const [, host] of contents.matchAll(/Host\(`([^`]+)`\)/g)) {
      const [label, dependency] = host.split('.')
      if (dependency === name && isWorktreeLabel(label) && host.split('.').length > 2 && !found.has(label)) {
        found.set(label, { worktree: label, checkout: typeof checkout === 'string' ? checkout : null })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.worktree.localeCompare(b.worktree))
}

/** The branch checked out at `checkout`, or null when it cannot be read. */
export function checkoutBranch(checkout) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null
  } catch {
    return null
  }
}

/** Human description of a running worktree: its path and branch when known. */
export function describeWorktree(running, branchOf = checkoutBranch) {
  if (!running?.checkout) return 'path not recorded by its older devkit runner'
  const branch = branchOf(running.checkout)
  return branch ? `${running.checkout}, branch ${branch}` : running.checkout
}

/**
 * The `devkit use` command: lists, selects or clears this checkout's dependency worktrees.
 *   []                       list every dependency and the checkout it resolves to
 *   [name, worktree]         use that dependency's running linked worktree
 *   [name, '--primary']      go back to its primary checkout
 * Selecting requires the worktree to be running, so a typo or an unexpected git worktree name is
 * caught now and the selected checkout's path and branch can be shown. Throws on invalid input.
 */
export async function useDependencyTargets({
  config, identity, project, args, log = console.log, probe, running = runningDependencyWorktrees,
  branchOf = checkoutBranch
}) {
  const usage = 'usage: devkit use [<dependency> <worktree> | <dependency> --primary]'
  if (args.length === 1 || args.length > 2 || args.some((arg, index) => arg.startsWith('-') && !(index === 1 && arg === '--primary'))) {
    throw new Error(usage)
  }

  const before = args.length === 2 ? readOwnTargets(config, identity) : readDependencyTargets(config, identity)
  let changed = false
  if (args.length === 2) {
    const [name, choice] = args
    const worktree = choice === '--primary' ? null : choice
    if (worktree !== null && isWorktreeLabel(worktree)) {
      const available = running(config, name)
      if (!available.some((entry) => entry.worktree === worktree)) {
        const names = available.map((entry) => entry.worktree).join(', ') || 'none'
        throw new Error(`devkit: no running checkout answers as ${worktree}.${name}; running ${name} worktrees: ${names}. Start that worktree's dev server, then run this again.`)
      }
    }
    const foreign = hasForeignTargets(config, identity)
    const after = setDependencyTarget(config, identity, project.dependencies, name, worktree)
    changed = foreign || targetFor(before, name) !== targetFor(after, name)
  }

  const targets = readDependencyTargets(config, identity)
  if (project.dependencies.length === 0 && Object.keys(targets).length === 0) {
    log('  this project declares no dependencies in devkit.config.mjs')
    return
  }

  const declared = declaredDependencyTargets(targets, project.dependencies)
  for (const result of await probe(project.dependencies, { config, targets: declared })) {
    const name = result.dependency.name
    const where = result.worktree
      ? `${result.worktree} worktree (${describeWorktree(running(config, name).find((entry) => entry.worktree === result.worktree), branchOf)})`
      : 'primary checkout'
    const state = result.ok ? 'answering' : `not answering: ${result.detail}`
    log(`  ${result.ok ? '+' : 'x'} ${name.padEnd(18)} ${where}  ${result.url} (${state})`)
  }
  for (const name of Object.keys(targets).filter((name) => !Object.hasOwn(declared, name))) {
    log(`  ! ${name.padEnd(18)} no longer declared by this project; \`devkit use ${name} --primary\` clears it`)
  }
  if (args.length === 2) {
    log(changed ? '\n  Restart this checkout\'s dev server to apply the change.' : '\n  Nothing changed.')
  }
}
