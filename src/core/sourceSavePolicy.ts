/** Built-in save participants that can change text outside a requested edit. */
export interface SourceSavePolicy {
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
}

export class SourceSaveConflict extends Error {
    readonly code = 'SAVE_WOULD_CHANGE_SOURCE';
    constructor(settings: string[]) {
        super(`Save would change the planned source (${settings.join(', ')}). Include those changes explicitly in the edits and recalculate comment destinations, or disable the listed settings for this source, then read and prepare the request again.`);
    }
}

/** Refuse before editing rather than silently changing explicit comment destinations. */
export function assertSourceSaveStable(text: string, policy: SourceSavePolicy = {}): void {
    const settings: string[] = [];
    if (policy.trimTrailingWhitespace && /[ \t]+$/m.test(text))
        settings.push('files.trimTrailingWhitespace');
    // VS Code leaves an empty or whitespace-only final line unchanged.
    if (policy.insertFinalNewline && /[^ \t\n]/.test(text.slice(text.lastIndexOf('\n') + 1)))
        settings.push('files.insertFinalNewline');
    if (policy.trimFinalNewlines && (text === '\n' || /\n\n$/.test(text)))
        settings.push('files.trimFinalNewlines');
    if (settings.length) throw new SourceSaveConflict(settings);
}
