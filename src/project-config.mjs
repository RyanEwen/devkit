/**
 * Loads and validates a project's `devkit.config.mjs`: everything devkit cannot derive from a path.
 *
 * The split this file defines is the whole design. devkit owns what is the same everywhere (how a
 * checkout is named, which ports it gets, how its database is cloned, how it is proxied) and knows
 * nothing about any project. A project owns the things that genuinely differ: its ports, the env
 * its dev servers read, its migration table, the data its baseline captures, local files a linked
 * worktree must inherit, and any extra doctor checks.
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
  /** Database backend, exact image tag, and optional database name. */
  database: { engine: 'postgres', version: null, name: null, hostAccess: false },
  /** The migration bookkeeping table, so `doctor` can report how far a database has been migrated. */
  migrationsTable: '_prisma_migrations',
  /** Repo-relative paths captured alongside the database so a new worktree starts usable. */
  baselinePaths: [],
  /** Ignored, repo-relative files copied from the primary checkout when a worktree lacks them. */
  worktreeFiles: [],
  /** Optional checkout-local dependency install, repaired before development infrastructure starts. */
  install: null,
  /** Other Devkit projects that must already answer before this project starts. */
  dependencies: [],
  /** Browser destination to open once this checkout answers, or null to leave the browser alone. */
  browser: null,
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
  if (!config.database || typeof config.database !== 'object' || Array.isArray(config.database)) {
    fail('`database` must be an object with an `engine` and optional `name`')
  }
  if (!['postgres', 'mariadb'].includes(config.database.engine)) {
    fail('`database.engine` must be "postgres" or "mariadb"')
  }
  if (
    config.database.version != null &&
    (typeof config.database.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.database.version))
  ) {
    fail('`database.version` must be an exact Docker image tag containing only letters, numbers, dots, underscores, and hyphens')
  }
  if (config.database.name != null && !/^[a-z0-9_]+$/.test(config.database.name)) {
    fail('`database.name` must contain only lowercase letters, numbers, and underscores')
  }
  if (typeof config.database.hostAccess !== 'boolean') {
    fail('`database.hostAccess` must be a boolean')
  }
  if (config.database.hostAccess && config.ports.length >= 10) {
    fail('`database.hostAccess` reserves the last port in a checkout block, so `ports` may contain at most 9 names')
  }
  if (config.migrationsTable != null && typeof config.migrationsTable !== 'string') {
    fail('`migrationsTable` must be a string, or null for a project with no migrations')
  }
  if (!Array.isArray(config.baselinePaths)) fail('`baselinePaths` must be an array of repo-relative paths')
  if (!Array.isArray(config.worktreeFiles) || config.worktreeFiles.some((file) => typeof file !== 'string')) {
    fail('`worktreeFiles` must be an array of repo-relative paths')
  }
  if (config.install != null) validateInstall(config.install)
  if (!Array.isArray(config.dependencies)) fail('`dependencies` must be an array')
  for (const dependency of config.dependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      fail('each `dependencies` entry must be an object with a `name` and optional `healthPath`')
    }
    if (typeof dependency.name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(dependency.name)) {
      fail('each dependency `name` must be a lowercase hostname label')
    }
    if (dependency.healthPath != null && (typeof dependency.healthPath !== 'string' || !dependency.healthPath.startsWith('/'))) {
      fail('each dependency `healthPath` must start with "/"')
    }
  }
  if (new Set(config.dependencies.map(({ name }) => name)).size !== config.dependencies.length) {
    fail('`dependencies` must not repeat a project name')
  }
  if (config.browser != null) {
    if (!config.browser || typeof config.browser !== 'object' || Array.isArray(config.browser)) {
      fail('`browser` must be an object with a `path` and optional `healthPath`, or null')
    }
    if (typeof config.browser.path !== 'string' || !config.browser.path.startsWith('/')) {
      fail('`browser.path` must start with "/"')
    }
    if (config.browser.healthPath != null && (
      typeof config.browser.healthPath !== 'string' || !config.browser.healthPath.startsWith('/')
    )) {
      fail('`browser.healthPath` must start with "/"')
    }
  }
  if (typeof config.env !== 'function') fail('`env` must be a function returning an object')
  if (!Array.isArray(config.checks) || config.checks.some((check) => typeof check !== 'function')) {
    fail('`checks` must be an array of functions')
  }
  return config
}

/** Validates the narrow, package-manager-agnostic checkout install declaration. */
function validateInstall(install) {
  if (!install || typeof install !== 'object' || Array.isArray(install)) {
    fail('`install` must be an object, or null')
  }
  if (!Array.isArray(install.command) || install.command.length === 0 || install.command.some((part) => typeof part !== 'string' || !part)) {
    fail('`install.command` must be a non-empty array, e.g. ["npm", "ci"]')
  }
  if (!Array.isArray(install.inputs) || install.inputs.length === 0 || install.inputs.some((input) => !isRepoRelativePath(input))) {
    fail('`install.inputs` must be a non-empty array of repo-relative paths')
  }
  if (!isRepoRelativePath(install.output)) {
    fail('`install.output` must be a repo-relative path')
  }
}

function isRepoRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes('..')
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
  if (
    provided.database !== undefined &&
    (!provided.database || typeof provided.database !== 'object' || Array.isArray(provided.database))
  ) {
    fail('`database` must be an object with an `engine` and optional `name`')
  }

  return validate({
    ...DEFAULTS,
    ...provided,
    database: { ...DEFAULTS.database, ...provided.database },
    configPath
  })
}
