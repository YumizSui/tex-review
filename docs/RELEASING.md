# Releasing

Use the same `yumizsui.tex-review` ID and version on both registries.

## Version policy

A version identifies a release batch, not an edit, commit, test run, or local
installation. Keep the current development version during iterative fixes,
including revisions to an unpublished release candidate. Bump it once when
assembling the next release candidate after the relevant validation.

Choose the increment from the complete batch since the previous published
release, using the highest-impact change:

| Increment | Release contents |
| --- | --- |
| Patch | Backward-compatible bug fixes only. Several fixes may share one patch release. |
| Minor | New features or intentional changes to user-facing behavior. |
| Major | Incompatible public API, configuration, or review-data changes after 1.0. |

During 0.x development, incompatible changes use a minor increment and require
an explicit compatibility/migration note. Never classify a public API or data
format break as a patch. Update `package.json` and the root package entries in
`package-lock.json` together; do not alter dependency versions as part of a
version bump.

## Local verification builds

- Keep the package version unchanged. Use a filename such as
  `tex-review-<version>-local-<short-commit>.vsix` and retain the source commit
  and VSIX SHA-256 so same-version builds can be distinguished.
- A same-version local replacement is a verification build, not a new public
  release. Never replace or reuse an already published version on a registry.
- Call a build "local" or "release candidate" while actual-use validation is
  pending. Tests, compilation, and a successful install alone do not establish
  that it is stable.
- Do not push, tag, or publish merely because checks passed. Follow the user's
  explicit destination and scope; permission to publish to Open VSX does not
  authorize a Git push or a Marketplace release.

## Publication

The workflow below uses a pushed commit. If pushing is prohibited, do not run
this workflow against an older remote commit; use the validated local VSIX and
an authorized direct publishing route instead. If that route is unavailable,
report the blocker without publishing another version.

1. Complete the relevant tests, compilation, UI interaction checks, and package
   inspection. Select the release batch and version using the rules above.
2. Push the validated commit to `main` only if authorized. When publication to
   both registries is authorized, publish a stable GitHub Release with the
   matching `v<version>` tag at that commit. The **Publish TeX Review Studio**
   workflow tests and packages the tagged source once, then sends the same
   `tex-review-release` VSIX to each registry. Drafts and prereleases do not
   trigger registry publication.
3. If only Open VSX publication is authorized, use **Actions → Publish TeX
   Review Studio → Run workflow** on `main` and enter its exact package version.
   For a Marketplace-only release, upload the validated VSIX in Marketplace.
4. Verify both the workflow results and each authorized listing's version. If
   one registry fails, rerun the failed job to reuse the original VSIX. Cursor
   search may update later; check it separately when verifying discovery.

## One-time Open VSX setup

The first version must be published through the Open VSX website. Claim
ownership of the `yumizsui` namespace before configuring trusted publishing.
Register this trusted publisher for the `tex-review` extension:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Owner | `YumizSui` |
| Repository | `tex-review` |
| Workflow | `openvsx-publish.yml` |
| Environment | `openvsx` |

Restrict the GitHub `openvsx` environment to the `main` branch and `v*.*.*`
tags. Only the publish job requests an OIDC token. No Open VSX personal access
token is needed.

See the [Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).

## One-time Visual Studio Marketplace setup

In **Manage Publishers & Extensions → yumizsui → Trusted Publishing**, register
`YumizSui/tex-review`, workflow `openvsx-publish.yml`, environment `marketplace`.
Restrict the GitHub `marketplace` environment to `v*.*.*` tags. The Marketplace
job uses `vsce publish --oidc` and only that job requests its publishing token.
The Marketplace job uses a separate lockfile so that the packaging and Open
VSX jobs can keep using the project's existing dependencies.

See the [Marketplace trusted publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).
