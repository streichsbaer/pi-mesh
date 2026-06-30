<h1 align="center">pi-mesh — local session mesh for Pi</h1>

<p align="center">
  <img src="assets/logo-512.png" alt="pi-mesh logo" width="240" />
</p>

`pi-mesh` is a local CLI and Agent Skill for discovering, inspecting, and messaging multiple [Pi](https://github.com/earendil-works/pi) coding-agent sessions.

It keeps the normal Pi TUI for interactive work, while giving agents and scripts a small command-line surface for coordination.

## Installation

```bash
npm install -g @streichsbaer/pi-mesh --ignore-scripts
```

The package installs the `pi-mesh` binary and does not require npm install scripts.

Install or refresh the global Agent Skill after installation or upgrade:

```bash
pi-mesh setup skill
```

This always writes `~/.agents/skills/pi-mesh` and also writes `~/.claude/skills/pi-mesh` when `~/.claude` exists. To install into a custom skills root instead, use `pi-mesh setup skill --folder <skills-root>`.

## How it works

- `pi-mesh run` starts or resumes an interactive Pi TUI session and keeps it live.
- `pi-mesh spawn` creates a sleeping/headless managed session that wakes when messaged.
- `pi-mesh send` delivers work to a managed session by id, name, folder, or label.
- Existing Pi sessions can be inspected read-only; close and attach one before sending to it.

## Common use cases

```bash
# Check the installed version and refresh the Agent Skill.
pi-mesh version
pi-mesh setup skill

# Discover sessions.
pi-mesh sessions list
pi-mesh sessions find auth

# Inspect a session.
pi-mesh transcript <session> --last 3
pi-mesh state <session>

# Start a sleeping worker and send it follow-up work.
pi-mesh spawn --name worker-api --folder ./api --label pi-mesh-development --model anthropic/claude-sonnet-4-5 --prompt "Inspect the auth tests"
pi-mesh send worker-api "Fix the failing auth test" --stream

# Broadcast intentionally to every matching session.
pi-mesh send --label pi-mesh-development --all "Please report status."

# Change model or thinking level for a turn.
pi-mesh send worker-api "Use a cheaper model for this check" --model claude-haiku-4-5
pi-mesh send worker-api "Think deeply about this migration" --thinking high

# Start a live coordinator TUI, or attach an existing Pi JSONL session.
pi-mesh run --name coordinator --folder . --label pi-mesh-development
pi-mesh attach /path/to/session.jsonl --name existing-session
```

Names and labels are not unique. Use a stable session id, `--folder`, `--name`, or `--label` to narrow a target; pass `--all` only when you intentionally want to broadcast.

## More docs

- [Development](docs/development.md)
- [Release process](docs/release.md)
- [Security](SECURITY.md)

## License

MIT
