import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { texLanguage, texHighlight } from '../../media/texLanguage.js';

describe('TeX syntax coloring', () => {
  it('distinguishes commands, comments, and arguments from plain text', () => {
    const source = '\\section{Introduction}\n% 日本語のコメント\n\\begin{document}\nPlain text';
    const state = EditorState.create({ doc: source, extensions: texLanguage });
    const tokens: { text: string; classes: string }[] = [];
    highlightTree(syntaxTree(state), texHighlight, (from, to, classes) => tokens.push({ text: source.slice(from, to), classes }));
    expect(tokens).toContainEqual({ text: '\\section', classes: 'tex-command' });
    expect(tokens).toContainEqual({ text: '% 日本語のコメント', classes: 'tex-comment' });
    expect(tokens).toContainEqual({ text: 'document', classes: 'tex-argument' });
    expect(tokens.some(token => token.text.includes('Plain text'))).toBe(false);
  });
});
