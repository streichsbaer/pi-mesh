
<h1 align="center">pi-mesh — local session mesh for Pi</h1>


<p align="center">
  <img src="assets/logo-512.png" alt="pi-mesh logo" width="240" />
</p>


`pi-mesh` is a local CLI and Agent Skill for coordinating multiple [Pi](https://github.com/earendil-works/pi) coding-agent sessions.

The CLI binary is `pi-mesh`.

## Goals

- Keep vanilla Pi TUI for interactive use.
- Let coding agents discover, inspect, and message Pi sessions through a CLI.
- Support sleeping managed sessions: session state persists, but the Pi process exits when idle.
- Wake sleeping sessions on demand, resume the JSONL session, run a turn, and shut down again.
- Avoid MCP and heavyweight daemons for the MVP.

## Install for development

```bash
npm install
npm run build
npm link
```

Or run directly:

```bash
npm run dev -- sessions list
```

## Common commands

```bash
pi-mesh sessions list
pi-mesh sessions find auth
pi-mesh transcript <session> --last 3
pi-mesh state <session>

# Create a sleeping/headless managed worker. It exits when idle.
pi-mesh spawn --name worker-api --cwd ./api --prompt "Inspect the auth tests"

# Wake a sleeping session, run one turn, then shut down again.
pi-mesh send worker-api "Fix the failing auth test" --stream

# Start or resume a vanilla Pi TUI with a live pi-mesh socket.
pi-mesh run --name coordinator --cwd .

# Attach an existing Pi JSONL session to vanilla Pi TUI and register it with pi-mesh.
pi-mesh attach /path/to/session.jsonl --name old-session
```

## Lifecycle defaults

- `pi-mesh run` is interactive and keeps the vanilla Pi TUI process alive until you quit.
- `pi-mesh spawn` is sleeping/headless by default.
- `pi-mesh spawn --attach` creates a session and immediately opens it in vanilla Pi TUI.
- `pi-mesh send` uses a live socket when a managed TUI session is running; otherwise it wakes the sleeping session headlessly.

## Workspace storage

A workspace is the coordination scope for a group of sessions. By default it is the current git root, falling back to the current directory.

State is stored outside the repo:

```text
~/.pi/agent/pi-mesh/workspaces/<workspace-hash>/
  registry.jsonl
  inbox/
  locks/
  sockets/
```

## Existing Pi sessions

Already-running normal Pi sessions can be discovered and read from their JSONL files. To message one, close the original process first and attach/resume it through `pi-mesh attach` so pi-mesh can own the live control socket.

## License

MIT
