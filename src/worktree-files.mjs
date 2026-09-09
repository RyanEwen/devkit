/**
 * Materialises ignored local configuration in a linked worktree from the primary checkout.
 *
 * Git deliberately leaves files such as `.env` behind when it creates a worktree. Those files are
 * often exactly what makes a checkout runnable, so requiring a person to remember and re-edit them
 * contradicts devkit's "npm install, then start" contract. Projects opt individual paths in; an
 * ignored tree as a whole may contain node_modules, caches, dumps and unrelated secrets and must
 * never be copied implicitly.
 *
 * Existing destinations always win. A worktree is allowed to customise its own configuration, and
 * a later start must not silently replace it when the primary checkout changes.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { deriveCheckoutIdentity, readGitCheckout } from './checkout-identity.mjs'
import { devkitConfig } from './config.mjs'
import { loadProjectConfig } from './project-config.mjs'

function validateRelativePath(value) {
  const normalized = path.normalize(value)
  if (!value || path.isAbsolute(value) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`devkit: worktreeFiles entry must stay inside the checkout: ${JSON.stringify(value)}`)
  }
  return normalized
}

/** Copy configured paths using already-loaded git/project state. Exported for focused tests. */
export function copyWorktreeFiles({ checkout, project }) {
  const identity = deriveCheckoutIdentity(checkout)
  if (identity.isPrimary || project.worktreeFiles.length === 0) return { copied: [], missing: [] }

  const primaryRoot = path.dirname(path.resolve(checkout.root ?? checkout.toplevel, checkout.gitCommonDir))
  const copied = []
  const missing = []

  for (const configuredPath of project.worktreeFiles) {
    const relativePath = validateRelativePath(configuredPath)
    const source = path.join(primaryRoot, relativePath)
    const destination = path.join(checkout.toplevel, relativePath)
    if (existsSync(destination)) continue
    if (!existsSync(source)) {
      missing.push(configuredPath)
      continue
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    copied.push(configuredPath)
  }

  return { copied, missing }
}

/**
 * Public early hook for dev runners that read an inherited file before calling `preflight()`.
 * Returns null under the same off-gates as preflight and touches nothing in the primary checkout.
 */
export async function inheritWorktreeFiles({ repoRoot }) {
  if (!devkitConfig()) return null
  const checkout = readGitCheckout(repoRoot)
  if (!checkout) return null
  const project = await loadProjectConfig(repoRoot)
  return copyWorktreeFiles({ checkout, project })
}
