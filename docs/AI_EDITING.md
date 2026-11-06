# Local source and comment API

The same API supports `.txt` and Markdown (`.md`, `.markdown`) files, and other text files already opened in the review editor. Non-TeX files do not use PDF builds or SyncTeX.

TeX Review provides a local API for AI coding assistants. A transaction changes
one text source and assigns its affected comments to explicit destinations in the
resulting text. Original comments, replies, and quoted snapshots are preserved.
Source transactions never resolve or delete a thread. Explicit comment operations
can create an AI-authored thread, reply, change type, resolve, or reopen a thread.

The extension must be running in a trusted workspace. Run the client from that
workspace's root. `.review/api.json` contains the installed client's `cli` path;
use that path with Node.js 22.12 or later:

```sh
node /path/from/api.json/tex-review.mjs read chapters/introduction.tex
node /path/from/api.json/tex-review.mjs transact request.json
node /path/from/api.json/tex-review.mjs comment comment-request.json
node /path/from/api.json/tex-review.mjs status
```

`transact` and `comment` also accept JSON on stdin. This is same-user local IPC, using a Unix
socket (a named pipe on Windows). It opens no TCP port and sends no manuscript to
a remote service. Keep `.review/` out of Git.

## Status and timeouts

Check for `status` in `.review/api.json` capabilities. `status` reports the active
operation, its stage and elapsed time, the queue length, recent stage events, and
whether transaction recovery is required. It bypasses the operation queue and
does not open documents or run recovery. Diagnostics are available while startup
recovery is waiting for the editor. The **TeX Review API** output channel records
the same stage events without source text or comment bodies.

Document acquisition has a 5-second deadline. An acquisition timeout returns
`DOCUMENT_OPEN_TIMEOUT`; a late document result does not resume the failed
operation. Other requests remain serialized to preserve source and review
consistency. Up to 64 requests can wait in the queue.

Requests have a 20-second response deadline, including queue time. `QUEUE_TIMEOUT`
with `outcome: "not_started"` means the queued request was removed without
execution. A disconnected request that has not started is also removed.
`OPERATION_TIMEOUT` with `outcome: "pending"` means the running operation has not
settled. An edit or save already sent to the editor can still finish after this
response. Its lock and recovery journal are retained until the editor reports
the result; further requests receive `OPERATION_IN_PROGRESS` while that operation
is settling. Use `status`, then retry the same ID and exact request to retrieve
its result. A timeout does not establish that a transaction was aborted.

These deadlines and diagnostics require the extension host's event loop to be
responsive. They do not cancel VS Code's document, edit, or save RPCs.

## Read

`read` returns the current editor text, its `revision`, a `reviewRevision`, and
comments from every review on that source, plus `reviews` and `activeReview` for choosing an existing review even when the source has no comments. It includes current anchor offsets
and `currentQuote`; `snapshot` remains the original quote. The editor buffer is
authoritative. A transaction requires a clean buffer; existing unsaved edits
must be saved or discarded first.

## Transaction

```json
{
  "id": "a-unique-transaction-id",
  "file": "chapters/introduction.tex",
  "revision": "revision returned by read",
  "reviewRevision": "reviewRevision returned by read",
  "edits": [
    { "from": 100, "to": 112, "before": "old sentence", "text": "New sentence." }
  ],
  "anchors": [
    { "review": "review-name", "thread": "t_example", "from": 100, "to": 113, "quote": "New sentence." }
  ]
}
```

Offsets are zero-based UTF-16 positions in LF-normalized text. Edit offsets refer
to the original text; anchor offsets refer to the complete resulting text. Exact
`before` and `quote` checks are mandatory. Duplicate passages are distinguished
by their offsets; the API does not choose an occurrence by searching a quote.

