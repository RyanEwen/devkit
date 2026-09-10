/**
 * Identity of ONE checkout: the name every per-checkout dev resource is derived from.
 *
 * The deliberate counterpart to `repo-cache-dir.mjs`. That module keys on the git COMMON dir so
 * every worktree of a clone SHARES one bucket (validate results are worth pooling). This one keys
 * on the worktree, because the resources it names must never be shared: two checkouts sitting on
 * different migration heads cannot use one database, and two dev servers cannot answer on one
 * hostname. Same clone, opposite granularity, on purpose.
 *
 * Contract: derivation is a pure function of the checkout's path, so nothing is ever allocated,
 * recorded, or reclaimed. Delete a worktree and its names simply stop being produced; `dev:prune`
 * finds orphaned databases by re-deriving the live set and diffing, never by reading a registry.
 * That is the whole reason this is derived rather than assigned: a registry drifts, a hash cannot.
 *
 * Nothing here starts a process or touches Docker, so it stays importable from tests and from
 * `devkit doctor` on a broken machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Postgres limits names to 63 bytes; staying inside it also fits MariaDB's 64-character limit. */
const POSTGRES_IDENTIFIER_LIMIT = 63

/** A DNS label may not exceed this, and Traefik rejects a router rule containing an invalid host. */
const DNS_LABEL_LIMIT = 63

/**
 * Lowercases and strips a path segment down to `[a-z0-9-]`, collapsing runs and trimming the
 * hyphens a leading/trailing strip can leave behind (`.cache` -> `cache`, not `-cache`).
 * Returns `''` for input with nothing usable, which callers treat as "unnameable".
 */
export function sanitizeLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DNS_LABEL_LIMIT)
    .replace(/-+$/g, '')
}

/**
 * Builds a database identifier that is unique for `name` and fits every supported server.
 *
 * Truncation alone is not safe here: `myrepo_wt_` plus two long branch names can agree for the
 * first 63 characters and silently become ONE database. When the full name would overflow, the tail
 * is replaced by a hash of the untruncated name, so distinct inputs stay distinct.
 */
export function postgresIdentifier(prefix, name) {
  const normalized = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const full = `${prefix}${normalized}`
  if (full.length <= POSTGRES_IDENTIFIER_LIMIT) return full
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return `${full.slice(0, POSTGRES_IDENTIFIER_LIMIT - digest.length - 1)}_${digest}`
}

/**
 * Reads the three git facts identity derives from, or `null` when `root` is not a git checkout
 * (a tarball export, a sandbox). Callers fall back rather than failing: host mode simply stays off.
 */
export function readGitCheckout(root = process.cwd()) {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const [gitDir, gitCommonDir, toplevel] = output.trim().split('\n')
    if (!gitDir || !gitCommonDir || !toplevel) return null
    return { gitDir, gitCommonDir, toplevel, root }
  } catch {
    return null
  }
}

/**
 * Derives every per-checkout name from the git facts in `checkout`.
 *
 * Primary-vs-worktree is decided by comparing the git dir against the common dir, because git
 * reports them equal ONLY for the primary checkout; a linked worktree's git dir is
 * `<common>/worktrees/<name>`, which is also where the worktree's name comes from. Deriving the
 * name from the DIRECTORY instead would break on two worktrees whose leaf directories agree.
 *
 * The primary checkout keeps the bare database name (the repo name) so devkit adopts
 * the dev database you already have rather than starting you on an empty one.
 */
export function deriveCheckoutIdentity(checkout) {
  const commonDir = path.resolve(checkout.root ?? checkout.toplevel, checkout.gitCommonDir)
  const gitDir = path.resolve(checkout.root ?? checkout.toplevel, checkout.gitDir)
  const isPrimary = gitDir === commonDir
  const repoName = sanitizeLabel(path.basename(path.dirname(commonDir))) || 'repo'
  const worktreeName = isPrimary ? null : sanitizeLabel(path.basename(gitDir)) || 'worktree'

  return {
    repoName,
    worktreeName,
    isPrimary,
    toplevel: checkout.toplevel,
    /** Browser origin host. Nested so a parent RP id can cover every worktree; see host-mode/README. */
    hostname: isPrimary ? `${repoName}.localhost` : `${worktreeName}.${repoName}.localhost`,
    databaseName: isPrimary ? postgresIdentifier('', repoName) : postgresIdentifier(`${repoName}_wt_`, worktreeName),
    /** Namespaces containers/networks/volumes so one checkout's `compose down` cannot touch another. */
    composeProject: isPrimary ? repoName : `${repoName}-wt-${worktreeName}`,
    /** Stable per-checkout slug for filenames (Traefik route files, lock files). */
    slug: isPrimary ? repoName : `${repoName}-${worktreeName}`
  }
}

/** Convenience wrapper: git facts plus derivation, or `null` outside a git checkout. */
export function checkoutIdentity(root = process.cwd()) {
  const checkout = readGitCheckout(root)
  return checkout ? deriveCheckoutIdentity(checkout) : null
}

/** The baseline template every new checkout's database is cloned from. One per clone. */
export function baselineDatabaseName(identity) {
  return postgresIdentifier(`${identity.databaseBaseName ?? identity.repoName}_`, 'baseline')
}

/** Block of 10 consecutive ports, so a checkout can grow a service without re-deriving. */
const PORT_BLOCK_SIZE = 10
const PORT_RANGE_START = 20000
const PORT_BLOCK_COUNT = 500

/**
 * Ports for a checkout's host processes, derived so nothing is allocated or reclaimed.
 *
 * These are a PREFERENCE, not a reservation. The browser reaches the app through the proxy by
 * hostname, so none of these is the origin and a collision is a nuisance rather than a data loss:
 * Vite walks to the next free port on its own, and the printed fallback URL follows whatever it
 * lands on. Stability still earns its keep for the fallback origin (which keeps its own browser
 * storage) and for reading logs.
 *
 * The 1-in-500 collision between two checkouts surfaces as a loud bind error at startup, never as
 * silent cross-talk, and `DEVKIT_PORT_BASE` overrides it for that one checkout. The hash is over the
 * checkout SLUG, which already includes the repo name, so two different PROJECTS collide no more
 * often than two worktrees of one.
 */
export function checkoutPorts(identity, portNames = ['web', 'api']) {
  const override = Number.parseInt(process.env.DEVKIT_PORT_BASE ?? '', 10)
  const digest = createHash('sha256').update(identity.slug).digest()
  const base = Number.isInteger(override)
    ? override
    : PORT_RANGE_START + (digest.readUInt32BE(0) % PORT_BLOCK_COUNT) * PORT_BLOCK_SIZE

  if (portNames.length > PORT_BLOCK_SIZE) {
    throw new Error(`devkit: ${portNames.length} ports requested but a block holds ${PORT_BLOCK_SIZE}`)
  }
  // Offsets follow the ORDER given, so a project must not reorder its port list casually: every
  // name would move to a different port, which is harmless for the proxied origin and annoying for
  // anything a person has bookmarked on a direct port.
  return portNames.reduce((ports, name, index) => ({ ...ports, [name]: base + index }), { base })
}
