/**
 * Per-checkout database lifecycle inside a checkout-owned database service.
 *
 * Owns the create/clone/snapshot/prune lifecycle. What it is solving: worktrees of one clone sit on
 * different migration heads, so they cannot share a database, but a worktree that starts EMPTY is
 * useless -- you cannot develop against a library with no files in it. So a new checkout is seeded
 * from a baseline snapshot of your real dev data, then `migrate deploy` lays that branch's own
 * migrations on top.
 *
 * PostgreSQL and MariaDB both use portable SQL dumps because every checkout has its own server.
 *
 * A clone arrives with its migration bookkeeping populated, so the project's migration bootstrap
 * applies only what the branch adds rather than replaying history.
 *
 * Counterpart: `data-baseline.mjs` captures the filesystem half (`data/library` and friends) in the
 * same moment, because rows referencing files that were not copied are worse than an empty library.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { postgresIdentifier } from './checkout-identity.mjs'
import { mariadbExec, mariadbSql, postgresExec, postgresSql, shellQuote } from './docker.mjs'

function databaseEngine(project) {
  return project?.database?.engine ?? 'postgres'
}

/** Applies a project's database base-name override without changing its hostname or port identity. */
export function resolveDatabaseIdentity(identity, project) {
  const baseName = postgresIdentifier('', project?.database?.name ?? identity.repoName)
  return {
    ...identity,
    databaseBaseName: baseName,
    databaseName: baseName
  }
}

export function databaseExists(config, name, project) {
  if (databaseEngine(project) === 'mariadb') {
    const result = mariadbSql(
      config,
      `select schema_name from information_schema.schemata where schema_name = ${sqlLiteral(name)}`
    )
    return result.ok && result.stdout === name
  }
  const result = postgresSql(config, `select 1 from pg_database where datname = ${sqlLiteral(name)}`)
  return result.ok && result.stdout === '1'
}

/**
 * Ensures this checkout's database exists, cloning the baseline when it does not.
 *
 * Returns what happened so the caller can report it, and `sourced: 'empty'` when there was no
 * baseline to clone. An empty database is a working outcome, not a failure: the migration bootstrap
 * builds the schema and the developer can seed it. It is just not a useful one, so the caller says
 * how to fix it.
 */
export function ensureCheckoutDatabase(config, identity, project) {
  const name = identity.databaseName
  if (databaseExists(config, name, project)) return { created: false, name }

  return databaseEngine(project) === 'mariadb'
    ? ensureMariaDatabase(config, identity, project)
    : ensurePostgresDatabase(config, identity, project)
}

function ensurePostgresDatabase(config, identity, project) {
  const name = identity.databaseName
  const baseline = databaseBaselinePath(config, identity, project)
  if (!existsSync(baseline)) return { created: true, name, sourced: 'empty', ...createEmpty(config, name, project) }

  const created = createEmpty(config, name, project)
  if (created.error) return { created: true, name, sourced: 'empty', ...created }
  const imported = importPostgresDump(config, name, baseline)
  if (imported.ok) return { created: true, name, sourced: 'baseline', baseline }

  dropDatabase(config, name, project)
  return {
    created: true,
    name,
    sourced: 'empty',
    warning: imported.stderr,
    ...createEmpty(config, name, project)
  }
}

function ensureMariaDatabase(config, identity, project) {
  const name = identity.databaseName
  const baseline = mariadbBaselinePath(config, identity)
  if (!existsSync(baseline)) return { created: true, name, sourced: 'empty', ...createEmpty(config, name, project) }

  const created = createEmpty(config, name, project)
  if (created.error) return { created: true, name, sourced: 'empty', ...created }
  const imported = importMariaDump(config, name, baseline)
  if (imported.ok) return { created: true, name, sourced: 'baseline', baseline }

  dropDatabase(config, name, project)
  return {
    created: true,
    name,
    sourced: 'empty',
    warning: imported.stderr,
    ...createEmpty(config, name, project)
  }
}

function createEmpty(config, name, project) {
  if (databaseEngine(project) === 'mariadb') {
    const result = mariadbSql(config, `CREATE DATABASE ${mariadbIdentifier(name)}`)
    return result.ok ? {} : { error: result.stderr }
  }
  const result = postgresSql(config, `CREATE DATABASE "${name}"`)
  return result.ok ? {} : { error: result.stderr }
}

/**
 * Refreshes the baseline from a source database, keeping the previous one as `_prev`.
 *
 * The rollback copy is the whole reason this is safe to run automatically: a baseline captured in
 * the middle of a debugging session is one rename away from being undone, so an automatic refresh
 * can never strand you on data you did not choose.
 */
export function snapshotBaseline(config, identity, project, { source = identity.databaseName } = {}) {
  return databaseEngine(project) === 'mariadb'
    ? snapshotMariaBaseline(config, identity, project, source)
    : snapshotPostgresBaseline(config, identity, project, source)
}

