# pi-mesh MVP

## Product shape

`pi-mesh` is a CLI-first coordination layer for Pi sessions.

The primary interface for agents is shell access:

```bash
pi-mesh sessions list --json
pi-mesh sessions list --include-pi --json
pi-mesh models list sonnet --folder ./api --scoped --json
pi-mesh transcript worker-api --last 2 --json
pi-mesh send worker-api "Please review this patch" --delivery follow-up
pi-mesh send worker-api "Use a cheaper model for this check" --model claude-haiku-4-5
```

An Agent Skill ships with the project so Pi, Claude Code, Codex, and other coding agents can learn the CLI on demand.

## Non-goals for MVP

- No MCP bridge.
- No separate room abstraction.
- No custom persistent TUI wrapper.
- No heavyweight always-on daemon.

## Session model

A session is durable; the process is disposable.

### Interactive sessions

`pi-mesh run --name coordinator` starts vanilla Pi interactive mode through the SDK `AgentSessionRuntime`.

Properties:

- normal Pi TUI experience
- process stays alive until user exits
- pi-mesh registers a Unix socket for live inbound messages
- messages can be delivered as prompt, steer, follow-up, or auto

### Sleeping sessions

`pi-mesh spawn --name worker-api --prompt "..."` creates a managed session and runs it headlessly.

Properties:

- session JSONL persists
- process exits when idle
- `pi-mesh send worker-api "..."` wakes the session
- pi-mesh opens the existing JSONL session through the SDK, runs the turn, waits for idle, updates the registry, and exits

### Attached sessions

`pi-mesh attach <session|session-file>` opens an existing Pi JSONL session in vanilla Pi TUI and registers it with pi-mesh.

For unmanaged already-running Pi sessions, users should close the original Pi process before attaching to avoid two processes writing to the same JSONL file.

## Default developer experience

- Use `pi-mesh run` when you want an open human-facing coordinator TUI.
- Use `pi-mesh spawn` when you want workers. Spawned workers sleep by default.
- Use `pi-mesh spawn --attach` when you want to create a new session and immediately drop into vanilla Pi TUI.
- There is no ambiguous non-sleeping background spawn mode in MVP. A non-sleeping session is an interactive `run` session.

## Local registry, folders, names, and labels

A machine has one durable pi-mesh registry. The session folder is where Pi runs for that session; names and labels are non-unique metadata for filtering and grouping.

Common filters:

```bash
pi-mesh sessions list --folder ./api
pi-mesh sessions list --name worker-api
pi-mesh sessions list --label pi-mesh-development
```

Storage:

```text
~/.pi/agent/pi-mesh/
  registry.jsonl
  locks/
  socket-dir
```

Live control sockets use short hashed paths under a private randomized runtime directory such as `/tmp/pi-mesh-<uid>-<random>/`.

The registry is append-only JSONL so crashes do not corrupt the whole registry. Each underlying Pi JSONL session can be managed only once in the local registry.

`pi-mesh sessions delete <session>` removes a stopped managed session from the registry. Active sessions, including records with a live process or socket, must be stopped first. The underlying Pi JSONL session file is kept by default and removed only with `--delete-file` after confirmation; pass `--force` to skip that file-delete confirmation.

## Message delivery

`pi-mesh send [<session>] <message> [--folder <dir>] [--name <name>] [--label <label>] [--all] --delivery ... [--model <ref>] [--thinking <level>]`

Modes:

- `auto`: if live and busy, queue as follow-up; if idle/offline, start a normal prompt
- `prompt`: start a prompt only if idle
- `steer`: steer an active live session; for sleeping/offline sessions it behaves like prompt
- `follow-up`: queue after active work; for sleeping/offline sessions it behaves like prompt

For sleeping sessions, there is no active turn to steer, so delivery collapses to a normal prompt when waking. If a selector matches multiple sessions, `send` fails unless `--all` is present.

## Model selection

`spawn`, `run`, `attach`, and `send` accept `--model <provider/model-or-id>`, optional `--provider <name>`, and `--thinking off|minimal|low|medium|high|xhigh`. `--model model:thinking` is also accepted. Model and thinking changes are recorded in the Pi session JSONL using Pi's normal session entries once a turn is materialized; until then, a pending model seed is kept in the managed-session registry. pi-mesh rejects unknown models, ambiguous model references, invalid thinking levels, and live busy model changes before delivering a message.

`pi-mesh models list [search] [--folder <dir>] [--json] [--all] [--scoped]` inspects Pi-configured models for a folder. Use `--folder <session-folder>` when checking the model/settings scope for a target session. By default it lists auth-configured available models. `--all` includes known models without auth, and `--scoped` filters to Pi `enabledModels` settings.

## Existing session discovery

`pi-mesh sessions list` shows managed sessions by default. Pass `--include-pi` or `--all` to include recent unmanaged Pi sessions.

The parser reads normal Pi JSONL sessions from:

```text
~/.pi/agent/sessions/
```

It reconstructs the active branch, user/assistant messages, tool calls, tool results, turns, and failures.

This is read-only. Live message injection requires a pi-mesh-managed process/socket or closing and reattaching the session.

## Future work

- Git worktree spawning.
- Richer status and process supervision.
- Optional machine protocol for dashboards, if the CLI stops being sufficient.
