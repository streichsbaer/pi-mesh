# CI Security Notes

This project treats GitHub Actions workflow dependencies as supply-chain inputs.

## GitHub Actions

- Actions are pinned to full commit SHAs in `.github/workflows/ci.yml`.
- A trailing comment records the human-readable upstream release tag.
- Dependabot checks GitHub Actions weekly so pinned SHAs can be reviewed and updated intentionally.
- The workflow grants the default `GITHUB_TOKEN` only `contents: read`.
- `actions/checkout` runs with `persist-credentials: false` so later test commands do not inherit a repository write token.

## Node Version

CI tests the package on Node 24 LTS:

- Node 24 is the minimum supported runtime in `package.json`.
- Node 26 can be checked ad hoc while it is Current, but it is not part of the default required CI path until the project chooses to adopt it.

The CLI session tests use a larger timeout because they spawn `tsx src/cli.ts` subprocesses and pay repeated TypeScript startup cost.
