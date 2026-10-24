import { ChangeSet, Text } from '@codemirror/state';
import { PositionAnchor, rebaseAnchor } from './commentAnchors';

export function followDraftTarget(before: Text, after: Text, target: PositionAnchor & { snapshot: string }, changes?: ChangeSet): PositionAnchor {
  const mapped = rebaseAnchor(target, before, after, changes);
  const quote = target.snapshot;
  if (mapped.status === 'attached' && after.sliceString(mapped.from, mapped.to) === quote) return mapped;
  const unique = (text: string) => { const at = quote ? text.indexOf(quote) : -1; return at >= 0 && text.indexOf(quote, at + 1) < 0 ? at : -1; };
  const oldAt = unique(before.toString()), newAt = unique(after.toString());
  if (oldAt === target.from && newAt >= 0) return { from: newAt, to: newAt + quote.length, status: 'attached' };
  return { ...mapped, status: mapped.status === 'deleted' ? 'deleted' : 'uncertain' };
}
