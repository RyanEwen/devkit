/**
 * Prepares only the checkout-local files and dependency tree a project declares.
 *
 * Unlike the development preflight, this operation does not require Devkit's machine bootstrap,
 * start Docker, provision a database, or open a browser. That makes it suitable for agent-created
 * worktrees that need to run tests before they ever start the application.
 */
import process from 'node:process'

import {
  detectedPackageManagerIdentity,
  ensureCheckoutInstall
} from './checkout-install.mjs'
import { readGitCheckout } from './checkout-identity.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { copyWorktreeFiles } from './worktree-files.mjs'

/**
 * Materializes the current checkout's ignored project files and declared dependency install.
 * Returns null outside Git so CLI callers can report a precise usage error. Install failures are
 * propagated after the transactional installer restores any dependency tree it replaced.
 */
export async function prepareCheckout({
  repoRoot,
  log = console.log,
  readCheckout = readGitCheckout,
  loadProject = loadProjectConfig,
  copyFiles = copyWorktreeFiles,
  ensureInstall = ensureCheckoutInstall,
  detectPackageManager = detectedPackageManagerIdentity
}) {
  const checkout = readCheckout(repoRoot)
  if (!checkout) return null

  const project = await loadProject(repoRoot)
  const inherited = copyFiles({ checkout, project })
  for (const relativePath of inherited.copied) {
    log?.(`[devkit] inherited ${relativePath} from the primary checkout`)
  }
  for (const relativePath of inherited.missing) {
    log?.(`[devkit] primary checkout has no ${relativePath}; leaving it absent`)
  }

  const packageManagerIdentity = process.env.npm_config_user_agent
    ?? detectPackageManager(project.install?.command[0])
  const installation = ensureInstall({ repoRoot, project, packageManagerIdentity })
  if (installation.installed) {
    log?.(`[devkit] checkout-local dependencies ready (${project.install.command.join(' ')})`)
  }

  return { checkout, project, inherited, installation }
}
