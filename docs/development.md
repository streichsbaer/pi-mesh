# Development

## Local setup

```bash
npm install
npm run build
npm link
```

Run the CLI directly from source:

```bash
npm run dev -- sessions list
```

## Checks

Use the full local CI command before publishing changes:

```bash
npm run ci
```

That runs TypeScript checks, test TypeScript checks, a build, and the Vitest suite.

## Real Pi smoke tests

Real Pi CLI smoke tests are opt-in because they use live auth/subscription credentials. They copy `auth.json` into an isolated temp Pi agent directory and default to the cheapest configured model, `openai-codex/gpt-5.4-mini`.

```bash
PI_MESH_REAL_E2E=1 npm run test:e2e:real
PI_MESH_REAL_E2E=1 npm run test:e2e:interactive
```

Set `PI_MESH_E2E_MODEL=<provider/model>` to override the model, `PI_MESH_E2E_SOURCE_AGENT_DIR=<dir>` to copy auth from a non-default Pi agent directory, and `PI_MESH_E2E_KEEP=1` to keep the temp folder for debugging.

## Local state

A machine has one durable pi-mesh registry. Session folder and labels are filters, not separate ownership scopes, so each underlying Pi JSONL session can be managed only once.

State is stored outside the repo:

```text
~/.pi/agent/pi-mesh/
  registry.jsonl
  locks/
  socket-dir
```

Live control sockets use short hashed paths under a private randomized runtime directory such as `/tmp/pi-mesh-<uid>-<random>/`.
