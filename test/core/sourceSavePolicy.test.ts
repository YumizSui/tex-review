import { describe, expect, it } from 'vitest';
import { assertSourceSaveStable } from '../../src/core/sourceSavePolicy';

describe('exact transaction text under built-in save settings', () => {
    it.each([
        ['trailing space', 'header \ntarget\n', { trimTrailingWhitespace: true }, 'files.trimTrailingWhitespace'],
        ['trailing tab', 'target\t', { trimTrailingWhitespace: true }, 'files.trimTrailingWhitespace'],
        ['missing final newline', 'target', { insertFinalNewline: true }, 'files.insertFinalNewline'],
        ['extra final newline', 'target\n\n', { trimFinalNewlines: true }, 'files.trimFinalNewlines'],
        ['empty lines only', '\n', { trimFinalNewlines: true }, 'files.trimFinalNewlines'],
    ] as const)('rejects %s with an actionable error', (_name, text, policy, setting) => {
        expect(() => assertSourceSaveStable(text, policy)).toThrow(setting);
        try { assertSourceSaveStable(text, policy); }
        catch (error) { expect(error).toMatchObject({ code: 'SAVE_WOULD_CHANGE_SOURCE' }); }
    });
    it.each(['', 'target\n', '日本語😀\n', 'head\n\ntarget\n'])('accepts already stable text %j', text => {
        expect(() => assertSourceSaveStable(text, { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true })).not.toThrow();
    });
    it('preserves intentional Markdown spaces when trimming is disabled', () => {
        expect(() => assertSourceSaveStable('line  \nnext\n', { insertFinalNewline: true })).not.toThrow();
    });
    it('does not require a newline on an empty or whitespace-only final line', () => {
        for (const text of ['', '\t ', 'target\n  '])
            expect(() => assertSourceSaveStable(text, { insertFinalNewline: true })).not.toThrow();
    });
});
