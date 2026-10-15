/** Machine routing settings shared by the CLI, checkout identities, and URL consumers. */
import { isIP } from 'node:net'

export function normalizeDomain(value = 'localhost') {
  if (typeof value !== 'string') throw new Error('domain must be a hostname suffix')
  const domain = value.toLowerCase().replace(/\.$/, '')
  if (domain.length > 253 || !domain.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ) || isIP(domain)) {
    throw new Error('domain must be a hostname suffix, such as localhost or server.home')
  }
  return domain
}

function port(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return value
}

export function normalizeHostRouting(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('host settings must be an object')
  }
  const domain = normalizeDomain(settings.domain)
  if (settings.secondaryDomains !== undefined && !Array.isArray(settings.secondaryDomains)) {
    throw new Error('secondaryDomains must be an array of hostname suffixes')
  }
  const secondaryDomains = [...new Set((settings.secondaryDomains ?? []).map(normalizeDomain))]
    .filter((secondary) => secondary !== domain)
  const preferredDomain = normalizeDomain(settings.preferredDomain ?? domain)
  if (![domain, ...secondaryDomains].includes(preferredDomain)) {
    throw new Error('preferredDomain must be the primary domain or one of secondaryDomains')
  }
  const proxyPort = port(settings.proxyPort ?? 80, 'proxyPort')
  const publicScheme = settings.publicScheme ?? 'http'
  if (!['http', 'https'].includes(publicScheme)) throw new Error('publicScheme must be http or https')
  const publicPort = port(settings.publicPort ?? (publicScheme === 'https' ? 443 : proxyPort), 'publicPort')
  const proxyNetwork = settings.proxyNetwork ?? 'bridge'
  if (!['bridge', 'host'].includes(proxyNetwork)) throw new Error('proxyNetwork must be bridge or host')
  const proxyBindAddress = settings.proxyBindAddress ?? '127.0.0.1'
  if (!isIP(proxyBindAddress) || ['0.0.0.0', '::'].includes(proxyBindAddress)) {
    throw new Error('proxyBindAddress must be a specific interface IP address, not a wildcard bind')
  }
  if (proxyNetwork === 'bridge' && proxyBindAddress !== '127.0.0.1') {
    throw new Error('proxyBindAddress requires proxyNetwork: host; bridge mode publishes on loopback')
  }
  return { domain, secondaryDomains, preferredDomain, proxyPort, publicScheme, publicPort, proxyNetwork, proxyBindAddress }
}

export function checkoutHostnames(identity) {
  return [identity.hostname, ...(identity.secondaryHostnames ?? [])]
}

export function checkoutOrigins(identity, config) {
  return checkoutHostnames(identity).map((hostname) => publicOrigin(hostname, config))
}

/** Permanent route filenames keep the primary suffix even when another domain is preferred. */
export function proxyHostnames(raw, settings = {}) {
  const config = normalizeHostRouting(settings)
  const host = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!host) throw new Error('a hostname is required')
  const domains = [config.domain, ...config.secondaryDomains]
  const suffix = [...domains].sort((a, b) => b.length - a.length)
    .find((domain) => host.endsWith(`.${domain}`))
  const name = suffix ? host.slice(0, -(suffix.length + 1)) : host
  const hostname = normalizeDomain(`${name}.${config.domain}`)
  const orderedDomains = [config.preferredDomain, ...domains.filter((domain) => domain !== config.preferredDomain)]
  return { hostname, hostnames: orderedDomains.map((domain) => normalizeDomain(`${name}.${domain}`)) }
}

/** A numeric second argument preserves the established dependency URL helper API. */
export function publicOrigin(hostname, settings = {}) {
  const { publicScheme, publicPort } = normalizeHostRouting(
    typeof settings === 'number' ? { proxyPort: settings } : settings
  )
  const defaultPort = publicScheme === 'https' ? 443 : 80
  return `${publicScheme}://${hostname}${publicPort === defaultPort ? '' : `:${publicPort}`}`
}

/** Probe Traefik directly without requiring LAN DNS, nginx auth, or a client CA on the server. */
export function proxyRequest(publicUrl, settings) {
  const config = normalizeHostRouting(settings)
  const target = new URL(publicUrl)
  const host = config.proxyBindAddress.includes(':') ? `[${config.proxyBindAddress}]` : config.proxyBindAddress
  return {
    url: `http://${host}:${config.proxyPort}${target.pathname}${target.search}`,
    headers: { Host: target.host, 'X-Forwarded-Proto': config.publicScheme }
  }
}
