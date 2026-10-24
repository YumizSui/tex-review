import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { Registry, parseRawGrammar, IRawTheme, StateStack, INITIAL } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

let oniguruma: Promise<void> | undefined;
export interface SyntaxTokens { colors: string[]; ranges: [number, number, number, number][] }
export async function createNativeSyntax(wasm: Uint8Array, grammars: Map<string, string>, scope: string, theme: IRawTheme) {
  oniguruma ??= loadWASM(wasm);
  await oniguruma;
  const registry = new Registry({ theme,
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text) }),
    loadGrammar: async name => { const file = grammars.get(name); return file ? parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null; },
  });
  const grammar = await registry.loadGrammar(scope);
  if (!grammar) throw new Error('LaTeX grammar is unavailable');
  return {
    tokenize(text: string): SyntaxTokens {
      let stack: StateStack = INITIAL, offset = 0;
      const ranges: SyntaxTokens['ranges'] = [];
      for (const line of text.split('\n')) {
        const result = grammar.tokenizeLine2(line, stack, 20);
        for (let i = 0; i < result.tokens.length; i += 2) {
          const start = result.tokens[i], end = Math.min(line.length, i + 2 < result.tokens.length ? result.tokens[i + 2] : line.length);
          const metadata = result.tokens[i + 1];
          if (end > start) ranges.push([offset + start, offset + end, (metadata >>> 15) & 511, (metadata >>> 11) & 15]);
        }
        stack = result.ruleStack; offset += line.length + 1;
      }
      return { colors: registry.getColorMap(), ranges };
    },
  };
}
export function readTokenTheme(file: string, seen = new Set<string>()): { colors: Record<string, string>; settings: IRawTheme['settings'] } {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) throw new Error('Cyclic theme includes');
  seen.add(absolute);
  const raw = fs.readFileSync(absolute, 'utf8');
  const data: any = raw.trimStart().startsWith('<') ? parseRawGrammar(raw, absolute) : parse(raw);
  const base = data.include ? readTokenTheme(path.resolve(path.dirname(absolute), data.include), seen) : { colors: {}, settings: [] };
  const tokens = typeof data.tokenColors === 'string' ? readTokenTheme(path.resolve(path.dirname(absolute), data.tokenColors), seen).settings : data.tokenColors ?? data.settings ?? [];
  return { colors: { ...base.colors, ...data.colors }, settings: [...base.settings, ...tokens] };
}
