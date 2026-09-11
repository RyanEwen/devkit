const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

function isAllowedProjectUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) &&
      (allowedHosts.has(url.hostname) || url.hostname.endsWith('.localhost'))
  } catch {
    return false
  }
}

module.exports = { isAllowedProjectUrl }
