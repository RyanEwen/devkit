# Devkit Browser Bridge

This private helper receives local project URLs from Devkit and opens them in VS Code's integrated
browser. It publishes VS Code's window-scoped callback to new integrated terminals so requests do
not land in another open editor window. It accepts only HTTP and HTTPS loopback URLs, including
`*.localhost` project hostnames.
