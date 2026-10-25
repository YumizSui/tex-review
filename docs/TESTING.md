# Testing

## Automated checks

Use Node.js 22.12 or later.

```sh
npm ci --ignore-scripts
npm test
npm run compile
npm run build
```

Tests cover the review event store, comment anchors, source synchronization,
comparison, comment layout, PDF navigation, and VS Code adapters. Native UI
behavior also requires an Extension Development Host.

## Review editor checks

Use a disposable project, such as `examples/review-demo/`. Build the extension
and launch an Extension Development Host with this repository as the extension
under development. Keep other review extensions disabled in that host.

1. Open `main.tex` with **TeX Review: Open review editor**. Confirm that source,
   comments, and PDF are visible and that the source uses the workbench theme.
2. Select a passage and add a comment. Add a reply, edit a comment, and confirm
   keyboard submission and Escape cancellation. Repeat after an external edit
   that leaves the target unchanged.
3. Select several nearby comments, including comments on the same range. Check
   source alignment and continuous scrolling in both directions. Overlapping
   text highlights must not accumulate background colors.
4. Resolve an unselected thread directly, including while holding the mouse
   button briefly. Confirm the action reaches the intended thread. Verify the
   resolved filter, reopening, deletion, and undo.
5. Edit before and within a comment target. Check anchor movement, uncertain
   targets, save/reopen, and Undo/Redo. Leave unsaved edits present while making
   an external change and verify that input is preserved.
6. Compare with a Git checkpoint and a saved TeX file. Confirm that current text
   remains editable, removed text is read-only, and comments and SyncTeX refer
   to current-source positions.
7. Build a PDF, move in both directions with SyncTeX, and follow an internal
   PDF link. Check continuous scrolling and root selection with multiple
   documents. Verify Draft and Full builds.
8. Export a PDF with comment annotations. Check that mapped comments and their
   replies are present, unmapped threads are counted, and the source PDF is
   unchanged.
9. Append an external reply and change source files while the viewer is open.
   Verify visible and hidden-panel refresh, including atomic file replacement.

Test the reported interaction in the running host before declaring a UI defect
fixed. The scripts under `test/runtime/` provide host-level synchronization and
anchor checks in disposable workspaces.

## Package checks

```sh
mkdir -p releases
npm run package -- --out releases/tex-review.vsix
```

Inspect the archive before release. Include runtime bundles, required assets,
public documentation, and license notices. Exclude local agent instructions,
Japanese Markdown companions, review stores, development history, personal
paths, and working files.

The packaging CLI is pinned to `@vscode/vsce` 3.9.2 with Azure Identity 4.13.0.
Its MSAL Node 3.x dependency uses only `uuid.v4()`; a scoped override selects
`uuid` 11.1.1, which preserves that CommonJS API and fixes
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
The Identity pin avoids the MSAL Node 5.x/6.x line affected by
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5).
Recheck `npm audit` and package creation before changing these overrides.
These tools are development dependencies and are excluded from the VSIX.
