/**
 * Registers a running checkout with the shared Traefik proxy, so it answers on its own hostname.
 *
 * One routes directory now serves every project on the machine, so the file and router names have
 * to be unique across projects, not just across a project's worktrees. `identity.slug` already
 * carries the repo name for exactly that reason.
 *
 * How the routing works, and why it is a file rather than a container label: the dev server is a
 * HOST process, not a container, so Traefik's Docker provider cannot discover it. Its file provider
 * watches a directory and hot-reloads, so each running checkout drops one generated file in and
 * removes it on exit. Nothing is hand-maintained and nothing is shared between checkouts.
 *
 * The route always points at `host.docker.internal`, which the infra stack maps to the host gateway
 * so it resolves on Linux/WSL as well as Docker Desktop's own platforms.
 *
 * Counterpart: `infra/compose.yml` (the proxy itself) and `infra/traefik.yml` (which names the
 * directory written here). Changing the directory means changing both.
 */
import {
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { composeContainers, composeDown, composeUp, infraComposeEnv } from './docker.mjs'

const PROXY_LOCK_RETRIES = 4800
const PROXY_LOCK_RETRY_MS = 25

/** One file per checkout, named from the slug so a stale file is obvious and safe to delete. */
export function routeFilePath(config, identity) {
  return path.join(config.routesDir, `${identity.slug}.yml`)
}

/**
 * Writes this checkout's route. Idempotent, and cheap enough to do on every start.
 *
 * Traefik watches the directory, so the route is live within a moment of the write; there is no
 * reload to trigger and no proxy restart, which is what keeps a second checkout starting up from
 * interrupting the first one's session.
 */
export function writeRoute(config, identity, port) {
  mkdirSync(config.routesDir, { recursive: true })
  const name = identity.slug
  const contents = `# Devkit checkout owner pid: ${process.pid}
# Rewritten on every \`npm run dev\`, removed on exit.
http:
  routers:
    ${name}:
      rule: "Host(\`${identity.hostname}\`)"
      service: ${name}
      entryPoints:
        - web
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:${port}"
`
  writeFileSync(routeFilePath(config, identity), contents, 'utf8')
  return routeFilePath(config, identity)
}

/**
 * Removes this checkout's route.
 *
 * Best-effort: a leftover file routes to a port nobody is listening on, which Traefik reports as a
 * bad gateway rather than misrouting to another checkout, so failing to clean up is never dangerous
 * enough to interrupt shutdown.
 */
export function removeRoute(config, identity) {
  try {
    rmSync(routeFilePath(config, identity), { force: true })
  } catch {
    // See above: a stale route cannot misroute, so there is nothing worth reporting here.
  }
}

/** Returns the installed Compose definition for the machine-wide proxy. */
function proxyCompose(config) {
  return {
    project: config.infraProject,
    files: [path.join(config.infraDir, 'compose.yml')],
    cwd: config.infraDir,
    env: infraComposeEnv(config)
  }
}

/** True while a process id still belongs to a live host process. */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Serializes route registration against last-user shutdown across independent project runners.
 *
 * The lock records its owner so an abruptly killed runner cannot block all future starts. Waiting
 * is synchronous because each protected operation is one short Compose invocation and callers are
 * already in synchronous host setup/teardown paths.
 */
function withProxyLock(config, operation) {
  mkdirSync(config.configDir, { recursive: true })
  const lockPath = path.join(config.configDir, 'proxy.lock')
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() })

  for (let attempt = 0; attempt < PROXY_LOCK_RETRIES; attempt += 1) {
    try {
      // Symlink creation publishes the ownership token atomically: waiters can never observe the
      // empty-file window created by opening an exclusive file and writing its contents afterward.
      symlinkSync(owner, lockPath)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      let ownerPid = null
      try {
        const parsedOwner = JSON.parse(readlinkSync(lockPath))
        if (Number.isInteger(parsedOwner?.pid)) ownerPid = parsedOwner.pid
      } catch {
        // A malformed lock is stale. No writer can be mid-publish because symlink creation is atomic.
      }
      if (ownerPid === null || !processIsAlive(ownerPid)) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another waiter may have recovered the same stale lock first.
        }
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROXY_LOCK_RETRY_MS)
      continue
    }

    try {
      return operation()
    } finally {
      // Only remove the lock this invocation created. This guards against a stale-lock recovery
      // racing a paused owner that later resumes after another process has acquired the path.
      try {
        if (readlinkSync(lockPath) === owner) unlinkSync(lockPath)
      } catch {
        // A missing lock is already released; teardown must not fail while reporting that fact.
      }
    }
  }

  throw new Error('devkit: timed out waiting for the shared proxy lifecycle lock')
}

