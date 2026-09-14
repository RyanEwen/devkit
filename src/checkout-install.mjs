/**
 * Materializes a checkout-local dependency directory from a project-declared install command.
 *
 * Worktree tools may seed `node_modules` with either a directory symlink or a directory whose files
 * are symlinks to another checkout. That is useful for immediately loading Devkit, but npm and a
 * source-mounted container cannot safely use those links outside the checkout. Devkit therefore
 * replaces stale installs transactionally and records the inputs/runtime that produced the local
 * directory. A failed install restores the original dependency tree.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const MARKER_NAME = '.devkit-install.json'
const BACKUP_GLOB_SUFFIX = '.devkit-backup-*'

/** Runs the declared install command only when its checkout-local output is absent or stale. */
export function ensureCheckoutInstall({
  repoRoot,
  project,
  nodeVersion = process.versions.node,
  packageManagerIdentity = process.env.npm_config_user_agent ?? '',
  run = runInstall
}) {
  const install = project.install
  if (!install) return { installed: false }

  const outputPath = path.join(repoRoot, install.output)
  ensureInstallBackupIgnored(repoRoot, install.output)
  const expectedFingerprint = installFingerprint({
    repoRoot,
    install,
    nodeVersion,
    packageManagerIdentity
  })
  if (localInstallMatches(outputPath, expectedFingerprint)) return { installed: false }

  const backupPath = `${outputPath}.devkit-backup-${process.pid}`
  const hadOutput = pathEntryExists(outputPath)
  if (hadOutput) renameSync(outputPath, backupPath)

  try {
    const result = run(install.command[0], install.command.slice(1), repoRoot)
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`${install.command.join(' ')} exited with status ${result.status ?? 'unknown'}`)
    }
    if (!existsSync(outputPath) || !lstatSync(outputPath).isDirectory()) {
      throw new Error(`${install.command.join(' ')} completed without creating ${install.output}`)
    }

    writeFileSync(
      path.join(outputPath, MARKER_NAME),
      `${JSON.stringify({ fingerprint: expectedFingerprint })}\n`
    )
    if (hadOutput) rmSync(backupPath, { recursive: true, force: true })
    return { installed: true }
  } catch (error) {
    // Remove only the partial replacement before restoring the original tree. Renaming the tree
    // before npm starts prevents npm from traversing borrowed links into a read-only checkout.
    rmSync(outputPath, { recursive: true, force: true })
    if (hadOutput && pathEntryExists(backupPath)) renameSync(backupPath, outputPath)
    throw error
  }
}

/**
 * Reconstructs npm's user-agent for direct CLI calls, which npm-launched preflights receive in the
 * environment. Keeping those identities equal prevents `devkit prepare` from making the next
 * `npm run` preflight reinstall the dependency tree it just created.
 */
export function detectedPackageManagerIdentity(
  command,
  run = spawnSync,
  readNpmVersion = readRuntimeNpmVersion
) {
  if (!command) return ''

  const name = path.basename(command).replace(/\.(?:cmd|exe)$/iu, '').toLowerCase()
  const result = run(command, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  let version = ''
  if (result.status === 0) {
    version = result.stdout.trim()
  }
  if (!version && name === 'npm') version = readNpmVersion()
  if (!version) return ''
  if (name === 'npm') {
    return `npm/${version} node/v${process.versions.node} ${process.platform} ${process.arch} workspaces/false`
  }
  return `${name}/${version}`
}

/** Reads the npm bundled with the active Node runtime when an agent sandbox blocks child processes. */
function readRuntimeNpmVersion() {
  const executableDir = path.dirname(process.execPath)
  const candidates = process.platform === 'win32'
    ? [path.join(executableDir, 'node_modules', 'npm', 'package.json')]
    : [path.resolve(executableDir, '../lib/node_modules/npm/package.json')]

  for (const candidate of candidates) {
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf8')).version
      if (typeof version === 'string' && version) return version
    } catch {
      // Try the next runtime layout before reporting that npm could not be identified.
    }
  }
  return ''
}

/**
 * Keeps Devkit's short-lived transactional backup out of Git status without requiring projects to
 * commit a tool-specific ignore rule. Linked worktrees share the repository's local exclude file.
 */
export function ensureInstallBackupIgnored(repoRoot, output) {
  try {
    const excludePath = gitExcludePath(repoRoot)
    if (!excludePath) return false

    const pattern = `/${output.replaceAll(path.sep, '/')}${BACKUP_GLOB_SUFFIX}`
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    if (existing.split(/\r?\n/u).includes(pattern)) return false

    mkdirSync(path.dirname(excludePath), { recursive: true })
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    appendFileSync(excludePath, `${separator}# Devkit transactional dependency backup\n${pattern}\n`)
    return true
  } catch {
    // An agent sandbox may expose project files while making Git metadata read-only. The ignore is
    // cosmetic, so that restriction must never prevent Devkit from repairing the actual install.
    return false
  }
}

/** Resolves the repository-local exclude file for both normal and linked worktrees. */
function gitExcludePath(repoRoot) {
  const dotGit = path.join(repoRoot, '.git')
  if (pathEntryExists(dotGit) && lstatSync(dotGit).isDirectory()) {
    return path.join(dotGit, 'info', 'exclude')
  }

  const result = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) return null

  const resolved = result.stdout.trim()
  return resolved ? path.resolve(repoRoot, resolved) : null
}

/** Checks for a directory entry without following a possibly broken symlink. */
function pathEntryExists(entryPath) {
  try {
    lstatSync(entryPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Hashes the declared command and inputs plus the runtime that is executing the install. */
export function installFingerprint({ repoRoot, install, nodeVersion, packageManagerIdentity }) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(install.command))
  for (const input of install.inputs) {
    hash.update(`\0${input}\0`)
    hash.update(readFileSync(path.join(repoRoot, input)))
  }
  hash.update(`\0node=${nodeVersion}\0package-manager=${packageManagerIdentity}`)
  return hash.digest('hex')
}

function localInstallMatches(outputPath, expectedFingerprint) {
  if (!existsSync(outputPath) || !lstatSync(outputPath).isDirectory()) return false
  try {
    const marker = JSON.parse(readFileSync(path.join(outputPath, MARKER_NAME), 'utf8'))
    return marker.fingerprint === expectedFingerprint
  } catch {
    return false
  }
}

function runInstall(command, args, repoRoot) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}
