# devkit

Gives every checkout and worktree on your machine its own `*.localhost` hostname, its own database
and its own ports, all **derived from its path**, so several projects and several worktrees of one
project can run at the same time without renumbering anything.

Checkout names and application ports are never allocated or recorded. Delete a worktree and its
names simply stop being produced; `devkit prune` finds orphaned databases by re-deriving the live
set and diffing it against what exists. Alternate database-version profiles are the one exception:
their stable machine ports are recorded under `~/.config/devkit/database-profiles.json`.

```
printstream          -> http://printstream.localhost
  worktree fix-123   -> http://fix-123.printstream.localhost
game-is-up           -> http://game-is-up.localhost
```

## What it sets up

One shared stack for the whole machine, installed outside every repo at `~/.config/devkit`:

| Piece | Purpose |
| --- | --- |
| Traefik on `127.0.0.1:80` | routes each `*.localhost` hostname to that checkout's dev server |
| PostgreSQL 16 on `127.0.0.1:5432` | backward-compatible default server for PostgreSQL projects |
| MariaDB 12.3.2 on `127.0.0.1:3307` | backward-compatible default server for MariaDB/MySQL projects |
| Version profiles on allocated loopback ports | separate long-lived servers and volumes for exact alternate tags |
| `~/.config/devkit/routes` | one generated route file per running checkout, hot-reloaded |
| `~/.config/devkit/baselines` | the database + seed-data baseline a new worktree starts from |

`*.localhost` resolves to loopback in browsers and on Windows with no hosts file and no DNS, which
is what makes this setup-free.

## Install

```bash
npm install --save-dev github:RyanEwen/devkit
npx devkit bootstrap        # once per machine
```

`bootstrap` installs or upgrades the managed shared-stack files, starts the proxy, writes the marker
that switches devkit on, and links `devkit` and `devproxy` onto your PATH. Database profiles start
on demand when a project selects them. Re-run bootstrap after a Devkit upgrade that adds
infrastructure. A changed managed file is retained beside the replacement with a `.previous`
suffix.

## Off unless you turn it on

**When devkit is off it does not run.** Not "fails gracefully": every Docker call, database probe
and proxy write sits behind the marker file existing, so a contributor who clones your repo without
running `bootstrap` gets exactly the behaviour they would have had if you had never added it. This
matters because dev scripts ship in public repos.

Three ways it stays off, checked in order: `DEVKIT=0`, running inside a container (the devcontainer
owns ports and networking there), or no marker file.

## Using it in a project

Add a `devkit.config.mjs` naming the few things devkit cannot derive:

```js
export default {
  ports: ['web', 'api'],                 // named offsets in this checkout's port block, in order
  database: {                            // omitted means Postgres with a path-derived name
    engine: 'mariadb',
    version: '10.2.44',                  // optional exact image tag; omitted keeps the default
    name: 'my_existing_dev_database'     // optional primary name; worktrees stay derived
  },
  migrationsTable: '_prisma_migrations', // null if the project has no migrations
  baselinePaths: ['data/uploads'],       // repo-relative files a new worktree should start with
  worktreeFiles: ['.env'],               // ignored local config inherited when absent
  dependencies: [                        // independently started projects required at preflight
    { name: 'public-api', healthPath: '/api/_health' }
  ],
  browser: { path: '/', healthPath: '/_health' }, // optional automatic browser tab
  env: ({ ports, url, identity, database, dependencyOrigins }) => ({ // whatever YOUR dev servers read
    API_PORT: String(ports.api),
    CLIENT_ORIGIN: url,
    DB_HOST: database.host,
    DB_PORT: String(database.port),
    DB_NAME: database.name,
    VITE_API_PORT: String(ports.api),
    PUBLIC_API_URL: dependencyOrigins['public-api']
  })
}
```

Then call `preflight()` from whatever starts your dev servers. If the runner reads one of its
`worktreeFiles` first (for example, it loads `.env` itself), inherit those before reading it:

```js
import { inheritWorktreeFiles, preflight } from '@ryanewen/devkit'

await inheritWorktreeFiles({ repoRoot })
// Load .env here, if this runner owns that step.
const devkit = await preflight({ repoRoot })
if (devkit) Object.assign(process.env, devkit.env)   // null when devkit is off
```

