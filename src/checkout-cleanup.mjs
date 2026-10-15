/** Archive cleanup deliberately needs neither Compose interpolation nor installed app dependencies. */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { checkoutIdentity } from './checkout-identity.mjs'
import { acquireCheckoutRunner, stopCheckoutRunner } from './checkout-runner.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { releaseProxy } from './proxy.mjs'

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.status}`)
  }
  return result.stdout.trim()
}

function canonical(directory) {
  return realpathSync(directory)
}

/** Missing/malformed entries must never turn an unavailable reference check into permission. */
export function checkoutWorkspaceReferences(workspaces, root) {
  if (!Array.isArray(workspaces)) throw new Error('devkit: invalid Paseo workspace list')
  const checkout = canonical(root)
  return workspaces.filter((workspace) => {
    if (!workspace || typeof workspace.cwd !== 'string' || !path.isAbsolute(workspace.cwd)) {
      throw new Error('devkit: Paseo returned a workspace without an absolute cwd')
    }
    // A stale unrelated workspace may no longer exist; lexical containment still protects it.
    let cwd = path.resolve(workspace.cwd)
    try { cwd = canonical(cwd) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const relative = path.relative(checkout, cwd)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

export function paseoWorkspaces({ env = process.env, run = execute } = {}) {
  const candidates = env.PASEO_CLI ? [env.PASEO_CLI] : ['paseo-plus-plus', 'paseo']
  // Only fall back for a missing executable. A failed daemon query must fail closed.
  for (const command of candidates) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5_000, env })
    if (result.error?.code === 'ENOENT') continue
    const args = ['workspace', 'ls', '--background', '--json']
    // Teardown runs inside the daemon; prefer its explicit home over inherited remote targeting.
    if (env.PASEO_HOME) args.push('--home', env.PASEO_HOME)
    else if (env.PASEO_HOST) args.push('--host', env.PASEO_HOST)
    return JSON.parse(run(command, args))
  }
  throw new Error('devkit: cannot check active workspaces; install the Paseo CLI or set PASEO_CLI')
}

/** Only declared private volumes are eligible, even when shared caches carry this project label. */
export function cleanupVolumeNames(identity, project) {
  const names = [
    `${identity.composeProject}-database`,
    ...project.cleanup.volumes.map((name) => name.replace('{project}', identity.composeProject))
  ]
  return [...new Set(names)]
}

function resources(identity, names, run) {
  const filter = `label=com.docker.compose.project=${identity.composeProject}`
  const lines = (value) => value.split('\n').filter(Boolean)
  const containers = lines(run('docker', ['ps', '-aq', '--filter', filter]))
  const networks = lines(run('docker', ['network', 'ls', '-q', '--filter', filter]))
  // Listing first makes an absent volume idempotent without treating daemon failure as absence.
  const existing = new Set(lines(run('docker', ['volume', 'ls', '--format', '{{.Name}}'])))
  const volumes = names.filter((name) => existing.has(name))
  for (const name of volumes) {
    const [volume] = JSON.parse(run('docker', ['volume', 'inspect', name]))
    if (volume?.Labels?.['com.docker.compose.project'] !== identity.composeProject) {
      throw new Error(`devkit: refusing to remove volume ${name}: checkout ownership does not match`)
    }
  }
  return { containers, networks, volumes }
}

export async function cleanupCheckout({
  repoRoot = process.cwd(), config, yes = false, paseo = false, env = process.env,
  log = console.log, identity = checkoutIdentity(repoRoot), load = loadProjectConfig,
  listWorkspaces = () => paseoWorkspaces({ env }), run = execute,
  stopRunner = stopCheckoutRunner, acquireRunner = acquireCheckoutRunner, releaseRoute = releaseProxy
} = {}) {
  if (!identity) throw new Error('devkit: cleanup requires a Git checkout')
  if (identity.isPrimary) throw new Error('devkit: cleanup refuses primary checkouts; use the project dev:down command to stop them')
  if (paseo && (!env.PASEO_WORKTREE_PATH || canonical(env.PASEO_WORKTREE_PATH) !== canonical(identity.toplevel))) {
    throw new Error('devkit: --paseo requires a matching PASEO_WORKTREE_PATH from the teardown hook')
  }
  const referenced = () => paseo && checkoutWorkspaceReferences(listWorkspaces(), identity.toplevel).length > 0
  if (referenced()) {
    log('[devkit] preserving checkout resources: another active Paseo workspace still references this worktree')
    return { preserved: true }
  }
  const project = await load(repoRoot)
  const names = cleanupVolumeNames(identity, project)
  const preview = resources(identity, names, run)
  log(`[devkit] ${yes ? 'cleaning' : 'would clean'} ${identity.composeProject}: ${preview.containers.length} containers, ${preview.networks.length} networks, volumes: ${preview.volumes.join(', ') || '(none)'}`)
  if (!yes) {
    log('[devkit] preview only; pass --yes to permanently remove this worktree’s private development data')
    return preview
  }
  await stopRunner(config, identity)
  const lease = acquireRunner(config, identity)
  try {
    // Recheck after waiting for a runner. The lease blocks Devkit from starting this checkout
    // during cleanup; Paseo itself owns the final directory/reference check and removal.
    if (referenced()) {
      log('[devkit] preserving data: a Paseo workspace now references this worktree')
      return { preserved: true }
    }
    const current = resources(identity, names, run)
    if (current.containers.length) {
      run('docker', ['stop', ...current.containers])
      run('docker', ['rm', ...current.containers])
    }
    if (current.networks.length) run('docker', ['network', 'rm', ...current.networks])
    if (!releaseRoute(config, identity)) throw new Error('devkit: could not release the checkout proxy route')
    if (referenced()) throw new Error('devkit: a Paseo workspace reopened this worktree; data removal cancelled')
    // No force: Docker refuses any volume still mounted by another container.
    for (const volume of current.volumes) run('docker', ['volume', 'rm', volume])
    log('[devkit] removed private checkout resources; shared caches and baselines retained')
    return current
  } finally {
    lease.release()
  }
}
