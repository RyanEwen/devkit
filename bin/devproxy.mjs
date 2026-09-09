#!/usr/bin/env node
/**
 * Claims a `*.localhost` hostname on the shared dev proxy, for ANY project on the machine.
 *
 * The proxy (infra/compose.yml) was always machine-wide, but only PrintStream could register with
 * it: `scripts/dev/host-mode/proxy.mjs` writes a route per checkout on `npm run dev` and removes it
 * on exit. Every other project on the machine had a running dev server and no way to name it. This
 * is that way, and it is deliberately NOT PrintStream-specific: it takes a hostname and a port and
 * knows nothing else about what is listening.
 *
 * Contract, and the reason this is a separate tool rather than a flag on `npm run dev`:
 *   - A route written here is PERMANENT until removed. PrintStream's are tied to a process
 *     lifetime because a checkout stops existing; a project you gave a name to should still answer
 *     that name after a reboot, so nothing here cleans up on exit.
 *   - It never edits PrintStream's generated files, and its own are prefixed `devproxy-` so the two
 *     sets cannot be confused (or collide: Traefik merges every file in the directory into one
 *     configuration, and two routers sharing a name is a conflict, not an override).
 *   - It reads the routes directory and proxy port from the marker file rather than hardcoding
 *     them, so there is exactly one source of truth for where routes live.
 *
 * Installed OUTSIDE the repo (bootstrap.mjs copies this directory to ~/.config/printstream-dev),
 * for the same reason as the compose file beside it: the machine's proxy must not stop working
 * because a checkout was deleted or switched to a branch that predates it.
 *
 * Counterparts: `infra/traefik.yml` (which names the watched directory) and
 * `scripts/dev/host-mode/proxy.mjs` (the same file format, written per checkout).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const MARKER = path.join(os.homedir(), '.config', 'printstream-dev', 'host.json')
/** Marks the files this tool owns, so `ls` can tell them apart and `rm` cannot delete the others. */
const PREFIX = 'devproxy-'

