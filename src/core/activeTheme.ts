export interface ActiveThemeIdentity { id?: string; name?: string; kind?: string; foreground?: string; background?: string }
export interface ThemeCandidate { id?: string; label?: string; uiTheme?: string; file: string }
/** The webview identifies the live theme, including OS-driven theme switching. */
export function selectActiveTheme(themes: ThemeCandidate[], active: ActiveThemeIdentity): ThemeCandidate | undefined {
  const identities = [active.id, active.name].filter(Boolean);
  const sameKind = (theme: ThemeCandidate) => !active.kind || theme.uiTheme === ({ 'vscode-light': 'vs', 'vscode-dark': 'vs-dark', 'vscode-high-contrast': 'hc-black', 'vscode-high-contrast-light': 'hc-light' } as Record<string, string>)[active.kind];
  return themes.find(theme => sameKind(theme) && identities.some(id => id === theme.id || id === theme.label));
}
