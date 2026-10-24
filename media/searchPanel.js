import { SearchQuery, getSearchQuery, setSearchQuery, findNext, findPrevious, closeSearchPanel, replaceNext, replaceAll } from '@codemirror/search';
import { t } from './locales.js';

// CodeMirror owns matching and replacement; this panel only presents those commands.
export function createSearchPanel(view) {
  const dom = document.createElement('div'); dom.className = 'review-find';
  dom.setAttribute('role', 'search');
  const row = document.createElement('div'); row.className = 'find-row';
  const replacement = document.createElement('div'); replacement.className = 'find-row'; replacement.hidden = true;
  const field = (name, placeholder) => {
    const input = document.createElement('input'); input.name = name; input.placeholder = t(placeholder);
    input.setAttribute('aria-label', t(placeholder)); input.autocomplete = 'off'; input.spellcheck = false;
    return input;
  };
  const search = field('search', 'Find'); search.setAttribute('main-field', 'true');
  const replace = field('replace', 'Replace');
  const control = (text, title, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.title = t(title); b.setAttribute('aria-label', t(title)); b.addEventListener('click', action); return b;
  };
  const expand = control('›', 'Toggle replace', () => {
    replacement.hidden = !replacement.hidden; expand.textContent = replacement.hidden ? '›' : '⌄';
    expand.setAttribute('aria-expanded', String(!replacement.hidden));
  }); expand.setAttribute('aria-expanded', 'false');
  const options = {};
  function commit() {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: search.value, replace: replace.value, literal: true,
      caseSensitive: options.caseSensitive.getAttribute('aria-pressed') === 'true',
      wholeWord: options.wholeWord.getAttribute('aria-pressed') === 'true',
      regexp: options.regexp.getAttribute('aria-pressed') === 'true' })) });
  }
  row.append(expand, search);
  for (const [name, text, title] of [['caseSensitive', 'Aa', 'Match case'], ['wholeWord', 'ab', 'Match whole word'], ['regexp', '.*', 'Use regular expression']]) {
    const b = options[name] = control(text, title, () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); commit(); });
    b.setAttribute('aria-pressed', 'false'); row.append(b);
  }
  const count = document.createElement('span'); count.className = 'find-count'; count.setAttribute('aria-live', 'polite');
  row.append(count, control('↑', 'Previous match', () => findPrevious(view)), control('↓', 'Next match', () => findNext(view)),
    control('×', 'Close search', () => { closeSearchPanel(view); view.focus(); }));
  replacement.append(replace, control('↵', 'Replace', () => replaceNext(view)), control('⇄', 'Replace all', () => replaceAll(view)));
  dom.append(row, replacement);
  search.addEventListener('input', commit); replace.addEventListener('input', commit);
  dom.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeSearchPanel(view); view.focus(); }
    else if (event.key === 'Enter') { event.preventDefault();
      if (event.target === replace) replaceNext(view); else (event.shiftKey ? findPrevious : findNext)(view);
    }
  });
  function refresh() {
    const query = getSearchQuery(view.state);
    if (search.value !== query.search) search.value = query.search;
    if (replace.value !== query.replace) replace.value = query.replace;
    for (const name of Object.keys(options)) options[name].setAttribute('aria-pressed', String(query[name]));
    search.setAttribute('aria-invalid', String(!!query.search && !query.valid));
    if (!query.search) { count.textContent = ''; return; }
    if (!query.valid) { count.textContent = t('Invalid expression'); return; }
    let total = 0, current = 0; const cursor = query.getCursor(view.state.doc);
    const selection = view.state.selection.main;
    while (!cursor.next().done) {
      total++; if (cursor.value.from === selection.from && cursor.value.to === selection.to) current = total;
      if (total >= 10000) break;
    }
    count.textContent = total ? `${current || '–'}/${total}${total >= 10000 ? '+' : ''}` : t('No results');
  }
  refresh();
  return { dom, top: true, mount() { search.select(); }, update(update) {
    if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery)))) refresh();
  } };
}
