import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags } from '@lezer/highlight';

// Token colors belong to syntax, rather than the workbench's symbol-icon palette.
export const texHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.meta, tags.tagName, tags.standard(tags.variableName)], class: 'tex-command' },
  { tag: [tags.string, tags.atom], class: 'tex-argument' },
  { tag: tags.comment, class: 'tex-comment' },
  { tag: [tags.number, tags.bool], class: 'tex-number' },
  { tag: tags.heading, class: 'tex-heading' },
  { tag: tags.special(tags.variableName), class: 'tex-math' },
  { tag: tags.bracket, class: 'tex-bracket' },
  { tag: tags.invalid, class: 'tex-invalid' },
]);
export const texParser = StreamLanguage.define(stex);
export const texLanguage = [texParser, syntaxHighlighting(texHighlight)];
