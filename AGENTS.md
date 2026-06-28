# Agent Instructions

## Git workflow

- Leave all changes unstaged by default.
- Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks for staging, committing, or pushing.
- If changes are already staged, preserve that staging state unless the user explicitly asks to change it.
- Before any requested staging/commit/push operation, show or verify the relevant `git status` so the user can see what will be affected.

## GitHub communication

- When writing PR messages, PR comments, or release notes, use real newlines instead of escaped `\n` sequences.

## Compatibility and implementation style

- Do not preserve backwards compatibility unless the user explicitly asks for it.
- Prefer one clear implementation path over legacy fallbacks, duplicate paths, or “belt and suspenders” safety layers.
- When replacing behavior, remove the old path rather than keeping parallel behavior for compatibility.
- Keep code direct, intentional, and easy for future coding agents to reason about.