/** Derives the Compose project used by an unleased route from its generated hostname. */
function legacyComposeProject(contents) {
  const hostname = contents.match(/Host\(`([^`]+)\.localhost`\)/)?.[1]
  if (!hostname) return null
  const labels = hostname.split('.')
  if (labels.length === 1) return labels[0]
  const repo = labels.at(-1)
  return `${repo}-wt-${labels.slice(0, -1).join('-')}`
}

/**
 * Names active routes and removes abandoned checkout routes left by killed development runners.
 *
 * New routes carry their owner pid. Routes from pre-0.11.1 installs have no lease, so migration
 * preserves them only while their derived checkout Compose project still has running containers.
 * Explicit `devproxy` routes are permanent configuration and always remain active until removed.
 */
function registeredRoutes(config, { containers = composeContainers } = {}) {
  try {
    const active = []
    for (const file of readdirSync(config.routesDir).filter((name) => name.endsWith('.yml'))) {
      if (file.startsWith('devproxy-')) {
        active.push(file)
        continue
      }

      const routePath = path.join(config.routesDir, file)
      const contents = readFileSync(routePath, 'utf8')
      const ownerPid = Number.parseInt(contents.match(/^# Devkit checkout owner pid: (\d+)$/m)?.[1] ?? '', 10)
      const legacyProject = Number.isInteger(ownerPid) ? null : legacyComposeProject(contents)
      const inUse = Number.isInteger(ownerPid)
        ? processIsAlive(ownerPid)
        : legacyProject !== null && containers(legacyProject).length > 0

      if (inUse) active.push(file)
      else rmSync(routePath, { force: true })
    }
    return active
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Registers a checkout and lazily starts the proxy as one cross-process operation.
 *
 * Writing the route first ensures a simultaneous last-user shutdown sees the new consumer. If
 * Compose fails, the route is rolled back so a failed start cannot keep Docker Desktop awake.
 */
export function acquireProxy(config, identity, port, { start = composeUp } = {}) {
  return withProxyLock(config, () => {
    writeRoute(config, identity, port)
    const compose = proxyCompose(config)
    const started = start(compose.project, compose.files, {
      cwd: compose.cwd,
      env: compose.env,
      services: ['proxy']
    })
    if (!started) removeRoute(config, identity)
    return started
  })
}

/**
 * Releases one checkout route and removes the proxy after its final consumer has gone.
 *
 * Permanent routes created by `devproxy` count as consumers too. This keeps those explicit names
 * working while still allowing a machine with no routes at all to become fully idle.
 */
export function releaseProxy(config, identity, { stop = composeDown, containers = composeContainers } = {}) {
  return withProxyLock(config, () => {
    removeRoute(config, identity)
    if (registeredRoutes(config, { containers }).length > 0) return true

    const compose = proxyCompose(config)
    return stop(compose.project, compose.files, {
      cwd: compose.cwd,
      env: compose.env
    })
  })
}

/**
 * Applies the installed proxy definition without inventing a consumer during bootstrap.
 *
 * Existing routes keep the proxy available and refresh its Compose definition. With no routes,
 * an older always-restarting proxy is removed immediately so the lazy lifecycle takes effect now.
 */
export function reconcileProxy(
  config,
  { start = composeUp, stop = composeDown, containers = composeContainers } = {}
) {
  return withProxyLock(config, () => {
    const compose = proxyCompose(config)
    const running = registeredRoutes(config, { containers }).length > 0
    const action = running ? start : stop
    const options = {
      cwd: compose.cwd,
      env: compose.env,
      ...(running ? { services: ['proxy'] } : {})
    }
    return {
      ok: action(compose.project, compose.files, options),
      running
    }
  })
}
