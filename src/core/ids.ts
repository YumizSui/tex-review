export function newThreadId(rand: () => number = Math.random): string {
  const n = Math.floor(rand() * 2 ** 32);
  return 't_' + n.toString(36).padStart(7, '0');
}