function fail(message, hint) {
  console.error(`devproxy: ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

function config() {
  if (!existsSync(MARKER)) {
    fail(
      `no dev proxy on this machine (${MARKER} is missing)`,
      'Install it from a PrintStream checkout: npm run dev:bootstrap'
    )
  }
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'))
  } catch (error) {
    fail(`${MARKER} is not readable JSON: ${error.message}`)
  }
}

/**
 * Normalises what the user typed into a hostname the browser will resolve on its own.
 *
 * `.localhost` is appended rather than merely required because typing it every time is noise, but
 * the SUFFIX is not optional: browsers resolve `*.localhost` to loopback with no hosts file and no
 * DNS, and that property is the whole reason this design needs no per-name setup. A name outside it
 * would resolve nowhere and the failure would look like a proxy fault rather than a naming one.
 */
function normalizeHostname(raw) {
  const host = String(raw).trim().toLowerCase().replace(/\.$/, '')
  if (!host) fail('a hostname is required', 'devproxy add <hostname> <port>')
  const full = host.endsWith('.localhost') ? host : `${host}.localhost`
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.localhost$/.test(full)) {
    fail(`"${full}" is not a usable hostname`, 'Labels may hold a-z, 0-9 and hyphens, e.g. issue-123.myapp.localhost')
  }
  return full
}

function normalizePort(raw) {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`"${raw}" is not a port`, 'devproxy add <hostname> <port>')
  return port
}

/** One file per hostname, named from it, so a stale route is obvious and safe to delete by hand. */
function routeFile(cfg, hostname) {
  return path.join(cfg.routesDir, `${PREFIX}${hostname.replace(/[^a-z0-9.-]/g, '-')}.yml`)
}

/** Router and service names must be unique across EVERY file, so they carry the hostname too. */
function routerName(hostname) {
  return `${PREFIX}${hostname.replace(/[^a-z0-9]/g, '-')}`
}

function proxyOrigin(cfg, hostname) {
  return `http://${hostname}${cfg.proxyPort === 80 ? '' : `:${cfg.proxyPort}`}`
}

/**
 * Whether something is listening on the host port.
 *
 * Advisory only: registering a name BEFORE starting the server is a normal order to work in, so a
 * closed port is reported and never refused.
 */
function portAnswers(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (answered) => {
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function add(cfg, [rawHost, rawPort]) {
  const hostname = normalizeHostname(rawHost)
  const port = normalizePort(rawPort)
  mkdirSync(cfg.routesDir, { recursive: true })

  const name = routerName(hostname)
  // `host.docker.internal` rather than 127.0.0.1: the proxy is a CONTAINER, so loopback there is
  // its own. The infra stack maps the name to the host gateway, which is what makes one route file
  // work whether the target is a host process or a container publishing a port to the host.
  writeFileSync(
    routeFile(cfg, hostname),
    `# Written by \`devproxy add ${hostname} ${port}\`. Permanent until \`devproxy rm ${hostname}\`.
http:
  routers:
    ${name}:
      rule: "Host(\`${hostname}\`)"
      service: ${name}
      entryPoints:
        - web
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:${port}"
`,
    'utf8'
  )

  console.log(`  ${proxyOrigin(cfg, hostname)}  ->  http://localhost:${port}`)
  return portAnswers(port).then((answers) => {
    if (!answers) console.log(`  (nothing is listening on ${port} yet; the route is live and will work once something is)`)
  })
}

function remove(cfg, [rawHost]) {
  const hostname = normalizeHostname(rawHost)
  const file = routeFile(cfg, hostname)
  if (!existsSync(file)) {
    // Naming the generated file when one exists, rather than a bare "not found": a PrintStream
    // checkout's route is owned by its `npm run dev`, and deleting it by hand would just come back.
    const generated = path.join(cfg.routesDir, `${hostname.split('.')[0]}.yml`)
    if (existsSync(generated)) {
      fail(
        `${hostname} is registered by a running PrintStream checkout, not by devproxy`,
        `Stop its \`npm run dev\` and the route removes itself (${generated}).`
      )
    }
    fail(`no devproxy route for ${hostname}`, 'devproxy ls shows what is registered')
  }
  rmSync(file, { force: true })
  console.log(`  removed ${hostname}`)
}

async function list(cfg) {
  if (!existsSync(cfg.routesDir)) return console.log('  no routes yet')
  const files = readdirSync(cfg.routesDir).filter((file) => file.endsWith('.yml')).sort()
  if (files.length === 0) return console.log('  no routes yet')

  const rows = []
  for (const file of files) {
    const body = readFileSync(path.join(cfg.routesDir, file), 'utf8')
    const hostname = body.match(/Host\(`([^`]+)`\)/)?.[1] ?? '(unparsed)'
    const port = Number(body.match(/host\.docker\.internal:(\d+)/)?.[1])
    rows.push({
      hostname,
      port,
      owner: file.startsWith(PREFIX) ? 'devproxy' : 'checkout',
      up: Number.isInteger(port) ? await portAnswers(port) : false
    })
  }

  const width = Math.max(...rows.map((row) => row.hostname.length))
  for (const row of rows) {
    console.log(`  ${row.up ? 'up  ' : 'down'}  ${row.hostname.padEnd(width)}  ->  :${row.port}   (${row.owner})`)
  }
  console.log('\n  "checkout" routes are written by a running `npm run dev` and vanish when it stops.')
}

const [command, ...rest] = process.argv.slice(2)
const cfg = config()

switch (command) {
  case 'add':
    await add(cfg, rest)
    break
  case 'rm':
  case 'remove':
    remove(cfg, rest)
    break
  case 'ls':
  case 'list':
    await list(cfg)
    break
  default:
    console.log(`Names a running dev server on this machine, so it answers on a *.localhost hostname
instead of a port you have to remember. Any project, host process or container.

  devproxy add <hostname> <port>   claim a name (permanent until removed)
  devproxy rm <hostname>           release it
  devproxy ls                      what is registered, and whether it answers

  devproxy add myapp 3000          ->  http://myapp.localhost
  devproxy add issue-123.myapp 3001    ->  http://issue-123.myapp.localhost

The .localhost suffix is added when you leave it off, and is not optional: browsers resolve
*.localhost to loopback with no hosts file and no DNS, which is what makes this setup-free.

Routes live in ${cfg.routesDir}
and are picked up within a moment, with no restart of anything.`)
    process.exit(command ? 1 : 0)
}
