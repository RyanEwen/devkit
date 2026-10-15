/**
 * Selects an already-installed nvm runtime before a checkout command runs.
 *
 * Command entrypoints may re-execute themselves; library preflights only validate because their
 * caller may already hold a runner lease. Never install runtimes or change nvm's machine default.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXACT_VERSION = /^v?(\d+\.\d+\.\d+)$/u
const NPM_ENV = ['npm_config_user_agent', 'npm_node_execpath', 'npm_execpath', 'npm_config_prefix', 'NPM_CONFIG_PREFIX']

/** Resolves the checkout pin and checks npm before any project files or services are changed. */
export function projectRuntime(repoRoot, {
  env = process.env, execPath = process.execPath, nodeVersion = process.versions.node,
  home = os.homedir(), run = spawnSync
} = {}) {
  const pinFile = path.join(repoRoot, '.nvmrc')
  if (!existsSync(pinFile)) return null
  const pins = readFileSync(pinFile, 'utf8').split(/\r?\n/u)
    .map((line) => line.split('#')[0].trim()).filter(Boolean)
  if (pins.length !== 1 || pins[0].startsWith('-')) {
    throw new Error('expected one Node version or nvm alias in .nvmrc')
  }
  const pin = pins[0]
  const nvmDir = env.NVM_DIR || path.join(home, '.nvm')
  let version = EXACT_VERSION.exec(pin)?.[1]
  if (!version) {
    const script = path.join(nvmDir, 'nvm.sh')
    if (!existsSync(script)) throw new Error(`cannot resolve .nvmrc alias ${pin}: ${script} is missing`)
    const resolved = run('bash', ['-c', 'source "$1" --no-use && nvm version "$2"', 'devkit-runtime', script, pin], {
      env, encoding: 'utf8'
    })
    version = EXACT_VERSION.exec(resolved.stdout?.trim() ?? '')?.[1]
    if (resolved.status !== 0 || !version) throw new Error(`Node ${pin} is not installed; run nvm install from this checkout`)
  }

  const node = version === nodeVersion ? execPath : path.join(nvmDir, 'versions', 'node', `v${version}`, 'bin', 'node')
  if (!existsSync(node)) throw new Error(`Node ${version} from .nvmrc is not installed; run nvm install from this checkout`)
  const nodeCheck = run(node, ['--version'], { env, encoding: 'utf8' })
  if (nodeCheck.status !== 0 || nodeCheck.stdout?.trim() !== `v${version}`) {
    throw new Error(`could not verify Node ${version} at ${node}`)
  }

  const selectedEnv = { ...env, PATH: `${path.dirname(node)}${path.delimiter}${env.PATH ?? ''}` }
  // An outer npm run may have used a different Node/npm pair. Its identity must not poison the
  // dependency fingerprint or point child tools back at the original npm executable.
  for (const name of NPM_ENV) delete selectedEnv[name]
  const packageFile = path.join(repoRoot, 'package.json')
  const pkg = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {}
  const engineNode = EXACT_VERSION.exec(pkg.engines?.node ?? '')?.[1]
  if (engineNode && engineNode !== version) throw new Error(`.nvmrc selects Node ${version}, but package.json requires ${engineNode}`)
  const engineNpm = EXACT_VERSION.exec(pkg.engines?.npm ?? '')?.[1]
  const managerNpm = /^npm@(\d+\.\d+\.\d+)(?:\+.*)?$/u.exec(pkg.packageManager ?? '')?.[1]
  if (engineNpm && managerNpm && engineNpm !== managerNpm) {
    throw new Error('package.json engines.npm and packageManager disagree')
  }
  const requiredNpm = engineNpm ?? managerNpm
  const npm = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
    env: selectedEnv, encoding: 'utf8', shell: process.platform === 'win32'
  })
  const npmVersion = npm.stdout?.trim()
  if (npm.status !== 0 || !EXACT_VERSION.test(npmVersion ?? '')) throw new Error(`npm is unavailable for Node ${version}`)
  if (requiredNpm && npmVersion !== requiredNpm) {
    throw new Error(`Node ${version} requires npm ${requiredNpm}; found ${npmVersion}. Restore the pinned npm before retrying`)
  }
  selectedEnv.npm_config_user_agent = `npm/${npmVersion} node/v${version} ${process.platform} ${process.arch} workspaces/false`
  return { node, version, npmVersion, env: selectedEnv, switched: version !== nodeVersion }
}

/** Aligns PATH and clears a stale outer npm identity after the executing Node has been checked. */
function applyRuntime(runtime) {
  process.env.PATH = runtime.env.PATH
  for (const name of NPM_ENV) delete process.env[name]
  process.env.npm_config_user_agent = runtime.env.npm_config_user_agent
}

/** Re-enters a CLI under its pinned runtime, preserving arguments, working directory and exit code. */
export function enterProjectRuntime(repoRoot) {
  const runtime = projectRuntime(repoRoot)
  if (!runtime) return
  if (runtime.switched) {
    console.error(`[devkit] selecting Node ${runtime.version}, npm ${runtime.npmVersion} from .nvmrc`)
    // This process only waits for the selected runtime. Linux ownership checks must not mistake
    // a runner path in its arguments for an additional application process.
    process.title = 'devkit runtime launcher'
    finishCommand(spawnSync(runtime.node, [...process.execArgv, ...process.argv.slice(1)], {
      env: runtime.env, stdio: 'inherit'
    }))
  }
  applyRuntime(runtime)
}

/** Guards library calls without replaying a caller that may already own checkout resources. */
export function assertProjectRuntime(repoRoot) {
  const runtime = projectRuntime(repoRoot)
  if (!runtime) return
  if (runtime.switched) {
    throw new Error(`Node ${runtime.version} is required by .nvmrc; running ${process.versions.node}. Start through devkit run, or run nvm use first`)
  }
  applyRuntime(runtime)
}

/** Runs argv directly under the selected PATH; shell metacharacters remain literal arguments. */
export function runProjectCommand(argv) {
  if (!argv.length) throw new Error('usage: devkit run <command> [arguments...]')
  process.title = 'devkit command launcher'
  finishCommand(spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' }))
}

function finishCommand(result) {
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.status ?? 1)
}
