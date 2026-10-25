---
name: review-comments
description: Read and resolve human code-review comments left by the TeX Review extension. Use when the user asks to address review comments, fix review feedback, or work the review file in .review/. Triggers on "address the review", "fix review comments", "resolve review threads".
---

# Working Code Review Comments

TeX Review stores reviewer comments in `.review/`. Use the installed local API
for source edits, replies, status changes, and tags. Discover its CLI from
`.review/api.json`. Never rewrite the log, `.view.json`, or anchor checkpoints,
and do not bypass API validation with direct log appends.

## Comment intent

Read `tags` before acting. Missing or empty tags mean `action` (Action required).
For `question` alone, answer first; do not assume it requests a source edit.
`question` with `action` requests both an answer and a correction. `todo` marks
deferred work; process it when it is within the user's requested scope. `note`
alone is informational. Tags can be combined and do not change resolved status.
Follow workspace instructions for replies and resolution; completing an edit
does not itself authorize resolving or deleting the thread.

Comment links identify a workspace, review, and stable thread ID, not a source
line. The query is base64url-encoded UTF-8 JSON with `workspace`, `review`, and
`thread`; validate the workspace and read that thread's current anchor before editing. The editor's File/All
search includes visible comment bodies and replies; it is not a full-workspace
TeX search.

## Source changes

When changing a reviewed TeX passage, prefer the extension's
[transaction API](../../docs/AI_EDITING.md). Discover the installed CLI in
`.review/api.json`, read the current buffer and comments, and submit source edits
and explicit destinations for every affected comment as one transaction. Validate
with `dryRun` first. Do not edit TeX and subsequently guess comment line numbers,
or rewrite `.view.json` and anchor checkpoints. A stale revision or missing
comment mapping must be resolved before applying any change. Source transactions preserve
original quotes and never resolve threads.

If the API is unavailable, tell the user that transactional editing is unavailable;
do not silently claim that direct file changes have the same guarantees. Direct
editing is still supported, but comment correspondence must be checked afterwards.

## Read current comments

Run the CLI from the workspace root with Node.js 22.12 or later:

```sh
node /path/from/api.json/tex-review.mjs read chapters/introduction.tex
```

Use the returned `threads`, each thread's `review` and `id`, `tags`, `status`,
`anchor`, and `currentQuote`. `snapshot` is the original quote, not necessarily
the current passage. Offsets are LF-normalized UTF-16. The editor buffer is
authoritative; a dirty source must be saved before a source transaction, but
comment operations do not edit or save it.

If the API is unavailable, `.review/<name>.view.json` can be read for orientation.
Do not silently fall back to direct log writes. If a view may be stale, reopen
the extension and read through the API; folding the log does not produce current
checkpoint positions. Report the unavailable capability when it blocks work.

## Replies, status, and tags

Check `capabilities` in `.review/api.json` for `comment`. Use the CLI's `comment`
operation with a JSON file or stdin; see the [API reference](../../docs/AI_EDITING.md).

```json
{
  "id": "unique-comment-request-001",
  "file": "chapters/introduction.tex",
  "review": "review-name",
  "thread": "t_example",
  "reviewRevision": "reviewRevision returned by read",
  "action": "reply",
  "body": "Revised the definition."
}
```

```sh
node /path/from/api.json/tex-review.mjs comment comment-request.json
```

- `reply` requires `body`; the server assigns `author: "agent"` and timestamp.
- `set_tags` requires `tags`, a list from `action`, `question`, `todo`, `note`.
  It replaces the tag set; `[]` resets it to `action`. Change tags only when
  requested or authorized by project instructions.
- `resolve` and `reopen` have no extra fields. Resolve only when explicitly
  authorized; completing an edit or posting a reply is not authorization.
- Read again after each successful mutation. A stale `reviewRevision` is a
  conflict, not permission to overwrite newer feedback.
- Validate with `dryRun: true`, then omit it to commit. Retry a timeout with the
  same ID and exact request; never mint a new ID just because a response was lost.
- Use JSON serialization for requests. Do not construct JSON by interpolating
  manuscript or comment text into shell commands.

These operations target existing stable thread IDs. They do not create/delete
threads, rewrite existing comments, move anchors, or resolve anything implicitly.
Source editing and a later reply remain separate explicit operations; the source
transaction is the unit that keeps text and destinations together.

## Typical loop

1. Read current open threads and their tags through the API.
2. Locate the intended passage from its current anchor and context. For a stale
   or ambiguous target, do not choose another identical quote by guesswork.
3. Apply authorized source changes using `transact`, including explicit comment
   destinations for affected passages.
4. Read again and post a short `reply` describing the change using `comment`.
5. Leave resolution to the user unless explicitly authorized. Re-read at work
   boundaries to notice new feedback.

Preserve `.review/anchors/` with the logs when moving the review store. Its
current/previous checkpoints can contain uncommitted source text; do not publish
them. Baseline comparison never changes comments' current-source coordinates.
