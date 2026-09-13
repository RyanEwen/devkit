import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { ensureCheckoutInstall, installFingerprint } from '../src/checkout-install.mjs'

const sandboxes = []
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
})

function checkout() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'devkit-install-'))
  sandboxes.push(repoRoot)
  writeFileSync(path.join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n')
  writeFileSync(path.join(repoRoot, '.nvmrc'), '22.22.3\n')
  return repoRoot
}

const project = {
  install: {
    command: ['npm', 'ci'],
    inputs: ['package-lock.json', '.nvmrc'],
    output: 'node_modules'
  }
}

function fakeInstall(status = 0) {
  return (_command, _args, repoRoot) => {
    mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true })
    return { status }
  }
}

test('a project with no install declaration is left alone', () => {
  assert.deepEqual(ensureCheckoutInstall({ repoRoot: checkout(), project: {} }), { installed: false })
})

test('a matching local install is reused', () => {
  const repoRoot = checkout()
  const outputPath = path.join(repoRoot, 'node_modules')
  mkdirSync(outputPath)
  const fingerprint = installFingerprint({
    repoRoot,
    install: project.install,
    nodeVersion: '22.22.3',
    packageManagerIdentity: 'npm/10.9.8'
  })
  writeFileSync(path.join(outputPath, '.devkit-install.json'), JSON.stringify({ fingerprint }))

  const result = ensureCheckoutInstall({
    repoRoot,
    project,
    nodeVersion: '22.22.3',
    packageManagerIdentity: 'npm/10.9.8',
    run: () => assert.fail('matching dependencies must not be reinstalled')
  })
  assert.deepEqual(result, { installed: false })
})

test('an external symlink is replaced with a local install', () => {
  const repoRoot = checkout()
  const external = mkdtempSync(path.join(os.tmpdir(), 'devkit-external-install-'))
  sandboxes.push(external)
  symlinkSync(external, path.join(repoRoot, 'node_modules'), 'dir')

  const result = ensureCheckoutInstall({ repoRoot, project, run: fakeInstall() })

  assert.deepEqual(result, { installed: true })
  assert.throws(() => readlinkSync(path.join(repoRoot, 'node_modules')))
})

test('a directory containing borrowed symlinks is moved before installation', () => {
  const repoRoot = checkout()
  const outputPath = path.join(repoRoot, 'node_modules')
  const external = mkdtempSync(path.join(os.tmpdir(), 'devkit-external-install-'))
  sandboxes.push(external)
  mkdirSync(outputPath)
  writeFileSync(path.join(external, 'package.json'), '{}\n')
  symlinkSync(path.join(external, 'package.json'), path.join(outputPath, 'package.json'))

  const result = ensureCheckoutInstall({
    repoRoot,
    project,
    run: (_command, _args, root) => {
      assert.equal(existsSync(path.join(root, 'node_modules')), false)
      mkdirSync(path.join(root, 'node_modules'))
      return { status: 0 }
    }
  })

  assert.deepEqual(result, { installed: true })
  assert.equal(existsSync(path.join(external, 'package.json')), true)
  assert.equal(existsSync(path.join(outputPath, 'package.json')), false)
})

test('a failed install restores the external symlink and removes partial output', () => {
  const repoRoot = checkout()
  const external = mkdtempSync(path.join(os.tmpdir(), 'devkit-external-install-'))
  sandboxes.push(external)
  symlinkSync(external, path.join(repoRoot, 'node_modules'), 'dir')

  assert.throws(
    () => ensureCheckoutInstall({ repoRoot, project, run: fakeInstall(1) }),
    /npm ci exited with status 1/
  )
  assert.equal(readlinkSync(path.join(repoRoot, 'node_modules')), external)
})

test('a failed install restores an existing local dependency tree', () => {
  const repoRoot = checkout()
  const outputPath = path.join(repoRoot, 'node_modules')
  mkdirSync(outputPath)
  writeFileSync(path.join(outputPath, 'sentinel'), 'original\n')

  assert.throws(
    () => ensureCheckoutInstall({ repoRoot, project, run: fakeInstall(1) }),
    /npm ci exited with status 1/
  )
  assert.equal(readFileSync(path.join(outputPath, 'sentinel'), 'utf8'), 'original\n')
})

test('a changed input or runtime refreshes the install', () => {
  const repoRoot = checkout()
  ensureCheckoutInstall({
    repoRoot,
    project,
    nodeVersion: '22.22.3',
    packageManagerIdentity: 'npm/10.9.8',
    run: fakeInstall()
  })
  writeFileSync(path.join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n')

  let installs = 0
  ensureCheckoutInstall({
    repoRoot,
    project,
    nodeVersion: '22.22.3',
    packageManagerIdentity: 'npm/10.9.8',
    run: (command, args, root) => {
      installs += 1
      rmSync(path.join(root, 'node_modules'), { recursive: true, force: true })
      return fakeInstall()(command, args, root)
    }
  })
  assert.equal(installs, 1)
})
