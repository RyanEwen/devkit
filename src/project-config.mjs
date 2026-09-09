/**
 * Loads and validates a project's `devkit.config.mjs`: everything devkit cannot derive from a path.
 *
 * The split this file defines is the whole design. devkit owns what is the same everywhere (how a
 * checkout is named, which ports it gets, how its database is cloned, how it is proxied) and knows
 * nothing about any project. A project owns the five things that genuinely differ, and NOTHING
 * else: its ports, the env its dev servers read, its migration table, the data its baseline
 * captures, and any extra doctor checks.
 *
 * Absent config is not an error. A project with no `devkit.config.mjs` gets the defaults, which is
 * a web + api pair with no seeded data, and that is a working setup for most repos.
 *
 * Counterpart: `preflight.mjs`, the only consumer.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONFIG_FILENAME = 'devkit.config.mjs'

/**
 * Every field a project may set, with the default devkit uses when it does not.
 *
 * `env` is a FUNCTION rather than a table because the values a project needs are derived from what
 * devkit just computed (its ports, its database URL, its proxied origin); a static table could only
 * repeat constants, which is the part nobody needs help with.
 */
const DEFAULTS = {
  /** Overrides the name derived from the directory. Rarely wanted; the derivation is usually right. */
  name: null,
  /** Named port offsets within this checkout's block, in order. */
  ports: ['web', 'api'],
  /** The migration bookkeeping table, so `doctor` can report how far a database has been migrated. */
  migrationsTable: '_prisma_migrations',
  /** Repo-relative paths captured alongside the database so a new worktree starts usable. */
  baselinePaths: [],
  /** Returns the environment the project's dev servers need. See `preflight.mjs` for the argument. */
  env: () => ({}),
  /**
   * Extra `devkit doctor` checks, for state only this project knows about (is my sidecar container
   * running the code I am editing?). Each returns `{ state, label, detail, fix }` or nothing.
   */
  checks: []
}

function fail(message) {
  throw new Error(`devkit: ${CONFIG_FILENAME} ${message}`)
}

/** Validates loudly, because a typo here silently changes which ports or database a checkout uses. */
function validate(config) {
  if (config.name != null && typeof config.name !== 'string') fail('`name` must be a string')
  if (!Array.isArray(config.ports) || config.ports.some((port) => typeof port !== 'string')) {
    fail('`ports` must be an array of names, e.g. ["web", "api"]')
  }
  if (config.ports.length === 0) fail('`ports` must name at least one port')
  if (new Set(config.ports).size !== config.ports.length) fail('`ports` must not repeat a name')
  if (config.migrationsTable != null && typeof config.migrationsTable !== 'string') {
    fail('`migrationsTable` must be a string, or null for a project with no migrations')
  }
  if (!Array.isArray(config.baselinePaths)) fail('`baselinePaths` must be an array of repo-relative paths')
  if (typeof config.env !== 'function') fail('`env` must be a function returning an object')
  if (!Array.isArray(config.checks) || config.checks.some((check) => typeof check !== 'function')) {
    fail('`checks` must be an array of functions')
  }
  return config
}

/**
 * Reads `<repoRoot>/devkit.config.mjs`, or returns the defaults when there is none.
 *
 * Async because it is an ESM import; callers are already async at this point.
 */
export async function loadProjectConfig(repoRoot) {
  const configPath = path.join(repoRoot, CONFIG_FILENAME)
  if (!existsSync(configPath)) return { ...DEFAULTS, configPath: null }

  const module = await import(pathToFileURL(configPath).href)
  const provided = module.default
  if (!provided || typeof provided !== 'object') fail('must `export default` an object')

  return validate({ ...DEFAULTS, ...provided, configPath })
}
