import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  declaredDependencyTargets,
  dependencyTargetsPath,
  isWorktreeLabel,
  readDependencyTargets,
  removeDependencyTargets,
  runningDependencyWorktrees,
  setDependencyTarget,
  targetFor,
  useDependencyTargets
} from '../src/dependency-targets.mjs'

const worktree = { isPrimary: false, repoName: 'business-system', worktreeName: 'email-routing', toplevel: '/src/email-routing' }
const primary = { isPrimary: true, repoName: 'business-system', worktreeName: null, toplevel: '/src/business-system' }
const dependencies = [{ name: 'platform' }, { name: 'public-api' }]

function fixture(t) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-targets-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  return { configDir, routesDir: path.join(configDir, 'routes') }
}

/** Writes a route file the way writeRoute() does, for a checkout of `repo` named `label`. */
function route(config, repo, label, { pid = process.pid, checkout = `/src/${label}` } = {}) {
  mkdirSync(config.routesDir, { recursive: true })
  const pathLine = checkout === null ? '' : `# Devkit checkout path: ${JSON.stringify(checkout)}\n`
  writeFileSync(path.join(config.routesDir, `${repo}-${label}.yml`),
    `# Devkit checkout owner pid: ${pid}\n${pathLine}http:\n  routers:\n    x:\n      rule: "Host(\`${label}.${repo}.localhost\`) || Host(\`${label}.${repo}.server.home\`)"\n`)
}

test('targets are stored per checkout, outside any repository, under an unambiguous key', (t) => {
  const config = fixture(t)
  assert.equal(dependencyTargetsPath(config, worktree), path.join(config.configDir, 'dependency-targets', 'email-routing.business-system.json'))
  assert.equal(dependencyTargetsPath(config, primary), path.join(config.configDir, 'dependency-targets', 'business-system.json'))
  // Repo "a-b" worktree "c" and repo "a" worktree "b-c" must not share a file.
  assert.notEqual(
    dependencyTargetsPath(config, { isPrimary: false, repoName: 'a-b', worktreeName: 'c' }),
    dependencyTargetsPath(config, { isPrimary: false, repoName: 'a', worktreeName: 'b-c' })
  )
})

test('setting, reading and reverting a target; the file disappears once empty', (t) => {
  const config = fixture(t)
  assert.deepEqual(readDependencyTargets(config, worktree), {})
  assert.deepEqual(setDependencyTarget(config, worktree, dependencies, 'platform', 'pickup-limits'), { platform: 'pickup-limits' })
  assert.deepEqual(readDependencyTargets(config, worktree), { platform: 'pickup-limits' })
  assert.deepEqual(readDependencyTargets(config, primary), {}, 'another checkout is unaffected')
  assert.deepEqual(setDependencyTarget(config, worktree, dependencies, 'platform', null), {})
  assert.equal(existsSync(dependencyTargetsPath(config, worktree)), false)
})

test('a moved or name-reusing checkout must choose again instead of silently using the primary', (t) => {
  const config = fixture(t)
  setDependencyTarget(config, worktree, dependencies, 'platform', 'pickup-limits')
  const moved = { ...worktree, toplevel: '/elsewhere/email-routing' }
  assert.throws(() => readDependencyTargets(config, moved), /recorded for \/src\/email-routing, not this checkout \(\/elsewhere\/email-routing\)/)
  assert.deepEqual(setDependencyTarget(config, moved, dependencies, 'public-api', 'v2'), { 'public-api': 'v2' })
  assert.deepEqual(readDependencyTargets(config, moved), { 'public-api': 'v2' })
})

test('choosing the primary checkout clears a selection recorded for another path', async (t) => {
  const config = fixture(t)
  setDependencyTarget(config, { ...worktree, toplevel: '/old/path' }, dependencies, 'platform', 'pickup-limits')
  await assert.rejects(use(config, []), /recorded for \/old\/path/)
  assert.match(await use(config, ['platform', '--primary']), /Restart/)
  assert.equal(existsSync(dependencyTargetsPath(config, worktree)), false)
})

test('only declared dependencies and real worktree labels can be targeted', (t) => {
  const config = fixture(t)
  assert.throws(() => setDependencyTarget(config, worktree, dependencies, 'other', 'x'), /not a dependency.*platform, public-api/)
  for (const label of ['', 'Pickup', 'a.b', '-x', 'a b', '../x']) {
    assert.equal(isWorktreeLabel(label), false, label)
    assert.throws(() => setDependencyTarget(config, worktree, dependencies, 'platform', label), /not a worktree label/)
  }
  assert.throws(() => setDependencyTarget(config, worktree, dependencies, 'platfrom', null), /no worktree is selected for platfrom/)
  assert.equal(existsSync(dependencyTargetsPath(config, worktree)), false)
})

test('a target for a dependency the project no longer declares is ignored, and can still be cleared', (t) => {
  const config = fixture(t)
  setDependencyTarget(config, worktree, dependencies, 'public-api', 'old')
  setDependencyTarget(config, worktree, dependencies, 'platform', 'pickup-limits')
  const current = [{ name: 'platform' }]
  assert.deepEqual(declaredDependencyTargets(readDependencyTargets(config, worktree), current), { platform: 'pickup-limits' })
  assert.deepEqual(setDependencyTarget(config, worktree, current, 'public-api', null), { platform: 'pickup-limits' })
})

