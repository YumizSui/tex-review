export function parseForward(output: string): { page: number; x: number; y: number } | null {
  const page = /^Page:(\d+)$/m.exec(output), x = /^x:([\d.-]+)$/m.exec(output), y = /^y:([\d.-]+)$/m.exec(output);
  if (!page || !x || !y) return null;
  return { page: Number(page[1]), x: Number(x[1]), y: Number(y[1]) };
}
export function parseInverse(output: string): { file: string; line: number; column: number } | null {
  const file = /^Input:(.+)$/m.exec(output), line = /^Line:(\d+)$/m.exec(output), col = /^Column:(-?\d+)$/m.exec(output);
  return file && line ? { file: file[1], line: Number(line[1]), column: Math.max(1, Number(col?.[1] ?? 1)) } : null;
}
