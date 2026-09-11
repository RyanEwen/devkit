import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkoutCompose } from '../src/checkout-compose.mjs'

test('checkout Compose combines the database and application definitions under one project', () => {
  const invocation = checkoutCompose({
    identity: { composeProject: 'app-wt-fix-login' },
    compose: {
      files: ['/config/mariadb.yml'],
      env: { DEVKIT_DATABASE_IMAGE: 'mariadb:10.2.44' }
    },
    env: { DB_HOST: 'database', VITE_DEV_PORT: '5173' }
  }, {
    files: ['/workspace/compose.dev.yml'],
    projectDirectory: '/workspace',
    env: { DEVKIT_WEB_PORT: '23456' }
  })

  assert.equal(invocation.command, 'docker')
  assert.equal(invocation.cwd, '/workspace')
  assert.deepEqual(invocation.args, [
    'compose', '--env-file', '/dev/null', '--project-directory', '/workspace',
    '-p', 'app-wt-fix-login',
    '-f', '/config/mariadb.yml',
    '-f', '/workspace/compose.dev.yml'
  ])
  assert.equal(invocation.env.DB_HOST, 'database')
  assert.equal(invocation.env.DEVKIT_WEB_PORT, '23456')
})
