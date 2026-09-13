/** Resolves the database container owned by one checkout. */
import { checkoutPorts } from './checkout-identity.mjs'

export const DEFAULT_DATABASE_VERSIONS = {
  postgres: '16-bookworm',
  mariadb: '12.3.2'
}

export function selectDatabaseRuntime(config, project, identity, { hostPort } = {}) {
  const engine = project.database.engine
  const version = project.database.version ?? DEFAULT_DATABASE_VERSIONS[engine]
  if (!DEFAULT_DATABASE_VERSIONS[engine]) throw new Error(`devkit: unsupported database engine ${engine}`)
  if (!identity?.composeProject) throw new Error('devkit: a checkout identity is required')

  const resolvedHostPort = project.database.hostAccess
    ? hostPort ?? checkoutPorts(identity, project.ports).base + 9
    : null
  const runtime = {
    engine,
    version,
    key: `${engine}-${version.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    project: identity.composeProject,
    service: 'database',
    composeFile: `${config.infraDir}/${engine}.yml`,
    volume: `${identity.composeProject}-database`,
    hostPort: resolvedHostPort
  }
  if (project.database.hostAccess && !Number.isInteger(runtime.hostPort)) {
    throw new Error('devkit: database host access requires a derived host port')
  }
  const connection = {
    ...config[engine],
    host: 'database',
    port: engine === 'mariadb' ? 3306 : 5432
  }
  return { ...config, [engine]: connection, databaseRuntime: runtime }
}
