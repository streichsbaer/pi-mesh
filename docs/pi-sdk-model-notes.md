# Pi SDK model integration notes

pi-mesh uses Pi's public SDK surfaces for model discovery:

- `createAgentSessionServices({ cwd })` to load cwd-sensitive Pi settings, auth, custom `models.json`, and extension-registered providers.
- `services.modelRegistry.getAvailable()` for auth-configured models.
- `services.modelRegistry.getAll()` for all known models, including models without configured auth.
- `services.settingsManager.getEnabledModels()` for Pi's scoped model/cycling patterns.
- `getDefaultProvider()`, `getDefaultModel()`, and `getDefaultThinkingLevel()` for defaults.

## Current SDK gap

Pi does not currently expose stable public helpers for CLI-equivalent model resolution or scoped-model resolution. In particular, the useful internal helpers analogous to Pi CLI's model parsing and `enabledModels` pattern resolution are not exported from the package API.

As a result, pi-mesh currently has to duplicate or approximate some Pi CLI behavior:

- resolving `--model <provider/model>`, unique model IDs, and `model:thinking` shorthands for session model selection;
- matching Pi `enabledModels` patterns for `pi-mesh models list --scoped`.

This should be considered a compatibility risk rather than a desired long-term design. A future Pi issue should request a public, process-safe SDK API for:

```ts
resolveModelReference({ modelRegistry, provider, model, thinking, requireAuth, strict })
resolveModelScope({ modelRegistry, patterns })
```

Those helpers should avoid console output and `process.exit`, return structured warnings/errors, and match Pi CLI semantics exactly.
