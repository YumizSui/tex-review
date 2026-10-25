# Editing source and comment locations together

TeX Review provides a local API for AI coding assistants. A transaction changes
one TeX source and assigns its affected comments to explicit destinations in the
resulting text. Original comments, replies, and quoted snapshots are preserved.
The API never resolves or deletes a thread.

The extension must be running in a trusted workspace. Run the client from that
workspace's root. `.review/api.json` contains the installed client's `cli` path;
use that path with Node.js 22.12 or later:

```sh
node /path/from/api.json/tex-review.mjs read chapters/introduction.tex
node /path/from/api.json/tex-review.mjs transact request.json
```

`transact` also accepts JSON on stdin. This is same-user local IPC, using a Unix
socket (a named pipe on Windows). It opens no TCP port and sends no manuscript to
a remote service. Keep `.review/` out of Git.

## Read

`read` returns the current editor text, its `revision`, a `reviewRevision`, and
comments from every review on that source. It includes current anchor offsets
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
