import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNativeSyntax, readTokenTheme } from '../../src/core/nativeSyntax';

describe('native workbench syntax', () => {
  it('uses grammar scopes and theme token colors, including multiline state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-native-'));
    try {
      const file = path.join(root, 'grammar.json');
      fs.writeFileSync(file, JSON.stringify({ scopeName: 'text.tex.test', patterns: [
        { name: 'comment.line.tex', match: '%.*$' },
        { name: 'support.function.tex', match: '\\\\[a-z]+' },
        { name: 'string.tex', begin: '\\{', end: '\\}' },
      ] }));
      const syntax = await createNativeSyntax(fs.readFileSync('node_modules/vscode-oniguruma/release/onig.wasm'), new Map([['text.tex.test', file]]), 'text.tex.test', { settings: [
        { settings: { foreground: '#eeeeee', background: '#111111' } },
        { scope: 'support.function', settings: { foreground: '#123456' } },
        { scope: 'comment', settings: { foreground: '#abcdef', fontStyle: 'italic' } },
        { scope: 'string', settings: { foreground: '#aabbcc' } },
      ] });
      const text = '\\section{a\nb}\n% コメント';
      const tokens = syntax.tokenize(text);
      const colorAt = (offset: number) => tokens.colors[tokens.ranges.find(([from, to]) => from <= offset && to > offset)![2]];
      expect(colorAt(0)).toBe('#123456');
      expect(colorAt(text.indexOf('b}'))).toBe('#AABBCC');
      const comment = tokens.ranges.find(([from]) => from === text.indexOf('%'))!;
      expect(tokens.colors[comment[2]]).toBe('#ABCDEF');
      expect(comment[3] & 1).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('loads inherited theme colors and JSON comments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-theme-'));
    try {
      fs.writeFileSync(path.join(root, 'base.json'), '{"colors":{"editor.foreground":"#cccccc"},"tokenColors":[{"scope":"comment","settings":{"foreground":"#008800"}}]}');
      fs.writeFileSync(path.join(root, 'custom.json'), '{// theme override\n"include":"base.json","tokenColors":[{"scope":"comment","settings":{"foreground":"#ff0088"}}]}');
      const theme = readTokenTheme(path.join(root, 'custom.json'));
      expect(theme.colors['editor.foreground']).toBe('#cccccc');
      expect(theme.settings.at(-1)?.settings.foreground).toBe('#ff0088');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
