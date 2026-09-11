/**
 * Checks cross-project runtime dependencies without taking ownership of them.
 *
 * Devkit starts shared infrastructure and the current project. Another application remains an
 * independent process with its own checkout, logs, lifecycle and database. A dependency therefore
 * has one contract: its Devkit hostname must already answer its configured health path.
 */

/** The URL that Traefik should serve for an independently running project. */
export function dependencyUrl(dependency, proxyPort = 80) {
  const port = proxyPort === 80 ? '' : `:${proxyPort}`
  return `http://${dependency.name}.localhost${port}${dependency.healthPath ?? '/'}`
}

/** Origins exposed to project env functions, keyed by dependency name. */
export function dependencyOrigins(dependencies, proxyPort = 80) {
  return Object.fromEntries(
    dependencies.map((dependency) => [dependency.name, new URL(dependencyUrl(dependency, proxyPort)).origin])
  )
}

/**
 * Returns every failed dependency probe. An HTTP success is required so a stale Traefik route,
 * stopped server, or broken health endpoint all stop the dependent project with the same remedy.
 */
export async function probeProjectDependencies(
  dependencies,
  { proxyPort = 80, fetchImpl = fetch, timeoutMs = 2_000 } = {}
) {
  const probes = dependencies.map(async (dependency) => {
    const url = dependencyUrl(dependency, proxyPort)
    try {
      const response = await fetchImpl(url, {
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
