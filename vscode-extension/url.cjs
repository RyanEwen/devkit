const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const path = require('node:path')

const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/** The workspace extension runs on the development host, where the machine marker lives. */
function configuredDomains(env = process.env) {
  const directory = env.DEVKIT_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'devkit')
  try {
    const settings = JSON.parse(readFileSync(path.join(directory, 'host.json'), 'utf8'))
    if (!settings || settings.enabled === false) return []
    return [settings.domain || 'localhost', ...(Array.isArray(settings.secondaryDomains) ? settings.secondaryDomains : [])]
      .filter((domain) => typeof domain === 'string' && domain.length <= 253)
      .map((domain) => domain.toLowerCase().replace(/\.$/, ''))
      .filter((domain) => domain.split('.').every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
  } catch {
    return []
  }
}

function isAllowedProjectUrl(value, domains = []) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (allowedHosts.has(url.hostname) || url.hostname.endsWith('.localhost') ||
        domains.some((domain) => url.hostname.endsWith(`.${domain}`)))
  } catch {
    return false
  }
}

module.exports = { configuredDomains, isAllowedProjectUrl }
