# Release HooKit to npm

This guide shows maintainers how to version HooKit, review GitHub's generated
release notes, and publish the corresponding npm package.

## Prepare npm and GitHub

Before the first release:

1. Create a GitHub Environment named `npm`.
2. Add an `NPM_TOKEN` secret from an npm account that owns the `@meffmadd`
   scope and can create and publish the public `@meffmadd/hookit` package.
3. Work from a clean, up-to-date `main` branch whose `origin` is
   `meffmadd/HooKit`.

The publish workflow runs only when a draft GitHub Release is published. Merely
creating or editing a draft does not publish to npm.

## Publish version 0.1.0

The manifests already contain version `0.1.0`, so create the initial tag without
running bumpp:

```bash
npm run check
git tag --annotate v0.1.0 --message "Release v0.1.0"
git push origin v0.1.0
```

On GitHub, open **Releases**, select **Draft a new release**, choose `v0.1.0`,
and select **Generate release notes**. Save the draft, review GitHub's generated
title and notes, and select **Publish release**. The `publish npm` workflow checks out `v0.1.0`, reruns the
complete project gate, verifies the tag against `package.json`, inspects the npm
tarball, and publishes it.

Verify the release after the workflow succeeds:

```bash
npm view @meffmadd/hookit@0.1.0
pi -e npm:@meffmadd/hookit@0.1.0
```

Run `/hooks` in Pi to complete the smoke test.

## Publish a later version

Use bumpp to update `package.json` and `package-lock.json`, run the project gate,
commit the version, create an annotated `vX.Y.Z` tag, and push the commit and
tag:

```bash
npm run release:bump -- --release patch
```

Use `minor`, `major`, or an exact version such as `0.2.0` instead of `patch`
when appropriate. On GitHub, draft a Release for the new tag and select
**Generate release notes**. Review and publish the draft to trigger npm
publication.

## Move to npm trusted publishing

After `0.1.0` exists on npm, configure a GitHub Actions trusted publisher in the
package settings for repository `meffmadd/HooKit`, workflow `publish.yml`, and
environment `npm`. Then update the workflow to npm 11 or newer, remove its
`NODE_AUTH_TOKEN`, and delete the `NPM_TOKEN` secret after a trusted publication
succeeds.