Every comment whose passage is changed must have an explicit destination,
including resolved comments and comments from other reviews. A missing mapping
rejects the whole operation and returns `missing` review/thread pairs. Unaffected
comments follow the exact edits automatically. After deleting a passage, assign
its comment to a remaining passage or an explicit zero-length boundary (`from`
equals `to`, with an empty `quote`). Use the explicit `move` comment operation below to relocate a thread between files. Source transactions still edit one file at a time.

Set `"dryRun": true` to validate the complete transaction without changing source
or review history. Use a new ID for a different transaction. If a request times
out or disconnects, retry **the same ID and exact request**, rather than creating
a second transaction. The last 100 results are retained for idempotent retries.

### Save-time whitespace changes

Both dry runs and commits check the resulting text against the source's effective
`files.trimTrailingWhitespace`, `files.insertFinalNewline`, and
`files.trimFinalNewlines` settings. If saving would change that text, the API
returns `SAVE_WOULD_CHANGE_SOURCE` before editing or creating a recovery journal.
The error names the conflicting settings. Include the whitespace changes as
explicit edits and recalculate comment destinations, or disable the named
settings for that source; then read again and prepare a new request. The
extension does not change editor settings or silently move explicit destinations.

This preflight does not run formatters or other extensions' save hooks. If an
unexpected save hook or concurrent edit changes the result, the transaction
retains its recovery journal and does not publish the planned comment anchors.
Success requires both the clean native buffer and the saved file to match the
planned text.

## Comment operations

Check that `.review/api.json` lists `comment` in `capabilities`; if it does not,
update the extension and reload its window. Read the source immediately before
an operation and use its `reviewRevision` and the thread's `review` and `id`.

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

Each request performs one explicit action:

| `action` | Additional fields | Result |
| --- | --- | --- |
| `create` | `revision`, `from`, `to`, `quote`, `body`; optional `tags` | Create an open thread as `agent`; returns its `thread` ID. |
| `reply` | `body` | Append a reply as `agent`. |
| `move` | `destination` | Move the existing thread to an exact passage in another source. |
| `set_tags` | `tags`, e.g. `["question"]` | Set the thread's comment type. |
| `resolve` | None | Mark the thread resolved. |
| `reopen` | None | Mark the thread open. |

### New comments

Check for `comment.create` in the descriptor's `capabilities`. Choose an existing
review from `read.reviews`; create a review in the editor first if none exists.
Use `create` without a `thread` field:

```json
{
  "id": "unique-create-request-001",
  "file": "chapters/introduction.tex",
  "review": "review-name",
  "reviewRevision": "reviewRevision returned by read",
  "action": "create",
  "revision": "revision returned by read",
  "from": 100,
  "to": 112,
  "quote": "exact target",
  "body": "Could you clarify this statement?",
  "tags": ["question"]
}
```

Offsets are LF-normalized UTF-16 positions in the current buffer. Both revisions
and the exact quote must match; duplicate passages are selected by offsets.
`from` may equal `to` with an empty quote for a point comment. The server assigns
the stable thread ID, `agent` author, timestamp, and attached anchor. Omitted
`tags` defaults to `action`. New comments do not edit or save the source and may
be attached to the current unsaved buffer. They use the same dry-run and durable
retry behavior as other comment operations.

The four comment types are `action`, `question`, `todo`, and `note`. The `tags`
field retains its name for compatibility and accepts at most one type. An empty
array resets the thread to `action`. Historical multi-tag threads remain readable
until explicitly reclassified. Unknown types, multiple new types, unknown fields, deleted
threads, and stale revisions are rejected. Comment type and resolved status are
independent. Replying never resolves a thread. Resolution still requires the
user's or project's authorization.

Use `"dryRun": true` to validate without appending an event; omit it for the
actual operation. Read again after each successful change before preparing the
next request. On timeout, retry the same ID and exact request. The ID and request
digest are stored with the event, so retries remain idempotent after a restart.
IDs are scoped to the review. A different request must use a new ID.

