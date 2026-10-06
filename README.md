# devkit

Devkit gives each Git checkout and worktree its own `*.localhost` hostname, application port,
database container, and database volume. The editor stays on the host; project processes run in
containers that mount the source tree.

```text
printstream        -> http://printstream.localhost
worktree fix-123   -> http://fix-123.printstream.localhost
game-is-up         -> http://game-is-up.localhost
```

The only machine-wide service is Traefik on loopback port 80. It starts when the first routed
project starts and is removed when the last route closes, allowing Docker Desktop to idle. Checkout
stacks do not share Docker networks or databases. Inactive stacks keep only their named volumes.

## Setup

```bash
npm install --save-dev github:RyanEwen/devkit
npx devkit bootstrap
```

Bootstrap installs the proxy and database Compose definitions under `~/.config/devkit` and writes
the marker that enables Devkit. Devkit stays off inside containers, when
`DEVKIT=0`, or before bootstrap.

`devkit prepare` is the dependency-only entry point for a newly created checkout. It copies the
project's declared `worktreeFiles` and materializes its declared checkout-local install without
starting Docker, a database, the proxy, or the application. It is safe to run repeatedly and is
available from the PATH link created by bootstrap even when the checkout has no `node_modules` yet.

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

const teardown = process.argv.includes('--down')
const state = await preflight({ repoRoot, teardown })
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

if (teardown) process.exit(lifecycle.stop())
process.exit(await lifecycle.run(['up', '--remove-orphans']))
```

The lifecycle relays termination signals, removes the route, tears down the whole checkout stack,
and removes the shared proxy after the final route closes. Named volumes are preserved. Pass
`profiles` when profiled services also belong to the stack. Pass `teardown: true` to preflight for
a `down` path so stopping a checkout does not start it first. Routes carry their runner's process
identity, so the next lifecycle operation removes stale routes left by an abrupt process exit.

Only one development runner can own a checkout at a time. A second start fails before changing
dependencies, containers, or routes; other worktrees still run independently. A killed runner's
lease is recovered on the next start.

To leave development running after the terminal closes, pass `--background`:

```bash
npm run dev -- --background
npm run dev -- --down
```

Background mode detaches the same Node runner, keeps its arguments and environment, and writes
output to `<devkit config directory>/logs/<checkout slug>.log`. The starting command reports the
runner PID and log path after preflight succeeds; application readiness still depends on the
project's startup and health checks. Startup failures return an error pointing to that log.
`--down` gracefully stops the existing runner before tearing down its stack. Runners must forward
that choice with `preflight({ repoRoot, teardown: true })` if arguments are consumed in another
process; preflight recognizes `--down` in its own process automatically. Background
mode can also be requested with `preflight({ repoRoot, background: true })`; it exits the invoking
process after the child finishes preflight. It requires a Node file entry point and cannot be
combined with teardown. Devkit's off switch still takes precedence over these options.

Starting development leaves the browser alone by default, even when `browser` is configured.
Pass `--open` to the project's dev runner to request opening after its health check succeeds:

```bash
npm run dev -- --open
npm run dev -- --open=native
npm run dev -- --open=vscode
```

`--open` chooses the VS Code integrated browser when its window-scoped bridge is available,
otherwise the operating system browser. An explicit `--open=vscode` reports an unavailable
bridge instead of opening another browser. Existing VS Code terminals must be relaunched after
the bundled bridge is installed or updated.

Preflight reads these arguments from its own process. Runners that consume arguments in another
process must forward the choice as `preflight({ repoRoot, openBrowser: true })`, or use
`openBrowser: 'native'` or `'vscode'`. Pass `false` to suppress opening for a particular call.
`DEVKIT_OPEN_BROWSER=1` (or `native`/`vscode`) also opts in when a runner cannot forward arguments;
command-line options take precedence. `DEVKIT_OPEN_BROWSER=0` leaves opening disabled.

## Data and worktrees

Every checkout gets one private PostgreSQL or MariaDB server at `database:5432` or
`database:3306`. The internal database name can therefore stay identical across worktrees.

`devkit snapshot` writes a portable SQL baseline under `~/.config/devkit/baselines`. A new
worktree restores that dump before the project applies its migrations. `baselinePaths` can capture
checkout-local files with the same baseline, and `worktreeFiles` copies allowlisted ignored config
from the primary checkout only when missing.

Filesystem restore completion is recorded in `data/.devkit-baseline-restored`, only after a
successful extraction. Files created by tests before the first start do not suppress restoration
of the remaining baseline. Extraction never overwrites existing files. Existing checkouts without
a receipt receive one non-overwriting restore; this does not replace identities they have already
created. The receipt is excluded from snapshots. Remove it to retry a restore of missing files;
removing `data/` also resets it. Refreshing the baseline does not reseed an already restored checkout.

An `install` declaration makes the first preflight replace a missing, stale, or externally linked
dependency tree with a checkout-local install. Devkit fingerprints the declared inputs, command,
Node runtime, and invoking npm identity. Before installing, it moves any existing stale tree aside
so npm cannot traverse borrowed links into a read-only checkout; a failed replacement restores the
original tree. Devkit adds the short-lived backup pattern to Git's local exclude file automatically,
so projects do not need to commit a tool-specific ignore rule. This lets a worktree start with shared
dependencies while still guaranteeing that source-mounted containers receive a real local directory.

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

A permanent route created with `devproxy add` is also a proxy consumer. Traefik remains running
until that route is removed with `devproxy rm`, even when no checkout projects are active.
