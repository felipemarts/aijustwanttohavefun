# The embedded interface

`dist/` is embedded into the binary (`//go:embed all:dist` in `webui.go`) and served at `/` by the core's HTTP
server. Today it holds a small placeholder page. The real interface is the web export of `clients/mobile`
(`cd clients/mobile && npm run export:web`, output in `clients/mobile/dist/`): copy that output into this `dist/`
folder, replacing the placeholder, then rebuild the Go program.
