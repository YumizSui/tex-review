import type { CommentTag } from './commentFilters';
import { VersionedAnchor } from './commentAnchors';
// 1-based inclusive line range, matching editor display.
export interface LineRange {
  startLine: number;
  endLine: number;
  // Optional 1-based UTF-16 columns; endColumn is exclusive. Old logs omit them.
  startColumn?: number;
  endColumn?: number;
}

export type ThreadStatus = 'open' | 'resolved';

export interface Comment {
  id: string;
  author: string; // 'reviewer' | 'agent' by convention
  body: string;
  createdAt: string; // ISO-8601 UTC
  editedAt?: string; // ISO-8601 UTC, set when the body was edited
}

export interface Thread {
  id: string;
  file: string; // workspace-relative path
  range: LineRange;
  tags?: CommentTag[];
  snapshot: string; // original quoted text; versioned positions are authoritative
  anchor?: VersionedAnchor;
  sourceDirty?: boolean;
  status: ThreadStatus;
  createdAt: string;
  comments: Comment[];
}

export interface ReviewView {
  version: 1;
  name: string;
  createdAt: string;
  threads: Thread[];
}

export interface AddThreadEvent {
  tags?: CommentTag[];
  op: 'add_thread';
  anchor?: VersionedAnchor;
  id: string;
  file: string;
  range: LineRange;
  snapshot: string;
  author: string;
  body: string;
  ts: string;
}

export interface ReplyEvent {
  op: 'reply';
  thread: string; // thread id
  author: string;
  body: string;
  ts: string;
}

export interface ResolveEvent {
  op: 'resolve';
  thread: string;
  ts: string;
}

export interface ReopenEvent {
  op: 'reopen';
  thread: string;
  ts: string;
}

// Edits a comment's body only. Targets the comment by its full id
// (`<thread>.c<N>`); the thread is derived from that id. Carries no author —
// editing never changes who wrote the comment.
export interface EditCommentEvent {
  op: 'edit_comment';
  comment: string; // full comment id, e.g. 't_1.c2'
  body: string;
  ts: string;
}

// Deletions hide items from derived views; the append-only history is retained.
export interface ThreadVisibilityEvent {
  op: 'delete_thread' | 'restore_thread';
  thread: string;
  ts: string;
}
export interface CommentVisibilityEvent {
  op: 'delete_comment' | 'restore_comment';
  comment: string;
  ts: string;
}

export interface SetAnchorsEvent {
  transaction?: string;
  op: 'set_anchors';
  file: string;
  revision: string;
  anchors: Array<{ thread: string; range: LineRange; from: number; to: number; status: VersionedAnchor['status'] }>;
  ts: string;
}

export interface SetTagsEvent {
  op: 'set_tags'; thread: string; tags: CommentTag[]; ts: string;
}

export interface MoveThreadEvent {
  op: 'move_thread'; thread: string; fromFile: string; file: string;
  range: LineRange; anchor: VersionedAnchor; ts: string;
}
export interface RenameFileEvent {
  op: 'rename_file'; fromFile: string; file: string; revision: string;
  anchors: SetAnchorsEvent['anchors']; renameId: string; ts: string;
}
export type ReviewEvent = (
  | MoveThreadEvent | RenameFileEvent
  | SetTagsEvent
  | SetAnchorsEvent
  | AddThreadEvent
  | ReplyEvent
  | ResolveEvent
  | ReopenEvent
  | EditCommentEvent
  | ThreadVisibilityEvent
  | CommentVisibilityEvent) & { apiRequest?: { id: string; digest: string } };
