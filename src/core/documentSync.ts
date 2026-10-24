export interface DocumentMessage { type: string; text: string; version: number }
export function documentUpdate(message: DocumentMessage, current: { version: number; confirmed: string; local: string; inflight: string | null }): 'ignore' | 'ack' | 'conflict' | 'replace' {
  if (message.version < current.version) return 'ignore';
  if (message.type === 'document' && message.version === current.version && message.text === current.confirmed) return 'ignore';
  if (current.inflight !== null && message.type === 'ack' && message.text === current.inflight) return 'ack';
  return current.local !== current.confirmed && current.local !== message.text ? 'conflict' : 'replace';
}
