const vscode = require('vscode')

const { isAllowedProjectUrl } = require('./url.cjs')

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

function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))
}

module.exports = { activate }
