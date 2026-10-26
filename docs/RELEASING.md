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
2. Push to `main` only if authorized. With Open VSX publication authorized, run
   **Actions → Publish to Open VSX → Run workflow** for the validated commit,
   entering its exact package version.
3. Reuse that run's `tex-review-release` VSIX for the Visual Studio Marketplace
   only when publication there is also authorized.
4. Verify each authorized public listing and its version. Cursor search may
   update later; do not claim discovery is confirmed before checking it.

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

Restrict the GitHub `openvsx` environment to the `main` branch. Only the publish
job requests an OIDC token. No Open VSX personal access token is needed.
The publishing CLI is installed from the lockfile with the repository’s dependency
overrides; publishing does not download an unpinned CLI.

See the [Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).
