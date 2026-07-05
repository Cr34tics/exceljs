---
name: release
description: Release/publish flow for @cr34tics/exceljs — cutting a new version, creating the GitHub Release tag, publishing to GitHub Packages, and merging the sync-version PR. Use for any "release", "publish", "cut a version", "bump version", or "deploy the package" request.
---

# Releasing @cr34tics/exceljs

This fork publishes to GitHub Packages (npm.pkg.github.com), NOT public npm. The GitHub Release
tag is the version source of truth — publish.yml derives the published version from it. The
committed `package.json` version is synced afterwards, automatically.

## Flow

1. Confirm master is green:

   ```bash
   gh run list --workflow=tests.yml --branch=master --limit=3
   ```

2. Decide semver from Conventional Commits since the last tag:

   ```bash
   git fetch --tags origin
   git log "$(git describe --tags --abbrev=0)"..origin/master --oneline
   ```

   feat → minor, fix/perf → patch, breaking change → major.

3. Create the GitHub Release with tag `vX.Y.Z` (plain semver, `v` prefix; the workflow strips it):

   ```bash
   gh release create vX.Y.Z --target master --title "vX.Y.Z" --generate-notes
   ```

   Publishing the release fires `.github/workflows/publish.yml`. A draft release does NOT trigger
   it (trigger is `release: [published]`) — but publishing a **prerelease** DOES fire it and will
   publish the package, so don't use prereleases casually.

4. Watch the publish run:

   ```bash
   gh run watch "$(gh run list --workflow=publish.yml --limit=1 --json databaseId -q '.[0].databaseId')"
   ```

   What it does (see `.github/workflows/publish.yml`): checkout, Node 24 + npm.pkg.github.com
   registry, corepack, `yarn install --immutable`, `yarn build`, resolve version from the release
   tag, `npm pkg set version` (deliberately bypasses preversion/postversion hooks), `npm publish`
   with GITHUB_TOKEN.

5. Merge the auto-opened sync PR. The `sync-version` job opens `chore/sync-version-X.Y.Z` bumping
   `package.json` on master (no PR appears if master already matches):

   ```bash
   gh pr list --search "chore(release): sync package.json"
   gh pr merge <num> --merge   # repo convention: merge commits, never squash
   ```

6. Sanity check: `gh release view vX.Y.Z` and confirm the new version under the repo's Packages.

## Recovery

- Publish run failed before `npm publish`: fix, then re-run the workflow run
  (`gh run rerun <id>`) — version still comes from the release tag.
- Need to re-publish or publish out-of-band: `gh workflow run publish.yml -f version=X.Y.Z`
  (workflow_dispatch fallback; no sync-version PR in this path, so sync `package.json` manually
  via a chore PR if needed).

## Do NOT

- Do NOT run `npm publish` / `yarn npm publish` locally. CI is the only publisher.
- Do NOT bump `package.json` `version` in feature PRs — the sync-version PR owns that field.
- Do NOT use `yarn version` / rely on preversion/postversion as the release path. Those hooks
  exist for a local flow (build + test:version + git push) and are NOT the normal release path;
  publish.yml bypasses them on purpose.
- Do NOT push a bare git tag and expect a publish — the trigger is a _published GitHub Release_,
  not a tag push.
- Do NOT create the tag from a non-master ref; releases cut from master (`--target master`).

## Consuming the package (for reference)

Requires an `.npmrc` with `@cr34tics:registry=https://npm.pkg.github.com` and a token with
`read:packages`.
