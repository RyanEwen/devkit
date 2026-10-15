/**
 * Checks cross-project runtime dependencies without taking ownership of them.
 *
 * Devkit starts shared infrastructure and the current project. Another application remains an
 * independent process with its own checkout, logs, lifecycle and database. A dependency therefore
 * has one contract: its Devkit hostname must already answer its configured health path.
 */

import { normalizeDomain, publicOrigin, proxyRequest } from './host-routing.mjs'
import { fetchHealth } from './health-request.mjs'

/** The browser-facing URL for an independently running project. */
export function dependencyUrl(dependency, settings = {}) {
  const domain = normalizeDomain(typeof settings === 'number' ? undefined : settings.preferredDomain ?? settings.domain)
  return `${publicOrigin(`${dependency.name}.${domain}`, settings)}${dependency.healthPath ?? '/'}`
}

/** Origins exposed to project env functions, keyed by dependency name. */
export function dependencyOrigins(dependencies, settings = {}) {
  return Object.fromEntries(
    dependencies.map((dependency) => [dependency.name, new URL(dependencyUrl(dependency, settings)).origin])
  )
}

/**
 * Returns every failed dependency probe. An HTTP success is required so a stale Traefik route,
 * stopped server, or broken health endpoint all stop the dependent project with the same remedy.
 */
export async function probeProjectDependencies(
  dependencies,
  { config, proxyPort = 80, fetchImpl = fetchHealth, timeoutMs = 2_000 } = {}
) {
  const probes = dependencies.map(async (dependency) => {
    const url = dependencyUrl(dependency, config ?? proxyPort)
    const request = config ? proxyRequest(url, config) : { url }
    try {
      const response = await fetchImpl(request.url, {
        ...(request.headers ? { headers: request.headers } : {}),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      })
      return { dependency, url, ok: response.ok, detail: `HTTP ${response.status}` }
    } catch (error) {
      return { dependency, url, ok: false, detail: error.cause?.message ?? error.message }
    }
  })

  return Promise.all(probes)
}

/** Convenience used by preflight, where successful probes need no output. */
export async function failedProjectDependencies(dependencies, options) {
  return (await probeProjectDependencies(dependencies, options)).filter(({ ok }) => !ok)
}
