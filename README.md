# devkit

Devkit gives each Git checkout and worktree its own `*.localhost` hostname, application port,
database container, and database volume. The editor stays on the host; project processes run in
containers that mount the source tree.

```text
printstream        -> http://printstream.localhost
worktree fix-123   -> http://fix-123.printstream.localhost
game-is-up         -> http://game-is-up.localhost
```

The only machine-wide service is Traefik on loopback port 80. Checkout stacks do not share Docker
networks or databases. Inactive stacks keep only their named volumes.

## Setup

```bash
npm install --save-dev github:RyanEwen/devkit
npx devkit bootstrap
```

Bootstrap installs the proxy and database Compose definitions under `~/.config/devkit`, starts the
proxy, and writes the marker that enables Devkit. Devkit stays off inside containers, when
`DEVKIT=0`, or before bootstrap.

## Project configuration

`devkit.config.mjs` contains only what cannot be derived from the checkout path:

```js
export default {
  ports: ['web'],
  database: {
    engine: 'postgres',
    version: '16-bookworm',
    name: 'my_app',
    // Opt in only when host-side tools need the checkout database.
    hostAccess: true
  },
  migrationsTable: '_prisma_migrations',
  baselinePaths: ['data/uploads'],
  worktreeFiles: ['.env'],
  install: {
    command: ['npm', 'ci'],
    inputs: ['package.json', 'package-lock.json', '.nvmrc'],
    output: 'node_modules'
  },
  dependencies: [{ name: 'public-api', healthPath: '/api/_health' }],
  browser: { path: '/', healthPath: '/_health' },
  env: ({ database, url }) => ({
    CLIENT_ORIGIN: url,
    DATABASE_URL: database.url,
    VITE_DEV_PORT: '5173'
  })
}
```

Application processes use fixed internal ports. The browser-facing port is published to the
checkout-specific host port. `database.hostAccess` additionally publishes the database on a
derived `127.0.0.1` port for host-side migration and validation tools; it is never exposed on the
LAN.

The host runner combines the Devkit database definition with the project's `compose.dev.yml`:

```js
import path from 'node:path'
import {
  checkoutCompose,
  checkoutComposeLifecycle,
  preflight
} from '@ryanewen/devkit'

const state = await preflight({ repoRoot })
const invocation = checkoutCompose(state, {
  projectDirectory: repoRoot,
  files: [path.join(repoRoot, 'compose.dev.yml')],
  env: {
    DEVKIT_WEB_PORT: String(state.ports.web),
    HOST_UID: String(process.getuid?.() ?? 1000),
    HOST_GID: String(process.getgid?.() ?? 1000)
  }
})
const lifecycle = checkoutComposeLifecycle(state, invocation)

if (process.argv.includes('--down')) process.exit(lifecycle.stop())
process.exit(await lifecycle.run(['up', '--remove-orphans']))
```

The lifecycle relays termination signals, removes the route, and tears down the whole checkout
stack while preserving named volumes. Pass `profiles` when profiled services also belong to the
stack. Pass `teardown: true` to preflight for a `down` path so stopping a checkout does not start
it first.

## Data and worktrees

Every checkout gets one private PostgreSQL or MariaDB server at `database:5432` or
`database:3306`. The internal database name can therefore stay identical across worktrees.

`devkit snapshot` writes a portable SQL baseline under `~/.config/devkit/baselines`. A new
worktree restores that dump before the project applies its migrations. `baselinePaths` can capture
checkout-local files with the same baseline, and `worktreeFiles` copies allowlisted ignored config
from the primary checkout only when missing.

An `install` declaration makes the first preflight replace a missing, stale, or externally
symlinked dependency directory with a checkout-local install. Devkit fingerprints the declared
inputs, command, Node runtime, and invoking npm identity. If replacement of a symlink fails, the
original link is restored. This lets a worktree start with a shared dependency link while still
guaranteeing that source-mounted containers receive a real local directory.

Host-side tools that need only the database can call `prepareDatabase({ repoRoot })`. It installs
declared checkout dependencies, starts and provisions the database, and returns its loopback URL
without starting the proxy, checking other projects, restoring data, or opening a browser.

## Commands

| Command | Purpose |
| --- | --- |
| `devkit doctor` | inspect this checkout's proxy, container, database, baseline, and dependencies |
| `devkit snapshot` | capture this checkout as the baseline for new worktrees |
| `devkit reset` | rebuild a worktree database from its baseline (`--empty` skips it) |
| `devkit prune` | find orphaned checkout database volumes (`--yes` removes them) |
| `devkit infra` | start the proxy and current checkout database |
| `devproxy add <name> <port>` | route any host process through `<name>.localhost` |

`devkit reset` refuses to reset the primary checkout. Port blocks and Compose project names are
derived from checkout paths; no allocation registry or shared database profile exists.
