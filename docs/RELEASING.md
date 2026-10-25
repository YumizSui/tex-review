# Releasing

Use the same `yumizsui.tex-review` ID and version on both registries.

1. Update the version in `package.json` and `package-lock.json`, then push to
   `main` after validation.
2. Run **Actions → Publish to Open VSX → Run workflow** on `main`, entering
   the exact package version. The workflow tests and packages the extension
   before publishing it to Open VSX.
3. Download the `tex-review-release` artifact from that run and upload its
   VSIX through the Visual Studio Marketplace publisher page.
4. Check both public listings and confirm the version in Cursor's extension
   search after Open VSX and Cursor have finished processing it.

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
