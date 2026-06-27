---
name: pi-mesh
description: Coordinate local Pi sessions using the pi-mesh CLI. Use when the user asks to discover Pi sessions, read another session's transcript/state, send messages between Pi sessions, spawn worker sessions, attach existing sessions, or coordinate multiple coding agents through Pi.
---

# Pi Mesh

Use the `pi-mesh` CLI to discover, inspect, message, and spawn local Pi sessions.

## Mental model

- `pi-mesh run` starts or resumes a vanilla Pi TUI session and keeps it live until the user exits.
- `pi-mesh spawn` creates a sleeping/headless managed session by default. It runs when messaged, then exits when idle.
- `pi-mesh send` sends a user prompt to managed session selectors. If a session is sleeping, it wakes it, resumes its JSONL, runs the turn, and shuts it down again.
- Existing unmanaged Pi sessions can be read. To send to one, ask the user to close it and run `pi-mesh attach <session-file>`.

## Discover sessions

```bash
pi-mesh sessions list --json
pi-mesh sessions list --include-pi --json
pi-mesh sessions find "auth" --json
pi-mesh models list sonnet --folder <session-folder> --scoped --json
```

`list` shows managed sessions from the machine-local registry by default; filter with `--folder`, `--name`, or `--label`, and add `--include-pi` or `--all` for recent unmanaged Pi sessions. `models list` shows Pi-configured models; pass `--folder <session-folder>` for the target session/settings scope, add `--scoped` for Pi `enabledModels`, and add `--all` for unauthenticated known models. Use JSON output when another agent needs to consume the result.

## Read state and transcript

```bash
pi-mesh state <session> --json
pi-mesh transcript <session> --last 3 --json
pi-mesh transcript <session> --last 1 --show-tools
```

`<session>` may be a managed session id/name, a Pi raw session id, a query, or a `.jsonl` path. Names are not unique; add `--folder` or `--label` when needed.

## Send a message

```bash
pi-mesh send <session> "Please inspect the failing tests" --delivery auto
pi-mesh send <session> "After you finish, summarize your changes" --delivery follow-up
pi-mesh send <session> "Stop and check the logs first" --delivery steer
pi-mesh send <session> "Use a cheaper model for this check" --model claude-haiku-4-5
pi-mesh send --label pi-mesh-development --all "Report current status"
```

Delivery modes:

- `auto`: safest default
- `prompt`: only for idle live sessions; starts a normal prompt
- `steer`: steer active work when live; for sleeping sessions it behaves like a normal prompt
- `follow-up`: queue after active work when live; for sleeping sessions it behaves like a normal prompt

Use `--model <provider/model>`, `--provider <name> --model <id>`, or a unique model id to select a model for `spawn`, `run`, `attach`, or `send`. `--model model:thinking` and `--thinking off|minimal|low|medium|high|xhigh` are supported; explicit `--thinking` wins. Model choices are stored in the Pi session history.

Use `--stream` if you want to display the headless turn output in the current terminal:

```bash
pi-mesh send worker-api "Fix the auth test" --stream
```

## Spawn workers

```bash
pi-mesh spawn --name worker-api --folder ./api --label pi-mesh-development --model anthropic/claude-sonnet-4-5 --prompt "Investigate the auth test failure"
pi-mesh spawn --name worker-ui --folder ./ui
```

Spawned workers sleep by default. They do not keep a TUI open.

To create a session and immediately open vanilla Pi TUI:

```bash
pi-mesh spawn --name coordinator --folder . --label pi-mesh-development --attach
```

## Run or attach interactive sessions

```bash
pi-mesh run --name coordinator --folder . --label pi-mesh-development
pi-mesh attach /path/to/session.jsonl --name old-session
```

The TUI is vanilla Pi. Do not ask for a custom persistent TUI wrapper; this project intentionally avoids one.

## Coordination pattern

For a coordinator session:

1. List managed sessions: `pi-mesh sessions list --json`
2. Spawn workers for separate tasks.
3. Send each worker a concrete prompt.
4. Read worker transcripts or state.
5. Send follow-up prompts as needed.

Example:

```bash
pi-mesh spawn --name scout-api --folder ./api --prompt "Find the auth code and summarize risks"
pi-mesh transcript scout-api --last 1 --json
pi-mesh send scout-api "Now propose the smallest safe fix" --stream
```

## Safety

This project assumes unrestricted local agents. Still, avoid two processes writing to the same Pi JSONL file. pi-mesh keeps one central local registry so a Pi JSONL session is managed once; if attaching an unmanaged existing session, close the original Pi process first.
