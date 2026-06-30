# Release Process

Use this checklist for each npm release.

## Prepare

1. Confirm the working tree and index contain only the intended release changes:

```bash
git status -sb
git diff --cached --stat
git diff --stat
```

2. Bump `package.json` and `package-lock.json`:

```bash
npm version patch --no-git-tag-version
```

3. Run the release checks:

```bash
npm ci --ignore-scripts
npm audit signatures
npm run ci
npm pack --dry-run --ignore-scripts
```

4. Confirm the packed files are expected.
5. Commit, push, open a PR, and merge after CI passes.

## Publish

Create the version tag on the merged `main` commit:

```bash
git fetch origin
git switch main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then publish a GitHub Release using the existing tag:

1. Open GitHub Releases.
2. Draft a new release.
3. Select the existing tag `vX.Y.Z` from the tag dropdown.
4. Use `vX.Y.Z` as the release title.
5. Publish the release.

Do not create the release by targeting `main` directly. The publish workflow should run with `headBranch` equal to the version tag, for example `v0.1.6`. If it runs with `headBranch: main`, npm Trusted Publishing can reject the provenance bundle with an error like `Missing SourceRepositoryRef in signing certificate`.

## Verify

Watch the `Publish Package` workflow. It should run:

- `npm ci --ignore-scripts`
- `npm audit signatures`
- `npm run ci`
- `npm pack --dry-run --ignore-scripts`
- `npm stage publish --access public --ignore-scripts`

The workflow stages the package candidate. It does not make the package public until a maintainer approves the staged package in npm with two-factor authentication.

Before approving the staged package:

1. Check the package name and version.
2. Check the provenance/source repository and workflow run.
3. Check the package contents match the `npm pack --dry-run` output.
4. Approve the staged package in npm.

Verify npm after approval:

```bash
npm view @streichsbaer/pi-mesh version dist-tags.latest dist.attestations
```

Smoke-test a fresh install:

```bash
tmp="$(mktemp -d)"
npm install --prefix "$tmp/prefix" --global @streichsbaer/pi-mesh --ignore-scripts
"$tmp/prefix/bin/pi-mesh" --help
```
