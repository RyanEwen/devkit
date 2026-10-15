/** Readiness requests must preserve Host: recent Node fetch implementations discard that header. */
import http from 'node:http'

export async function fetchHealth(url, options = {}, redirects = 0) {
  const host = options.headers?.Host
  if (!host) return fetch(url, options)

  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: options.headers, signal: options.signal }, (response) => {
      response.resume()
      const status = response.statusCode
      if (options.redirect === 'follow' && [301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        if (redirects >= 5) return reject(new Error('too many readiness redirects'))
        try {
          const current = new URL(url)
          const publicUrl = new URL(`${options.headers['X-Forwarded-Proto'] ?? 'http'}://${host}${current.pathname}${current.search}`)
          const destination = new URL(response.headers.location, publicUrl)
          // Keep same-origin redirects on the private proxy; an external login page is not readiness.
          if (destination.host === publicUrl.host && ['http:', 'https:'].includes(destination.protocol)) {
            current.pathname = destination.pathname
            current.search = destination.search
            return resolve(fetchHealth(current.href, options, redirects + 1))
          }
        } catch (error) {
          return reject(error)
        }
      }
      resolve({ ok: status >= 200 && status < 300, status })
    })
    request.on('error', reject)
  })
}