test('a damaged file stops with its path instead of silently using the primary checkout', (t) => {
  const config = fixture(t)
  const file = dependencyTargetsPath(config, worktree)
  mkdirSync(path.dirname(file), { recursive: true })
  const stored = (dependencies) => JSON.stringify({ checkout: worktree.toplevel, dependencies })
  for (const content of ['{not json', '[]', '"x"', '{"platform":"x"}', stored({ platform: 'Bad Label' }), stored({ platform: 3 }), stored([])]) {
    writeFileSync(file, content)
    assert.throws(() => readDependencyTargets(config, worktree), (error) => error.message.includes(file), content)
  }
})

test('inherited object property names never count as targets', () => {
  assert.equal(targetFor({}, 'constructor'), undefined)
  assert.equal(targetFor({}, 'toString'), undefined)
  assert.equal(targetFor({ constructor: 'x' }, 'constructor'), 'x')
})

test('cleanup removes the file, and removing a missing file is harmless', (t) => {
  const config = fixture(t)
  setDependencyTarget(config, worktree, dependencies, 'platform', 'pickup-limits')
  removeDependencyTargets(config, worktree)
  removeDependencyTargets(config, worktree)
  assert.equal(existsSync(dependencyTargetsPath(config, worktree)), false)
})

test('running worktrees come from live route files, with their recorded checkout path', (t) => {
  const config = fixture(t)
  route(config, 'platform', 'pickup-limits')
  route(config, 'platform', 'old-runner', { checkout: null })
  route(config, 'platform', 'stopped', { pid: 2 ** 22 + 12345 })
  route(config, 'public-api', 'pickup-limits')
  mkdirSync(config.routesDir, { recursive: true })
  writeFileSync(path.join(config.routesDir, 'platform.yml'), `# Devkit checkout owner pid: ${process.pid}\nrule: "Host(\`platform.localhost\`)"\n`)
  const alive = (pid) => pid !== 2 ** 22 + 12345
  assert.deepEqual(runningDependencyWorktrees(config, 'platform', { alive }), [
    { worktree: 'old-runner', checkout: null },
    { worktree: 'pickup-limits', checkout: '/src/pickup-limits' }
  ])
  assert.deepEqual(runningDependencyWorktrees({ routesDir: path.join(config.configDir, 'missing') }, 'platform'), [])
})

/** Runs `devkit use` with stubbed probes and branch lookups; returns its log lines. */
async function use(config, args, { running } = {}) {
  const lines = []
  const probe = async (declared, { targets }) => declared.map((dependency) => ({
    dependency, worktree: targetFor(targets, dependency.name), url: `http://${dependency.name}`, ok: true, detail: 'HTTP 200'
  }))
  await useDependencyTargets({
    config, identity: worktree, project: { dependencies }, args, probe, log: (line) => lines.push(line),
    branchOf: () => 'fix/branch', ...(running ? { running } : {})
  })
  return lines.join('\n')
}

test('devkit use selects only a running worktree and shows which checkout and branch it is', async (t) => {
  const config = fixture(t)
  route(config, 'platform', 'pickup-limits', { checkout: '/src/pickup' })
  route(config, 'platform', 'same1', { checkout: '/src/same' })
  await assert.rejects(use(config, ['platform', 'same']), /no running checkout answers as same\.platform; running platform worktrees: pickup-limits, same1/)
  assert.deepEqual(readDependencyTargets(config, worktree), {})

  const output = await use(config, ['platform', 'pickup-limits'])
  assert.match(output, /platform\s+pickup-limits worktree \(\/src\/pickup, branch fix\/branch\)/)
  assert.match(output, /Restart this checkout's dev server/)
  assert.match(await use(config, ['platform', 'pickup-limits']), /Nothing changed\./)
  assert.match(await use(config, ['platform', '--primary']), /platform\s+primary checkout[\s\S]*Restart/)
})

test('devkit use rejects malformed arguments and typos without reporting a change', async (t) => {
  const config = fixture(t)
  for (const args of [['platform'], ['a', 'b', 'c'], ['--primary', 'platform'], ['platform', '--force'], ['-x', 'y']]) {
    await assert.rejects(use(config, args), /usage: devkit use/, args.join(' '))
  }
  await assert.rejects(use(config, ['platfrom', '--primary']), /no worktree is selected for platfrom/)
})

test('devkit use lists a leftover target for a dependency the project dropped', async (t) => {
  const config = fixture(t)
  setDependencyTarget(config, worktree, [{ name: 'legacy' }], 'legacy', 'old')
  assert.match(await use(config, []), /! legacy\s+no longer declared by this project; `devkit use legacy --primary` clears it/)
  assert.match(await use(config, ['legacy', '--primary']), /Restart/)
  assert.deepEqual(readDependencyTargets(config, worktree), {})
})