A comment operation appends one event and does not edit or save the source,
move existing anchors unless `move` is requested, rewrite original quotes, or modify existing comments. Creation captures a new anchor and its original quote. It can
run while the editor has unsaved source changes. UI/API writers are serialized
by the extension; independent direct log writers do not participate in that
serialization. Use this API instead of writing the log directly.

## Move a thread between files

Check for `comment.move` in `capabilities`. Read both sources immediately before
submitting `comment` with the original `file`, `review`, `thread`, and source
`reviewRevision`, plus `action: "move"` and:

```json
{
  "destination": {
    "file": "chapters/discussion.tex",
    "revision": "destination revision returned by read",
    "reviewRevision": "destination reviewRevision returned by read",
    "from": 100,
    "to": 112,
    "quote": "exact target"
  }
}
```

The ID, replies, original snapshot, type, and resolved status stay unchanged.
Only the current file and anchor change, recorded as an append-only event.
Neither source is edited. Read the destination after completion; retries and
`dryRun` work as for other comment operations. Do not delete and recreate the
thread to simulate a move.

## Rename a reviewed file

Check for `rename` in `capabilities`. Save pending source edits, then `read` the
old file and submit a `rename` request through the CLI:

```json
{
  "id": "unique-rename-request-001",
  "file": "chapters/introduction.tex",
  "toFile": "chapters/background.tex",
  "revision": "source revision returned by read",
  "reviewRevision": "source reviewRevision returned by read"
}
```

```sh
node /path/from/api.json/tex-review.mjs rename rename-request.json
```

The destination must be new, inside the workspace, in an existing folder, and
have no previous review threads. The extension uses the editor's file rename,
then moves all associated threads across every review, including resolved and
hidden threads. Comment IDs, replies, type, status, quotes, and positions are
preserved. The review session follows the new filename. Recorded earlier names
are used for file/checkpoint baselines, preferring the current path if it exists
at that checkpoint. TeX `\input` paths and build configuration are not rewritten
by this API; update those through source transactions as needed.

Use `dryRun` first; it validates without staging an operation. A durable intent
precedes the actual rename; `recover` finishes partially published review events
only if the destination content matches and the old file is absent. A cancelled
rename with unchanged paths is aborted. Conflicts retain the intent and refuse
to overwrite unrelated edits. Retry the same ID and exact request after a lost
response. Compact retry receipts retain the last 100 successful renames.

Explorer/editor file and folder renames use the same tracking and preserve
unsaved native buffers without saving them. The API rename requires a clean source. For external filesystem/Git renames, the extension follows only
an observed or opened destination whose complete normalized text matches one
unique missing tracked source. It does not scan all text files, infer changed
content, or choose among identical candidates. Non-TeX destinations must be
opened to be observed. Renames performed while the extension was stopped cannot
always be recognized; reopen the destination and verify the comments. Use
`recover` if an editor rename was cancelled after an intent was staged.

## Commit and recovery

All revisions, edits, and destinations are checked before modification. The
extension applies sparse native document edits, saves the source, and appends
versioned comment destinations. Derived views and the review UI are published
after the transaction completes. Normal source editing remains available.

The source and append-only review logs are separate files, so this is a journaled
transaction rather than an operating-system atomic rename of every file. One
pending intent under `.review/transactions/` records the complete result and its
destinations. After an interruption, recovery finishes the recorded operation
without guessing, or aborts it if nothing was changed. Partial log publication
is idempotent. Successful commits remove the full-text journal; only bounded
compact receipts remain.

```sh
node /path/from/api.json/tex-review.mjs recover
```

If unrelated editing occurred after an interruption, recovery retains the journal
and refuses to overwrite that editing. Resolve the reported conflict before
submitting another transaction. Changing the file on disk alone does not reload
an already cached editor buffer. Recovery verifies both versions, and will not
save over unrelated disk edits or discard unsaved editor input. Direct filesystem readers may observe the brief
interval between source and log writes; API readers are serialized with commits.
A process interruption is recoverable; arbitrary external changes cannot be made
transactional by this API.
