---
name: review-comments
description: Read and resolve human code-review comments left by the TeX Review extension. Use when the user asks to address review comments, fix review feedback, or work the review file in .review/. Triggers on "address the review", "fix review comments", "resolve review threads".
---

# Working Code Review Comments

TeX Review stores a reviewer's comments in `.review/`. Read
the human-friendly **view**; make changes by **appending events** to the log.
Never edit the `.view.json` (the extension owns it) and never rewrite the log —
only append. This keeps you race-free with the live extension.

## Prerequisite

`jq` must be installed (`jq --version`). If missing, tell the user.

## Files

- `.review/state.json` — `{ "active": "<name>" }`, names the active review.
- `.review/<name>.view.json` — current state (read this).
- `.review/<name>.log.jsonl` — append events here to act.

## Read open threads

```bash
f=$(jq -r .active .review/state.json)
jq '.threads[] | select(.status=="open")
    | {id, file, range, anchor, sourceDirty, snapshot, last: (.comments[-1].body)}' ".review/$f.view.json"
```

Each thread gives you `file`, a 1-based `range`, the commented `snapshot`, and
the latest comment. `range` is the current position, while `snapshot` remains
its original quote. `anchor.revision` identifies a normalized-LF source snapshot
in the current/previous checkpoint under `.review/anchors/` (each JSON envelope
contains `data.file`, `data.text`, `data.revision`, `data.entries`, and a checksum). If `sourceDirty` is true, the range refers to
an unsaved editor buffer: do not apply that range to the on-disk file. Read/save
the buffer first. If `anchor.status` is `deleted` or `uncertain`, ask the reviewer
to confirm/reassign the target; never pick another identical quote automatically.

## Check a comment is still anchored

For versioned comments, use `anchor` and the current range. The original quote
may have been intentionally edited while the comment stayed attached. Quote
search is only a fallback for old logs without versioned anchors:

```bash
grep -nF "$(jq -r '.threads[] | select(.id=="t_a1") | .snapshot' ".review/$f.view.json")" path/to/file
```

No match → the code changed; locate the relevant code manually before editing.

## Reply to a thread

```bash
f=$(jq -r .active .review/state.json)
log=".review/$f.log.jsonl"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$(jq -nc --arg t t_a1 --arg b "Fixed, switched to <=." --arg ts "$ts" \
  '{op:"reply", thread:$t, author:"agent", body:$b, ts:$ts}')" >> "$log"
```

## Resolve a thread (when authorized by the user)

```bash
printf '%s\n' "$(jq -nc --arg t t_a1 --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{op:"resolve", thread:$t, ts:$ts}')" >> "$log"
```

## Reopen a thread

```bash
printf '%s\n' "$(jq -nc --arg t t_a1 --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{op:"reopen", thread:$t, ts:$ts}')" >> "$log"
```

## If the view looks stale

The extension keeps `<name>.view.json` current. If it ever looks behind the log
(e.g. the extension is not running), reconstruct the current state by folding the
log yourself — the log is the source of truth:

```bash
jq -s '
  reduce .[] as $e ({};
    if $e.op == "add_thread" then .[$e.id] = {id:$e.id, file:$e.file, range:$e.range, snapshot:$e.snapshot, anchor:$e.anchor, status:"open", comments:[{id:($e.id+".c1"), author:$e.author, body:$e.body}]}
    elif $e.op == "set_anchors" then reduce $e.anchors[] as $a (.;
      if .[$a.thread] != null then .[$a.thread].range = $a.range |
      .[$a.thread].anchor = {revision:$e.revision, from:$a.from, to:$a.to, status:$a.status} else . end)
    elif $e.op == "reply"   then .[$e.thread].comments += [{id:($e.thread+".c"+((.[$e.thread].comments|length+1)|tostring)), author:$e.author, body:$e.body}]
    elif $e.op == "resolve" then .[$e.thread].status = "resolved"
    elif $e.op == "reopen"  then .[$e.thread].status = "open"
    elif $e.op == "delete_thread" then .[$e.thread]._deleted = true
    elif $e.op == "restore_thread" then .[$e.thread]._deleted = false
    elif $e.op == "delete_comment" or $e.op == "restore_comment" then
      ($e.comment|sub("\\.c[0-9]+$";"")) as $t
      | .[$t].comments |= map(if .id == $e.comment then ._deleted = ($e.op == "delete_comment") else . end)
    elif $e.op == "edit_comment" then ($e.comment|sub("\\.c[0-9]+$";"")) as $t
      | .[$t].comments |= map(if .id == $e.comment then .body = $e.body else . end)
    else . end)
  | to_entries | map(.value | select(._deleted != true) | del(._deleted) | .comments |= map(select(._deleted != true) | del(._deleted)))' ".review/$f.log.jsonl"
```

The log may also contain `edit_comment` events (the reviewer rewording their
own comment); the fold above applies them. You never emit them yourself.

## Rules

- Read `view.json`, write only by appending to `log.jsonl`.
- `author` is always `"agent"` for your comments.
- You reply/resolve/reopen existing threads — you do not create threads (that is
  the reviewer's job), so you never mint thread ids; read `id` from the view.
- One event per appended line; `jq -nc` builds valid escaped JSON.

## Typical loop

1. Read open threads from the view.
2. For each: open the file, make the fix.
3. Append a `reply` describing what you did.
4. Resolve only when the user or project instructions explicitly authorize it; otherwise leave the thread open for review.
5. Tell the user which threads you addressed.


### Local fork extensions

`delete_thread` / `restore_thread` events target `thread`; `delete_comment` /
`restore_comment` events target a full `comment` id. They carry `ts` like other
events. Deleted items are absent from `view.json`, while log history remains.
Comment IDs stay stable across deletions: do not derive the next ID from the
number of visible comments. Review the current view rather than treating every
historical `add_thread` as an active thread. Baseline comparison does not change
anchors: comments always refer to the current source document.

`set_anchors` records explicit reattachment; automatic source saves no longer
append it. If the project instructions authorize an AI to repair a target,
append the event with a verified current normalized-LF revision and UTF-16 range.
Preserve the original quote and comment contents. Otherwise ask the reviewer
before reassigning a target. Never edit `.review/anchors/` or `.view.json` from
an AI workflow. Preserve `.review/anchors/` alongside logs when sharing/moving
the review store; checkpoints may include uncommitted source text. A folded log
has historical positions, not the current checkpoint. Reopen the extension to
map external edits and regenerate the view before using its ranges.
