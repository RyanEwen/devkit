# Devkit Browser Bridge

This private helper receives project URLs from Devkit and opens them in VS Code's integrated
browser. It publishes VS Code's window-scoped callback to new integrated terminals so requests do
not land in another open editor window. It accepts HTTP and HTTPS loopback URLs, including
`*.localhost`, and project names under domains configured in the development host's Devkit marker.
It runs in the workspace extension host so remote domains are read from the server's configuration.