function snapshotPostgresBaseline(config, identity, project, source) {
  if (!databaseExists(config, source, project)) {
    return { ok: false, error: `source database ${source} does not exist` }
  }

  const baseline = databaseBaselinePath(config, identity, project)
  const previous = `${baseline}.prev`
  const staging = `${baseline}.tmp`
  mkdirSync(path.dirname(baseline), { recursive: true })
  rmSync(staging, { force: true })

  const user = shellQuote(config.postgres.user)
  const dumped = postgresExec(
    config,
    `pg_dump -U ${user} --no-owner --no-privileges --file=${shellQuote(containerBaselinePath(staging))} ${shellQuote(source)}`
  )
  if (!dumped.ok) {
    rmSync(staging, { force: true })
    return { ok: false, error: dumped.stderr }
  }

  const rotated = rotateBaseline({ baseline, previous, staging, label: 'PostgreSQL' })
  return rotated.ok ? { ok: true, baseline, previous, source } : rotated
}

function snapshotMariaBaseline(config, identity, project, source) {
  if (!databaseExists(config, source, project)) {
    return { ok: false, error: `source database ${source} does not exist` }
  }

  const baseline = mariadbBaselinePath(config, identity)
  const previous = `${baseline}.prev`
  const staging = `${baseline}.tmp`
  mkdirSync(path.dirname(baseline), { recursive: true })
  rmSync(staging, { force: true })

  const dumped = dumpMariaDatabase(config, source, staging)
  if (!dumped.ok) {
    rmSync(staging, { force: true })
    return { ok: false, error: dumped.stderr }
  }

  const rotated = rotateBaseline({ baseline, previous, staging, label: 'MariaDB' })
  if (!rotated.ok) return rotated

  return { ok: true, baseline, previous, source }
}

function rotateBaseline({ baseline, previous, staging, label }) {
  try {
    rmSync(previous, { force: true })
    if (existsSync(baseline)) renameSync(baseline, previous)
    renameSync(staging, baseline)
    return { ok: true }
  } catch (error) {
    if (!existsSync(baseline) && existsSync(previous)) renameSync(previous, baseline)
    rmSync(staging, { force: true })
    return { ok: false, error: `could not rotate the ${label} baseline: ${error.message}` }
  }
}

/** Drops a database, disconnecting anything still attached. No-op when it does not exist. */
export function dropDatabase(config, name, project) {
  if (databaseEngine(project) === 'mariadb') {
    const result = mariadbSql(config, `DROP DATABASE IF EXISTS ${mariadbIdentifier(name)}`)
    return result.ok ? { ok: true } : { ok: false, error: result.stderr }
  }
  const result = postgresSql(config, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  return result.ok ? { ok: true } : { ok: false, error: result.stderr }
}

/**
 * Applied migration count, or null when the database has no such history yet.
 *
 * The table name is a PARAMETER because it names the migration tool, not the database: Prisma
 * writes `_prisma_migrations`, Drizzle `__drizzle_migrations`, and a project with no migrations at
 * all (a Sequelize `sync()` schema, say) passes null and simply has no count to report.
 */
export function appliedMigrationCount(config, databaseName, table = '_prisma_migrations', project) {
  if (!table) return null
  if (databaseEngine(project) === 'mariadb') {
    const result = mariadbSql(
      config,
      `select count(*) from ${mariadbIdentifier(table)} where finished_at is not null`,
      { database: databaseName }
    )
    return result.ok ? Number.parseInt(result.stdout, 10) : null
  }
  const result = postgresSql(
    config,
    `select count(*) from ${table} where finished_at is not null`,
    { database: databaseName }
  )
  return result.ok ? Number.parseInt(result.stdout, 10) : null
}

/** Whether the selected backend has a baseline that can seed a new checkout. */
export function databaseBaselineExists(config, identity, project) {
  return existsSync(databaseBaselinePath(config, identity, project))
}

/** Age of the portable SQL baseline. */
export function databaseBaselineAgeDays(config, identity, project, { now = Date.now() } = {}) {
  const baseline = databaseBaselinePath(config, identity, project)
  return existsSync(baseline) ? (now - statSync(baseline).mtimeMs) / 86_400_000 : null
}

export function databaseBaselineLabel(config, identity, project) {
  return databaseBaselinePath(config, identity, project)
}

function mariadbBaselinePath(config, identity) {
  return databaseBaselinePath(config, identity, { database: { engine: 'mariadb' } })
}

function databaseBaselinePath(config, identity, project) {
  const engine = databaseEngine(project)
  const label = config.databaseRuntime?.key ?? engine
  return path.join(config.baselineDir, `${identity.repoName}-${label}.sql`)
}

function containerBaselinePath(hostPath) {
  return `/devkit-baselines/${path.basename(hostPath)}`
}

function dumpMariaDatabase(config, name, destination) {
  const user = shellQuote(config.mariadb.user)
  return mariadbExec(
    config,
    `dump=$(command -v mariadb-dump || command -v mysqldump) && "$dump" --single-transaction --routines --events --triggers --hex-blob --result-file=${shellQuote(containerBaselinePath(destination))} -u ${user} ${shellQuote(name)}`
  )
}

function importMariaDump(config, name, source) {
  const user = shellQuote(config.mariadb.user)
  return mariadbExec(
    config,
    `client=$(command -v mariadb || command -v mysql) && "$client" -u ${user} ${shellQuote(name)} < ${shellQuote(containerBaselinePath(source))}`
  )
}

function importPostgresDump(config, name, source) {
  const user = shellQuote(config.postgres.user)
  return postgresExec(
    config,
    `psql -v ON_ERROR_STOP=1 -q -U ${user} -d ${shellQuote(name)} -f ${shellQuote(containerBaselinePath(source))}`
  )
}

function mariadbIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
