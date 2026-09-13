/**
 * Materializes a checkout-local dependency directory from a project-declared install command.
 *
 * Worktree tools may seed `node_modules` with a symlink to another checkout. That is useful for
 * immediately loading Devkit, but a source-mounted container cannot follow the link outside its
 * checkout. Devkit therefore replaces stale or linked installs transactionally and records the
 * inputs/runtime that produced the local directory. A failed install restores an original link.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const MARKER_NAME = '.devkit-install.json'

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
  const expectedFingerprint = installFingerprint({
    repoRoot,
    install,
    nodeVersion,
    packageManagerIdentity
  })
  if (localInstallMatches(outputPath, expectedFingerprint)) return { installed: false }

  const linkBackupPath = `${outputPath}.devkit-link-backup-${process.pid}`
  const hadSymlink = existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()
  if (hadSymlink) renameSync(outputPath, linkBackupPath)

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
    if (hadSymlink) unlinkSync(linkBackupPath)
    return { installed: true }
  } catch (error) {
    // Remove only the declared output before restoring the link moved above. Its external target is
    // never traversed or changed, so a failed setup leaves the worktree as usable as it began.
    rmSync(outputPath, { recursive: true, force: true })
    if (hadSymlink && existsSync(linkBackupPath)) renameSync(linkBackupPath, outputPath)
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
