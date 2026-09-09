/**
 * Per-checkout databases inside the ONE shared Postgres of multi-checkout dev mode.
 *
 * Owns the create/clone/snapshot/prune lifecycle. What it is solving: worktrees of one clone sit on
 * different migration heads, so they cannot share a database, but a worktree that starts EMPTY is
 * useless -- you cannot develop against a library with no files in it. So a new checkout is seeded
 * from a baseline snapshot of your real dev data, then `migrate deploy` lays that branch's own
 * migrations on top.
 *
 * The two directions deliberately use different mechanisms, and swapping them breaks:
 *   - dev database -> baseline uses `pg_dump | psql`, because it must work while your dev stack is
 *     connected to the source (measured 1.5s for a 24 MB database);
 *   - baseline -> checkout uses `CREATE DATABASE ... TEMPLATE`, a physical file copy (measured
 *     0.14s), which Postgres refuses if ANYTHING is connected to the template. That is safe here
 *     only because nothing ever connects to the baseline; it is not a general-purpose clone.
 *
 * A cloned database arrives with `_prisma_migrations` already populated, so the migration bootstrap
 * that follows applies only what the branch adds rather than replaying history.
 *
 * Counterpart: `data-baseline.mjs` captures the filesystem half (`data/library` and friends) in the
 * same moment, because rows referencing files that were not copied are worse than an empty library.
 */
import { baselineDatabaseName } from './checkout-identity.mjs'
import { postgresExec, postgresSql, shellQuote } from './docker.mjs'

/** Databases we are allowed to drop during a prune. Anything else on the server is not ours. */
function checkoutDatabasePrefix(identity) {
  return `${identity.repoName}_wt_`
}

export function databaseExists(config, name) {
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
export function ensureCheckoutDatabase(config, identity) {
  const name = identity.databaseName
  if (databaseExists(config, name)) return { created: false, name }

  const baseline = baselineDatabaseName(identity)
  if (databaseExists(config, baseline)) {
    const cloned = postgresSql(config, `CREATE DATABASE "${name}" TEMPLATE "${baseline}"`)
    if (cloned.ok) return { created: true, name, sourced: 'baseline' }
    // A template clone fails when something connected to the baseline (nothing should) or the
    // encoding differs. Fall through to an empty database rather than refusing to start.
    return { created: true, name, sourced: 'empty', warning: cloned.stderr, ...createEmpty(config, name) }
  }
  return { created: true, name, sourced: 'empty', ...createEmpty(config, name) }
}

function createEmpty(config, name) {
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
export function snapshotBaseline(config, identity, { source = identity.databaseName } = {}) {
  const baseline = baselineDatabaseName(identity)
  const previous = `${baseline}_prev`
  const staging = `${baseline}_new`
  const user = config.postgres.user

  if (!databaseExists(config, source)) {
    return { ok: false, error: `source database ${source} does not exist` }
  }

  for (const name of [staging, previous]) {
    const dropped = dropDatabase(config, name)
    if (!dropped.ok) return { ok: false, error: dropped.error }
  }

  const created = postgresSql(config, `CREATE DATABASE "${staging}"`)
  if (!created.ok) return { ok: false, error: created.stderr }

  const copied = postgresExec(
    config,
    `pg_dump -U ${user} --no-owner --no-privileges ${shellQuote(source)} | psql -v ON_ERROR_STOP=1 -q -U ${user} -d ${shellQuote(staging)}`
  )
  if (!copied.ok) {
    dropDatabase(config, staging)
    return { ok: false, error: copied.stderr }
  }

  if (databaseExists(config, baseline)) {
    const renamed = postgresSql(config, `ALTER DATABASE "${baseline}" RENAME TO "${previous}"`)
    if (!renamed.ok) return { ok: false, error: renamed.stderr }
  }
  const promoted = postgresSql(config, `ALTER DATABASE "${staging}" RENAME TO "${baseline}"`)
  if (!promoted.ok) return { ok: false, error: promoted.stderr }

  return { ok: true, baseline, previous, source }
}

/** Drops a database, disconnecting anything still attached. No-op when it does not exist. */
export function dropDatabase(config, name) {
  const result = postgresSql(config, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  return result.ok ? { ok: true } : { ok: false, error: result.stderr }
}

/** Every per-worktree database this clone owns, by naming convention. */
export function listCheckoutDatabases(config, identity) {
  const result = postgresSql(
    config,
    `select datname from pg_database where datname like ${sqlLiteral(`${checkoutDatabasePrefix(identity)}%`)} order by datname`
  )
  if (!result.ok || !result.stdout) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Databases whose worktree is gone.
 *
 * `liveDatabaseNames` is re-derived from `git worktree list` by the caller rather than read from a
 * registry, which is what makes deleting a worktree require no bookkeeping: it simply stops
 * appearing in the derived set.
 */
export function findOrphanDatabases(config, identity, liveDatabaseNames) {
  const live = new Set(liveDatabaseNames)
  return listCheckoutDatabases(config, identity).filter((name) => !live.has(name))
}

/**
 * Applied migration count, or null when the database has no such history yet.
 *
 * The table name is a PARAMETER because it names the migration tool, not the database: Prisma
 * writes `_prisma_migrations`, Drizzle `__drizzle_migrations`, and a project with no migrations at
 * all (a Sequelize `sync()` schema, say) passes null and simply has no count to report.
 */
export function appliedMigrationCount(config, databaseName, table = '_prisma_migrations') {
  if (!table) return null
  const result = postgresSql(
    config,
    `select count(*) from ${table} where finished_at is not null`,
    { database: databaseName }
  )
  return result.ok ? Number.parseInt(result.stdout, 10) : null
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
