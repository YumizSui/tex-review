import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActiveThemeIdentity, ThemeCandidate, selectActiveTheme } from '../core/activeTheme';
import { IRawTheme } from 'vscode-textmate';
import { createNativeSyntax, readTokenTheme } from '../core/nativeSyntax';

export async function workbenchSyntax(extensionPath: string, active: ActiveThemeIdentity) {
  const grammars = new Map<string, string>();
  const themes: ThemeCandidate[] = [];
  let latexScope = 'text.tex.latex';
  for (const extension of vscode.extensions.all) {
    for (const grammar of extension.packageJSON.contributes?.grammars ?? []) {
      grammars.set(grammar.scopeName, path.resolve(extension.extensionPath, grammar.path));
      if (grammar.language === 'latex') latexScope = grammar.scopeName;
    }
    for (const theme of extension.packageJSON.contributes?.themes ?? []) {
      themes.push({ ...theme, file: path.resolve(extension.extensionPath, theme.path) });
    }
  }
  const selected = selectActiveTheme(themes, active);
  if (!selected) throw new Error(`Active workbench theme was not found: ${active.id ?? active.name}`);
  const selectedTheme = selected.id ?? active.name ?? selected.label;
  const theme = readTokenTheme(selected.file);
  const workbench = vscode.workspace.getConfiguration('workbench').get<Record<string, any>>('colorCustomizations', {});
  const custom = vscode.workspace.getConfiguration('editor').get<Record<string, any>>('tokenColorCustomizations', {});
  const scoped = custom[`[${selectedTheme}]`] ?? {};
  const settings: IRawTheme['settings'] = [...theme.settings, { settings: {
    foreground: active.foreground || workbench[`[${selectedTheme}]`]?.['editor.foreground'] || workbench['editor.foreground'] || theme.colors['editor.foreground'],
    background: active.background || workbench[`[${selectedTheme}]`]?.['editor.background'] || workbench['editor.background'] || theme.colors['editor.background'],
  } }];
  const scopes: Record<string, string> = { comments: 'comment', strings: 'string', keywords: 'keyword', numbers: 'constant.numeric', types: 'entity.name.type', functions: 'entity.name.function', variables: 'variable' };
  for (const customization of [custom, scoped]) {
    for (const [key, scope] of Object.entries(scopes)) if (customization[key]) settings.push({ scope, settings: typeof customization[key] === 'string' ? { foreground: customization[key] } : customization[key] });
    settings.push(...(customization.textMateRules ?? []));
  }
  console.info('[TeX Review] Active syntax theme:', selectedTheme, 'grammar:', grammars.get(latexScope));
  return createNativeSyntax(fs.readFileSync(path.join(extensionPath, 'media/onig.wasm')), grammars, latexScope, { settings });
}
