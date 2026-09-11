import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const extensionDir = path.join(repoRoot, 'vscode-extension')
const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'))
const output = `devkit-browser-${manifest.version}.vsix`

// Pin the packager so local and CI artifacts are produced by the same toolchain.
const result = spawnSync('npx', [
  '--yes',
  '@vscode/vsce@3.9.2',
  'package',
  '--out',
  output
], {
  cwd: extensionDir,
  stdio: 'inherit',
  windowsHide: true
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
