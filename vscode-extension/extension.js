const vscode = require('vscode')

const { isAllowedProjectUrl } = require('./url.cjs')

const extensionId = 'ryanewen.devkit-browser'
const browserUriVariable = 'DEVKIT_VSCODE_BROWSER_URI'

async function handleUri(uri) {
  if (uri.path !== '/open') return

  const target = new URLSearchParams(uri.query).get('url')
  if (!target || !isAllowedProjectUrl(target)) return

  const commands = await vscode.commands.getCommands(true)
  const command = commands.includes('workbench.action.browser.open')
    ? 'workbench.action.browser.open'
    : 'simpleBrowser.show'
  await vscode.commands.executeCommand(command, target)
}

/**
 * Publishes a callback URI carrying VS Code's current window identifier.
 *
 * VS Code adds the identifier in `asExternalUri`; constructing the same `vscode://` URI outside
 * the extension would cause the desktop dispatcher to send it to the last-focused editor window.
 * New terminals inherit this callback and can therefore return browser requests to this window.
 */
async function publishWindowCallback(context) {
  const callback = await vscode.env.asExternalUri(
    vscode.Uri.parse(`${vscode.env.uriScheme}://${extensionId}/open`)
  )
  const environment = context.environmentVariableCollection
  environment.persistent = false
  environment.description = 'Routes Devkit browser tabs back to this VS Code window.'
  environment.replace(browserUriVariable, callback.toString())
}

async function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))
  await publishWindowCallback(context)
}

module.exports = { activate }
