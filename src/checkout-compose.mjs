/**
 * Builds the one Docker Compose invocation shared by containerized Devkit projects.
 *
 * The checkout database definition comes first so its service and named volume join the same
 * Compose project as the repository's application services. Project files remain repository-owned
 * because only the project knows its mounts, commands, and internal ports.
 */
export function checkoutCompose(state, { files = [], env = {}, projectDirectory } = {}) {
  if (!state?.identity?.composeProject || !state?.compose) {
    throw new Error('devkit: checkoutCompose requires a completed preflight state')
  }

  const composeFiles = [...state.compose.files, ...files]
  if (!projectDirectory) throw new Error('devkit: checkoutCompose requires the project directory')

  const args = [
    'compose',
    '--env-file', '/dev/null',
    '--project-directory', projectDirectory,
    '-p', state.identity.composeProject
  ]
  for (const file of composeFiles) args.push('-f', file)

  return {
    command: 'docker',
    args,
    env: {
      ...process.env,
      ...state.compose.env,
      ...state.env,
      ...env
    }
  }
}
