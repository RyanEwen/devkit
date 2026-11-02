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
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

import { composeContainers, composeDown, composeUp, composeRemoveServices, infraComposeEnv } from './docker.mjs'

import { processIsAlive, withRuntimeLock } from './runtime-lock.mjs'
import { traefikConfig } from './host-setup.mjs'
import { checkoutHostnames, normalizeHostRouting } from './host-routing.mjs'

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
      rule: "${checkoutHostnames(identity).map((hostname) => `Host(\`${hostname}\`)`).join(' || ')}"
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
export function proxyCompose(config) {
  return {
    project: config.infraProject,
    files: [path.join(config.infraDir, config.proxyNetwork === 'host' ? 'compose.host.yml' : 'compose.yml')],
    cwd: config.infraDir,
    env: infraComposeEnv(config)
  }
}

/** Refresh managed definitions on upgrade, even when bootstrap predates this client. */
export function installProxyDefinitions(config) {
  const sourceDir = fileURLToPath(new URL('../infra/', import.meta.url))
  mkdirSync(config.infraDir, { recursive: true })
  const writeChanged = (name, contents) => {
    const target = path.join(config.infraDir, name)
    if (!existsSync(target) || readFileSync(target, 'utf8') !== contents) writeFileSync(target, contents, 'utf8')
  }
  for (const name of ['compose.yml', 'compose.host.yml']) {
    // Old clients select compose.yml; keep that entry on this machine's chosen network.
    const source = name === 'compose.yml' && config.proxyNetwork === 'host' ? 'compose.host.yml' : name
    writeChanged(name, readFileSync(path.join(sourceDir, source), 'utf8'))
  }
  const template = readFileSync(path.join(sourceDir, 'traefik.yml'), 'utf8')
  for (const [name, listener] of [['traefik.yml', 'local'], ['traefik.ipv6.yml', 'ipv6'], ['traefik.lan.yml', 'lan']]) {
    writeChanged(name, traefikConfig(template, config, listener))
  }
}

function localInterfaces() {
  try { return networkInterfaces() } catch { return {} }
}

export function optionalProxyListeners(config, interfaces = localInterfaces()) {
  config = { ...config, ...normalizeHostRouting(config) }
  const addresses = Object.values(interfaces).flat().map(({ address }) => address)
  const listeners = [{ service: 'proxy-ipv6', available: addresses.includes('::1'), address: '::1' }]
  if (config.proxyNetwork === 'host' && !['127.0.0.1', '::1'].includes(config.proxyBindAddress)) {
    listeners.push({ service: 'proxy-lan', available: addresses.includes(config.proxyBindAddress), address: config.proxyBindAddress })
  }
  if (config.proxyNetwork === 'host' && listeners.length === 1) listeners.push({ service: 'proxy-lan', available: false, enabled: false, address: config.proxyBindAddress })
  return listeners
}

/** Required IPv4 loopback first; each optional listener is a separate failure domain. */
function startProxy(config, {
  start = composeUp, remove = composeRemoveServices, interfaces = localInterfaces(), warn = console.warn
} = {}) {
  config = { ...config, ...normalizeHostRouting(config) }
  installProxyDefinitions(config)
  const compose = proxyCompose(config)
  const options = { cwd: compose.cwd, env: compose.env, wait: true, removeOrphans: true }
  if (!start(compose.project, compose.files, { ...options, services: ['proxy'] })) return false
  for (const listener of optionalProxyListeners(config, interfaces)) {
    if (!listener.available) {
      if (!remove(compose.project, compose.files, { ...options, services: [listener.service] })) {
        warn?.(`[devkit] could not remove optional ${listener.service}; inspect it with devkit doctor`)
      }
      if (listener.enabled === false) continue
      warn?.(`[devkit] optional ${listener.service} unavailable at ${listener.address}; IPv4 localhost remains available`)
    } else if (!start(compose.project, compose.files, { ...options, services: [listener.service] })) {
      warn?.(`[devkit] optional ${listener.service} failed at ${listener.address}; IPv4 localhost remains available`)
    }
  }
  return true
}

/** Repair existing dependency routes before probing them, without registering a new checkout. */
export function ensureProxy(config, options = {}) {
  return withRuntimeLock(config, 'proxy', () => startProxy(config, options))
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
export function acquireProxy(config, identity, port, options = {}) {
  return withRuntimeLock(config, 'proxy', () => {
    writeRoute(config, identity, port)
    const started = startProxy(config, options)
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
  return withRuntimeLock(config, 'proxy', () => {
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
  { stop = composeDown, containers = composeContainers, ...options } = {}
) {
  return withRuntimeLock(config, 'proxy', () => {
    const compose = proxyCompose(config)
    installProxyDefinitions(config)
    const running = registeredRoutes(config, { containers }).length > 0
    const stopOptions = {
      cwd: compose.cwd,
      env: compose.env,
    }
    return {
      ok: running ? startProxy(config, options) : stop(compose.project, compose.files, stopOptions),
      running
    }
  })
}
