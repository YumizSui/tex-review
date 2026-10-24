import { describe, it, expect } from 'vitest';
import { selectActiveTheme } from '../../src/core/activeTheme';

describe('live theme identity', () => {
  const themes = [
    { id: 'Abyss', label: 'Abyss', uiTheme: 'vs-dark', file: '/dark.json' },
    { id: 'Default Light Modern', label: 'Light Modern', uiTheme: 'vs', file: '/light.json' },
  ];
  it('uses the currently displayed light theme instead of the saved dark theme', () => {
    expect(selectActiveTheme(themes, { id: 'Default Light Modern', kind: 'vscode-light' })?.file).toBe('/light.json');
  });
  it('does not silently substitute a dark theme in a light workbench', () => {
    expect(selectActiveTheme(themes, { id: 'Abyss', kind: 'vscode-light' })).toBeUndefined();
  });
  it('supports a theme label supplied by the webview', () => {
    expect(selectActiveTheme(themes, { name: 'Light Modern', kind: 'vscode-light' })?.file).toBe('/light.json');
  });
});
