export interface DocumentMessage { type: string; text: string; version: number; generation?: number }
export function documentUpdate(message: DocumentMessage, current: { version: number; confirmed: string; local: string; inflight: string | null; generation?: number }): 'ignore' | 'ack' | 'refresh' | 'conflict' | 'replace' {
  if ((message.generation ?? 0) < (current.generation ?? 0)) return 'ignore';
  const sameDocument = (message.generation ?? 0) === (current.generation ?? 0);
  if (sameDocument && message.version < current.version) return 'ignore';
  if (sameDocument && message.type === 'document' && message.version === current.version && message.text === current.confirmed) return 'ignore';
  if (current.inflight !== null && message.text === current.inflight) return 'ack';
  if (message.text === current.confirmed) return 'refresh';
  return current.local !== current.confirmed && current.local !== message.text ? 'conflict' : 'replace';
}