`preflight()` brings the selected database service and proxy up, creates or clones this checkout's
database, restores its seed data, inherits missing `worktreeFiles` from the primary checkout,
registers its proxy route, and returns the environment plus the URLs it resolved to. It never
overwrites a worktree file.

Each `dependencies` entry names another project's primary Devkit hostname. Preflight requires a
successful response from its `healthPath` (default `/`) and stops with an actionable error if it is
not available. Dependencies remain separate projects: Devkit never starts or stops them.
Their proxy origins are available to `env()` in `dependencyOrigins`, including a non-default
Devkit proxy port when configured.

Set `browser` to open this checkout automatically after its `healthPath` returns a successful
response. It is opt-in and can be suppressed for one run with `DEVKIT_OPEN_BROWSER=0`. Inside a
VS Code remote terminal, Devkit installs its bundled browser bridge when needed and opens the
project's `*.localhost` URL in the integrated browser. Elsewhere it uses the host's native browser
opener. A failed bridge installation is reported before Devkit falls back to the desktop browser.

Projects with the same `engine` and `version` share one local database server, matching deployments
where several applications use one server. Different versions run concurrently in separate Docker
Compose projects, named volumes and loopback ports. Devkit allocates the port once and persists it;
for example, every project selecting `{ engine: 'mariadb', version: '10.2.44' }` uses the same
MariaDB 10.2.44 profile. The version must be an exact Docker image tag, not an image name, digest or
range.

Leaving `version` out preserves existing installations exactly: PostgreSQL remains
`postgres:16-bookworm` on port 5432 and MariaDB remains `mariadb:12.3.2` on port 3307, using their
existing volumes. Explicitly naming either of those default tags also selects the existing service.
Selecting another version never imports or reuses the unversioned server's databases or baselines.
Versioned MariaDB profiles use utf8mb4 with `utf8mb4_unicode_ci`, permissive
`NO_ENGINE_SUBSTITUTION` mode, a 64 MB packet limit, and the America/New_York timezone. These
explicit settings keep behavior stable across MariaDB image versions.

The returned context includes `database: { engine, version, name, host, port, user, password, url }`. Devkit
itself publishes only what it alone can know: `DATABASE_URL`, `DEVKIT_URL`,
`DEVKIT_HOSTNAME`, and the two Vite settings the **proxy** requires (`VITE_DEV_HOST` and
`VITE_DEV_ALLOWED_HOSTS`). Everything else is your `env()` to name, because only your project knows
which variables its servers read.

## Commands

| Command | What it does |
| --- | --- |
| `devkit doctor` | the state of every precondition, and the command that fixes each |
| `devkit snapshot` | capture this checkout's data as the baseline new checkouts clone |
| `devkit reset` | drop and re-clone this worktree's database (`--empty` skips the baseline) |
| `devkit prune` | drop databases whose worktree is gone (`--yes` to actually drop) |
| `devkit infra` | restart the proxy and this project's selected database profile; outside a repo, start both defaults |
| `devproxy add <name> <port>` | give any dev server a `*.localhost` name, devkit project or not |

`devkit reset` deliberately refuses on the primary checkout: that database is the real dev data a
baseline is captured *from*, not a disposable copy.

PostgreSQL baselines are template databases inside the selected profile. MariaDB baselines are
atomically rotated SQL dump files under `~/.config/devkit/baselines`; imports preserve schema, data, triggers, routines, and
events. The dump uses a consistent transaction, so projects should use transactional tables when a
snapshot must represent one instant. Existing devcontainer or remote MariaDB data is not imported
automatically: load it into the primary Devkit database once, then run `devkit snapshot`.
Database dump filenames and paired filesystem archives include the non-default profile key, so a
snapshot cannot be restored across incompatible server versions accidentally. Existing unversioned
baselines remain untouched and continue to belong only to the default profile.

## Two rules worth knowing

**A worktree needs its own `npm install`.** `node_modules` is per-checkout, and nothing here changes
that. Ignored configuration explicitly listed in `worktreeFiles` is copied from the primary
checkout on first start; caches and every other ignored path stay local.

**Ports are a preference, not a reservation.** The browser reaches your app through the proxy by
hostname, so a port collision is a nuisance rather than data loss. Blocks are hashed from the
checkout slug (which includes the repo name), so two different projects collide no more often than
two worktrees of one; `DEVKIT_PORT_BASE` overrides it for a single checkout.
