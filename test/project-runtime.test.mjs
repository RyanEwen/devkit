import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { projectRuntime } from '../src/project-runtime.mjs'
import { prepareCheckout } from '../src/checkout-prepare.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(pin = '20.20.2') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-runtime-'))
  roots.push(root)
  if (pin !== null) writeFileSync(path.join(root, '.nvmrc'), `${pin}\n`)
  return root
}

function runtimeOptions(root, overrides = {}) {
  const node = path.join(root, 'nvm/versions/node/v20.20.2/bin/node')
  mkdirSync(path.dirname(node), { recursive: true })
  writeFileSync(node, '')
  const calls = []
  return {
    calls,
    env: { NVM_DIR: path.join(root, 'nvm'), PATH: '/host/bin', npm_config_user_agent: 'npm/11 node/v24', npm_execpath: '/wrong/npm', npm_node_execpath: '/wrong/node', npm_config_prefix: '/wrong', NPM_CONFIG_PREFIX: '/wrong', KEEP: 'yes' },
    nodeVersion: '24.18.1',
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: command === 'npm' ? '10.8.2\n' : 'v20.20.2\n' }
    },
    ...overrides
  }
}

test('projects without .nvmrc retain their invoking environment', () => {
  assert.equal(projectRuntime(fixture(null), { run: () => assert.fail('must not run tools') }), null)
})

test('selects the checkout runtime and clears stale npm identity without changing the caller env', () => {
  const root = fixture('v20.20.2 # pinned')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '20.20.2', npm: '10.8.2' } }))
  const options = runtimeOptions(root)
  const runtime = projectRuntime(root, options)
  assert.equal(runtime.version, '20.20.2')
  assert.equal(runtime.switched, true)
  assert.equal(runtime.env.PATH, `${path.dirname(runtime.node)}${path.delimiter}/host/bin`)
  assert.equal(runtime.env.KEEP, 'yes')
  assert.equal(runtime.env.npm_config_user_agent, `npm/10.8.2 node/v20.20.2 ${process.platform} ${process.arch} workspaces/false`)
  assert.equal(runtime.env.npm_execpath, undefined)
  assert.equal(runtime.env.npm_node_execpath, undefined)
  assert.equal(runtime.env.npm_config_prefix, undefined)
  assert.equal(runtime.env.NPM_CONFIG_PREFIX, undefined)
  assert.equal(options.env.npm_execpath, '/wrong/npm')
  assert.equal(options.calls[1].options.env.PATH, runtime.env.PATH)
})

test('reuses the matching executable and verifies its npm pin', () => {
  const root = fixture(process.versions.node)
  const runtime = projectRuntime(root)
  assert.equal(runtime.node, process.execPath)
  assert.equal(runtime.switched, false)
})

test('missing runtimes fail before an install or service command can run', () => {
  const root = fixture('99.0.0')
  assert.throws(() => projectRuntime(root, { env: { NVM_DIR: root }, run: () => assert.fail('must not run tools') }), /not installed; run nvm install/u)
})

test('installed aliases are resolved through nvm using positional arguments', () => {
  const root = fixture('lts/*')
  const options = runtimeOptions(root)
  writeFileSync(path.join(root, 'nvm/nvm.sh'), '')
  const runtime = projectRuntime(root, options)
  assert.equal(runtime.version, '20.20.2')
  assert.deepEqual(options.calls[0].args.slice(-2), [path.join(root, 'nvm/nvm.sh'), 'lts/*'])
})

test('an unavailable alias fails clearly', () => {
  const root = fixture('lts/*')
  const options = runtimeOptions(root, { run: () => ({ status: 3, stdout: 'N/A\n' }) })
  writeFileSync(path.join(root, 'nvm/nvm.sh'), '')
  assert.throws(() => projectRuntime(root, options), /not installed/u)
})

test('rejects conflicting runtime declarations and mismatched npm', () => {
  const root = fixture()
  const options = runtimeOptions(root)
  const pkg = path.join(root, 'package.json')
  writeFileSync(pkg, JSON.stringify({ engines: { node: '22.22.3' } }))
  assert.throws(() => projectRuntime(root, options), /package.json requires 22.22.3/u)
  writeFileSync(pkg, JSON.stringify({ engines: { npm: '11.0.0' }, packageManager: 'npm@10.8.2' }))
  assert.throws(() => projectRuntime(root, options), /disagree/u)
  writeFileSync(pkg, JSON.stringify({ engines: { npm: '11.0.0' } }))
  assert.throws(() => projectRuntime(root, options), /requires npm 11.0.0; found 10.8.2/u)
})

test('rejects malformed .nvmrc and an executable that reports the wrong version', () => {
  const root = fixture('20.20.2\n22.22.3')
  assert.throws(() => projectRuntime(root), /expected one Node version/u)
  writeFileSync(path.join(root, '.nvmrc'), '20.20.2\n')
  const options = runtimeOptions(root, { run: () => ({ status: 0, stdout: 'v24.18.1\n' }) })
  assert.throws(() => projectRuntime(root, options), /could not verify Node/u)
})

test('devkit run preserves arguments, cwd and exit status and sanitizes outer npm metadata', () => {
  const root = fixture(process.versions.node)
  const output = path.join(root, 'result.json')
  const child = path.join(root, 'child.cjs')
  writeFileSync(child, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(3), npm: process.env.npm_execpath, node: process.versions.node })); process.exit(7)`)
  const cli = new URL('../bin/devkit.mjs', import.meta.url).pathname
  const result = spawnSync(process.execPath, [cli, 'run', 'node', child, output, 'space arg', '$(literal)', ';'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: '/wrong/npm', npm_config_user_agent: 'npm/11 node/v24' }
  })
  assert.equal(result.status, 7, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { cwd: root, args: ['space arg', '$(literal)', ';'], node: process.versions.node })
})

test('CLI preparation fails on a missing pin before touching dependencies', () => {
  const root = fixture('99.0.0')
  const output = path.join(root, 'node_modules/keep')
  mkdirSync(path.dirname(output))
  writeFileSync(output, 'original')
  const result = spawnSync(process.execPath, [new URL('../bin/devkit.mjs', import.meta.url).pathname, 'prepare'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NVM_DIR: root }
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Node 99.0.0.*not installed/u)
  assert.equal(readFileSync(output, 'utf8'), 'original')
})

test('library preparation rejects an unavailable runtime before loading project configuration', async () => {
  const root = fixture('99.0.0')
  await assert.rejects(prepareCheckout({
    repoRoot: root,
    readCheckout: () => ({ toplevel: root }),
    loadProject: () => assert.fail('must validate runtime before loading or preparing the project')
  }), /not installed/u)
})

test('a launcher waiting for a command is distinguishable from that command in Linux process inspection', { skip: process.platform !== 'linux' }, () => {
  const root = fixture(process.versions.node)
  const output = path.join(root, 'parent.json')
  const runner = path.join(root, 'run-dev.mjs')
  writeFileSync(runner, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\\0').filter(Boolean)))`)
  const result = spawnSync(process.execPath, [new URL('../bin/devkit.mjs', import.meta.url).pathname, 'run', 'node', runner, output], {
    cwd: root, encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), ['devkit command launcher'])
})
