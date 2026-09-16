/**
 * The filesystem half of a checkout's seed data, captured and restored alongside the database.
 *
 * Why this exists at all: `LIBRARY_DIR` defaults to `./data/library` (see `apps/api/src/lib/env.ts`),
 * a CHECKOUT-RELATIVE path, so a worktree that cloned the dev database but not `data/` would show a
 * library full of rows pointing at files that are not there. Broken entries are worse than an empty
 * library, so the two halves are captured in the SAME moment and restored together, and the archive
 * mtime is the one timestamp that dates the pair.
 *
 * Copied rather than shared. It is roughly 14 MB (`data/library` is 13 MB across ~3000 files), so
 * duplication is free at any worktree count anyone will actually have, and sharing would let a
 * destructive test in a throwaway branch delete files the main checkout's rows still reference.
 *
 * `data/exports` is deliberately excluded: it is 52 MB, it is regenerable, and no worktree needs it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Paths captured into the baseline, relative to the repo root. A project names its own.
 *
 * EMPTY by default, and deliberately not a guess like `data/`: this decides what a brand new
 * worktree is seeded with, and capturing the wrong tree is worse than capturing none. A project
 * whose database rows reference files on disk has to list those files here, or a cloned database
 * arrives full of rows pointing at nothing, which is a worse first impression than an empty app.
 */
export const DEFAULT_BASELINE_PATHS = []

/** One archive per clone, matching the one baseline database per clone. */
export function baselineArchivePath(config, identity) {
  return path.join(config.baselineDir, `${identity.repoName}${runtimeSuffix(config)}-data.tar.gz`)
}

function runtimeSuffix(config) {
  return config.databaseRuntime ? `-${config.databaseRuntime.key}` : ''
}

// Checkout-local receipt, never part of the shared snapshot. Removing data/ also resets it.
const RESTORE_MARKER = 'data/.devkit-baseline-restored'

/**
 * Whether this checkout has completed a filesystem restore.
 *
 * Application directories are not evidence of a restore: tests and startup can create them
 * before the first preflight, leaving other baseline paths (including identities) unseeded.
 * A receipt avoids both that false positive and resurrecting deliberately deleted files on
 * every startup. Existing checkouts without a receipt receive one non-overwriting restore.
 */
export function checkoutNeedsData(repoRoot) {
  return !existsSync(path.join(repoRoot, RESTORE_MARKER))
}

/** Captures the baseline archive from `repoRoot`, replacing any previous one atomically. */
export function captureDataBaseline(config, identity, repoRoot, paths = DEFAULT_BASELINE_PATHS) {
  const archive = baselineArchivePath(config, identity)
  mkdirSync(path.dirname(archive), { recursive: true })

  const present = paths.filter((relative) => existsSync(path.join(repoRoot, relative)))
  if (present.length === 0) return { ok: false, error: `nothing to capture under ${repoRoot}/data` }

  const staging = `${archive}.tmp`
  const result = spawnSync('tar', ['-czf', staging, '--exclude=' + RESTORE_MARKER, '-C', repoRoot, ...present], { encoding: 'utf8' })
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.error?.message || 'tar failed').trim() }
  }

  const moved = spawnSync('mv', ['-f', staging, archive], { encoding: 'utf8' })
  if (moved.status !== 0) return { ok: false, error: (moved.stderr || 'could not replace the archive').trim() }

  return { ok: true, archive, paths: present, bytes: statSync(archive).size }
}

/** Extracts the baseline archive into `repoRoot`. Never overwrites files that already exist. */
export function restoreDataBaseline(config, identity, repoRoot) {
  const archive = baselineArchivePath(config, identity)
  if (!existsSync(archive)) return { ok: false, missing: true }

  mkdirSync(path.join(repoRoot, 'data'), { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', repoRoot, '--skip-old-files'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.error?.message || 'tar failed').trim() }
  }
  // A failed or interrupted extraction must remain retryable. Record completion only after tar
  // succeeds; skip-old-files preserves checkout edits when a retry follows a partial restore.
  try {
    writeFileSync(path.join(repoRoot, RESTORE_MARKER), 'restored\n')
  } catch (error) {
    return { ok: false, error: `could not record filesystem restore: ${error.message}` }
  }
  return { ok: true, archive, bytes: statSync(archive).size }
}

/**
 * Age of the captured pair in days, or null when nothing has been captured.
 *
 * Dating the pair off the ARCHIVE rather than the database is deliberate: they are captured
 * together, and a file mtime survives a database restart, a volume restore and a server upgrade,
 * none of which say anything about how current the data is.
 */
export function baselineAgeDays(config, identity, { now = Date.now() } = {}) {
  const archive = baselineArchivePath(config, identity)
  if (!existsSync(archive)) return null
  return (now - statSync(archive).mtimeMs) / 86_400_000
}
