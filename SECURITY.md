# Security

## Reporting vulnerabilities

Please do not open a public issue for exploitable vulnerabilities. Use GitHub private vulnerability reporting if available for this repository, or contact the maintainer privately.

For routine hardening ideas, public issues and pull requests are fine.

## Release security

`@streichsbaer/pi-mesh` stages releases through npm Trusted Publishing from GitHub Actions. The release workflow does not use a long-lived `NPM_TOKEN`; npm verifies the GitHub Actions OIDC identity for the configured repository and workflow.

The package release path is:

1. A GitHub Release is published for a version tag.
2. GitHub Actions runs `.github/workflows/publish.yml`.
3. The publish job requests an OIDC token with `id-token: write`.
4. npm verifies the Trusted Publisher configuration.
5. npm stages the package candidate with provenance.
6. A maintainer reviews and approves the staged package in npm with two-factor authentication before it becomes public.

## CI hardening

- Third-party GitHub Actions are pinned to full commit SHAs.
- Workflow permissions are scoped down; normal CI uses `contents: read`.
- The publish workflow grants `id-token: write` only for npm Trusted Publishing.
- `actions/checkout` uses `persist-credentials: false`.
- CI and publish installs use `npm ci --ignore-scripts`.
- Dependency registry signatures are checked with `npm audit signatures`.
- The package manager and runtime are pinned with `packageManager`, `.npmrc`, `.node-version`, and `engines`.
- GitHub Actions policy enforcement requires selected/allowed actions and full-length commit SHA pins.
- Workflow execution policy allows CI on `push` and `pull_request`, allows publishing only through `release.published`, and limits privileged workflow execution to trusted maintainers and automation.

## npm package policy

- npm install scripts are disabled by default through `.npmrc`.
- The package uses a `files` allowlist so releases contain the built CLI, bundled skill, and standard npm metadata.
- npm package publishing and settings changes require two-factor authentication.
- Token-based npm publishing is disabled; releases stage through Trusted Publishing instead of stored npm tokens.
- Staged publishing adds a human approval step before a package becomes public.

If a future dependency requires install-time scripts, prefer a dependency that does not need them. If that is not practical, review and allow only the specific required script rather than enabling lifecycle scripts globally.

## Repository controls

- CI is required before merging to `main`.
- Release and version-tag creation are restricted to maintainers.

## Review guidance

- Review changes to `.github/workflows/**`, `package.json`, `package-lock.json`, `.npmrc`, and release-related docs carefully.
