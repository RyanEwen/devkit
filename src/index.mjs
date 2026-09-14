/**
 * The package surface a project imports.
 *
 * Kept to the few calls a dev script or host-side validation tool actually makes, plus the identity
 * helpers that a project may want for its own naming. Everything else (the CLI's
 * snapshot/reset/prune, the doctor checks) is
 * reached through the `devkit` binary, not through imports, so this stays small enough to keep
 * stable across versions consuming repos pin independently.
 */
export { preflight, prepareDatabase, refreshBaselineAfterMigrations, PreflightError } from './preflight.mjs'
export { writeRoute, removeRoute, routeFilePath } from './proxy.mjs'
export { checkoutIdentity, checkoutPorts, baselineDatabaseName } from './checkout-identity.mjs'
export { devkitConfig, devkitConfigDir, devkitMarkerPath } from './config.mjs'
export { CONFIG_FILENAME, loadProjectConfig } from './project-config.mjs'
export { inheritWorktreeFiles } from './worktree-files.mjs'
export { checkoutCompose } from './checkout-compose.mjs'
export { checkoutComposeLifecycle } from './checkout-compose-lifecycle.mjs'
export { prepareCheckout } from './checkout-prepare.mjs'
