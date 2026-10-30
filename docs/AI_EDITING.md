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
```

`transact` and `comment` also accept JSON on stdin. This is same-user local IPC, using a Unix
socket (a named pipe on Windows). It opens no TCP port and sends no manuscript to
a remote service. Keep `.review/` out of Git.

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
equals `to`, with an empty `quote`). Moving comments between source files is not
yet supported.

Set `"dryRun": true` to validate the complete transaction without changing source
or review history. Use a new ID for a different transaction. If a request times
out or disconnects, retry **the same ID and exact request**, rather than creating
a second transaction. The last 100 results are retained for idempotent retries.

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
move existing anchors, rewrite original quotes, or modify existing comments. Creation captures a new anchor and its original quote. It can
run while the editor has unsaved source changes. UI/API writers are serialized
by the extension; independent direct log writers do not participate in that
serialization. Use this API instead of writing the log directly.

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
submitting another transaction. Direct filesystem readers may observe the brief
interval between source and log writes; API readers are serialized with commits.
A process interruption is recoverable; arbitrary external changes cannot be made
transactional by this API.
