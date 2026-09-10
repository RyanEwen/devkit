/**
 * Resolves a project's database engine/version to one long-lived local server profile.
 *
 * The original unversioned services remain the defaults so existing data and ports do not move.
 * Explicit alternate tags are allocated once in database-profiles.json and then keep the same
 * loopback port, Compose project and named volume across projects, restarts and Devkit upgrades.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_DATABASE_VERSIONS = {
  postgres: '16-bookworm',
  mariadb: '12.3.2'
}

const PORT_START = { postgres: 5540, mariadb: 3340 }
const ABANDONED_LOCK_MS = 30_000

export function databaseProfile(config, project, { sleep = sleepSync } = {}) {
  const engine = project?.database?.engine ?? 'postgres'
  const requested = project?.database?.version ?? null
  const version = requested ?? DEFAULT_DATABASE_VERSIONS[engine]
  if (!DEFAULT_DATABASE_VERSIONS[engine]) throw new Error(`devkit: unsupported database engine ${engine}`)

  if (!requested || requested === DEFAULT_DATABASE_VERSIONS[engine]) {
    return {
      engine,
      version,
      key: `${engine}-default`,
      isDefault: true,
      project: config.infraProject,
      service: engine,
      composeFile: path.join(config.infraDir, 'compose.yml'),
      volume: config[engine].volume ?? `devkit-${engine}`,
      connection: { ...config[engine] }
    }
  }

  const slug = profileSlug(version)
  const key = `${engine}-${slug}`
  const registryPath = path.join(config.configDir, 'database-profiles.json')
  const lockPath = `${registryPath}.lock`
  mkdirSync(config.configDir, { recursive: true })
  acquireLock(lockPath, sleep)
  try {
    const registry = readRegistry(registryPath)
    const existing = registry[key]
    if (existing && (existing.engine !== engine || existing.version !== version)) {
      throw new Error(`devkit: database profile ${key} collides with ${existing.engine}:${existing.version}`)
    }
    const record = existing ?? {
      engine,
      version,
      port: nextPort(config, registry, engine),
      project: `devkit-db-${key}`,
      volume: `devkit-${key}`
    }
    if (!existing) {
      registry[key] = record
      atomicWriteJson(registryPath, registry)
    }
    return {
      ...record,
      key,
      isDefault: false,
      service: 'database',
      composeFile: path.join(config.infraDir, `${engine}.yml`),
      connection: { ...config[engine], port: record.port, volume: record.volume }
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

/** Returns a config whose selected engine points at the resolved profile. */
export function selectDatabaseProfile(config, project, options) {
  const profile = databaseProfile(config, project, options)
  return {
    ...config,
    [profile.engine]: profile.connection,
    databaseProfile: profile
  }
}

export function profileSlug(version) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    throw new Error('devkit: database version must be an exact Docker image tag')
  }
  return version.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function nextPort(config, registry, engine) {
  const used = new Set(Object.values(registry).filter((item) => item.engine === engine).map((item) => item.port))
  used.add(config[engine].port)
  let port = PORT_START[engine]
  while (used.has(port) || !loopbackPortAvailable(port)) port += 1
  return port
}

function loopbackPortAvailable(port) {
  const probe = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    'import net from "node:net"; const s=net.createServer(); s.once("error",e=>process.exit(e.code === "EADDRINUSE" ? 1 : 0)); s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)))',
    String(port)
  ], { timeout: 2_000 })
  return probe.status === 0
}

function readRegistry(filename) {
  if (!existsSync(filename)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object')
    }
    for (const [key, record] of Object.entries(parsed)) validateRecord(key, record)
    return parsed
  } catch (error) {
    throw new Error(`devkit: could not read ${filename}: ${error.message}`)
  }
}

function validateRecord(key, record) {
  if (
    !/^(postgres|mariadb)-[a-z0-9-]+$/.test(key) ||
    !record || typeof record !== 'object' ||
    !['postgres', 'mariadb'].includes(record.engine) ||
    typeof record.version !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.version) ||
    !Number.isInteger(record.port) || record.port < 1024 || record.port > 65535 ||
    record.project !== `devkit-db-${key}` ||
    record.volume !== `devkit-${key}`
  ) {
    throw new Error(`invalid database profile ${key}`)
  }
}

function atomicWriteJson(filename, value) {
  const staging = `${filename}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // rename is atomic on the config filesystem and the lock serializes competing allocators.
  renameSync(staging, filename)
}

function acquireLock(lockPath, sleep) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lockPath)
      const fd = openSync(path.join(lockPath, 'owner'), 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`)
      closeSync(fd)
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = lockOwner(lockPath)
      if ((owner?.pid && !processIsAlive(owner.pid)) || (!owner && lockIsOld(lockPath))) {
        rmSync(lockPath, { recursive: true, force: true })
        continue
      }
      sleep(25)
    }
  }
  throw new Error(`devkit: timed out waiting for database profile lock ${lockPath}`)
}

function lockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner'), 'utf8'))
    return Number.isInteger(owner?.pid) && Number.isFinite(owner?.createdAt) ? owner : null
  } catch {
    return null
  }
}

function lockIsOld(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > ABANDONED_LOCK_MS
  } catch {
    return false
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
