export interface CommentLink { workspace: string; review: string; thread: string }
export function commentLink(scheme: string, extension: string, target: CommentLink): string {
  // URI handlers may decode and re-encode a query. An unreserved payload also
  // preserves '&', '#', and Unicode in workspace paths across that round trip.
  return `${scheme}://${extension}/comment?${Buffer.from(JSON.stringify(target), 'utf8').toString('base64url')}`;
}
export function parseCommentLink(value: string | { path: string; query: string }): CommentLink {
  const url = typeof value === 'string' ? new URL(value) : undefined;
  const route = url ? url.pathname : (value as {path:string}).path;
  const query = url ? url.search.slice(1) : (value as {query:string}).query;
  if (route !== '/comment' || !/^[A-Za-z0-9_-]+$/.test(query) || query.length > 20000) throw new Error('Invalid comment link.');
  let target: unknown;
  try { target = JSON.parse(Buffer.from(query, 'base64url').toString('utf8')); } catch { throw new Error('Invalid comment link.'); }
  if (!target || typeof target !== 'object') throw new Error('Invalid comment link.');
  const {workspace,review,thread} = target as CommentLink;
  if (typeof workspace !== 'string' || !workspace || workspace.length > 10000 || typeof review !== 'string' || !review || review.length > 120 || typeof thread !== 'string' || !thread || thread.length > 200) throw new Error('Invalid comment link.');
  return {workspace,review,thread};
}
