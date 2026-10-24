import { commentScrollHandler } from './commentScroll.js';
import { performanceMonitor } from './performance.js';
import { documentUpdate } from '../src/core/documentSync';
import { mapAnchor, sourceChanges, sourceText } from '../src/core/commentAnchors';
import { followDraftTarget } from '../src/core/draftTarget';
import { ContinuousPdf } from './continuousPdf.js';
import { createSearchPanel } from './searchPanel.js';
import { t } from './locales.js';
import { ChangeSet, EditorState, StateEffect, StateField, Compartment, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, gutter, GutterMarker, Decoration } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { texParser } from './texLanguage.js';
import { unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks } from '@codemirror/merge';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import * as pdfjs from 'pdfjs-dist';
import { anchor } from '../src/core/anchor';
import { commentHighlights } from '../src/core/commentHighlights';
import { adjacentComment } from '../src/core/commentNavigation';
import { layoutViewportCards } from '../src/core/cardLayout';

const api = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const previous = api.getState() || {};
let editor, version = 0, confirmed = '', inflight = null, restoring = false, conflictDraft = previous.conflictDraft || '';
let review = { active: null, reviews: [], threads: [], file: '' }, config = {}, draftTarget = null;
let drafts = previous.drafts || {}, cards = new Map(), selectedThread = null, activeRange = null;
let openNativeRequested = false;
let pendingChanges = ChangeSet.empty(0), pendingReview = null, pendingComment = null;
const liveAnchors = new Map();
let syncRequest = 0, requestedBuildMode;
let flushTimer, syncTimer, commentPending = false, composing = false, saveRequested = false, pendingCompose = false, buildRequested = null;
const layoutMeasureKey = {};
const nativeTokens = StateEffect.define();
const nativeDecorations = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(nativeTokens)) value = effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});
const appearanceConfig = new Compartment();
const comparisonConfig = new Compartment();
const markerConfig = new Compartment(), highlights = StateEffect.define();
const key = id => `${review.active || '(new)'}:${id}`;
const send = (type, extra = {}) => api.postMessage({ type, ...extra });
const timings = performanceMonitor(entry => send('performance', entry));
timings.observe();
const saveState = () => api.setState({ drafts, conflictDraft, scrollTop: editor?.scrollDOM.scrollTop,
  showPdf: $('showPdf').checked, showComments: $('showComments').checked });
const make = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const button = (text, fn) => {
  const b = make('button', text);
  // Selecting a card can move its controls between pointerdown and click.
  // Actions keep their position until activation; source links focus explicitly.
  b.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (event.button === 0) event.preventDefault(); // Native focus can scroll the absolute card container too.
  });
  b.addEventListener('focusin', event => event.stopPropagation());
  b.addEventListener('click', fn);
  return b;
};
const decorations = StateField.define({
  create: () => Decoration.none,
  update(value, tr) { value = value.map(tr.changes); for (const e of tr.effects) if (e.is(highlights)) value = e.value; return value; },
  provide: f => EditorView.decorations.from(f),
});
function position(range) {
  const doc = editor.state.doc;
  const start = doc.line(Math.min(Math.max(1, range.startLine), doc.lines));
  const end = doc.line(Math.min(Math.max(1, range.endLine), doc.lines));
  return { from: Math.min(start.to, start.from + (range.startColumn || 1) - 1),
    to: range.endColumn ? Math.min(end.to, end.from + range.endColumn - 1) : end.to };
}
function locate(thread) {
  const tracked = liveAnchors.get(thread.id);
  if (tracked) return { ...thread, ...tracked, outdated: tracked.status !== 'attached' };
  const result = anchor(editor.state.doc.toString().split('\n'), thread.range, thread.snapshot);
  return { ...thread, outdated: result.kind === 'outdated', ...position(result.kind === 'outdated' ? thread.range : result.range) };
}
function threadLabel(thread, loc = locate(thread)) {
  return `${t('Line {0}', editor.state.doc.lineAt(Math.min(editor.state.doc.length, loc.from)).number)}${loc.status === 'deleted' ? t(' · source deleted') : loc.outdated ? t(' · needs review') : ''}`;
}
function snapshotSelection() {
  let { from, to } = editor.state.selection.main;
  if (from === to) { const line = editor.state.doc.lineAt(from); from = line.from; to = line.to; }
  const a = editor.state.doc.lineAt(from), b = editor.state.doc.lineAt(to);
  return { snapshot: editor.state.doc.sliceString(from, to), from, to,
    range: { startLine: a.number, startColumn: from - a.from + 1, endLine: b.number, endColumn: to - b.from + 1 } };
}
function scheduleLayout() {
  editor?.requestMeasure({ key: layoutMeasureKey,
    read: () => timings.measure('comments.measure', measureLayout),
    write: result => timings.measure('comments.layout', () => applyLayout(result)) });
}
function measureLayout() {
  if (!$('showComments').checked) return null;
  const area = $('cards').getBoundingClientRect(), height = $('cards').clientHeight;
  const documentTop = editor.documentTop;
  const threads = new Map(review.threads.map(thread => [thread.id, thread]));
  const measured = [];
  for (const [id, entry] of cards) {
    const thread = threads.get(id);
    const target = id === 'new' ? draftTarget : thread ? locate(thread) : null;
    if (!target) continue;
    const from = Math.max(0, Math.min(editor.state.doc.length, target.from));
    const rect = from >= editor.viewport.from && from <= editor.viewport.to ? editor.coordsAtPos(from) : null;
    const anchorTop = rect ? rect.top - area.top : documentTop + editor.lineBlockAt(from).top - area.top;
    measured.push({ ...entry, id, anchor: anchorTop, height: entry.element.getBoundingClientRect().height, label: thread ? threadLabel(thread, target) : null, order: measured.length });
  }
  measured.sort((a, b) => a.anchor - b.anchor || (a.id === selectedThread ? 0 : 1) - (b.id === selectedThread ? 0 : 1) || a.order - b.order);
  return { measured, height, tops: layoutViewportCards(measured, selectedThread, height) };
}
function applyLayout(result) {
  if (!result) return;
  const { measured, height, tops } = result;
  measured.forEach((card, i) => {
    const top = tops[i];
    if (card.label !== null) { const label = card.element.querySelector('.card-heading > button'); if (label && label.textContent !== card.label) label.textContent = card.label; }
    card.element.style.visibility = top + card.height < 0 || top > height ? 'hidden' : 'visible';
    card.element.style.top = `${top}px`;
    card.element.style.setProperty('--connector-offset', `${card.anchor - top + 9}px`);
    card.element.classList.toggle('displaced', Math.abs(top - card.anchor) > 2);
    const wasActive = card.element.classList.contains('is-active');
    card.element.classList.toggle('is-active', card.id === selectedThread);
    if (wasActive !== (card.id === selectedThread)) scheduleLayout();
    card.element.setAttribute('aria-current', card.id === selectedThread ? 'true' : 'false');
  });
}
function refreshDecorations() {
  if (!editor) return;
  const ranges = review.threads.filter(t => t.file === review.file && t.status === 'open').map(locate)
    .filter(t => !t.outdated && t.to > t.from)
    .map(t => ({ from: t.from, to: t.to, selected: t.id === selectedThread }));
  if (draftTarget?.to > draftTarget?.from) ranges.push({ from: draftTarget.from, to: draftTarget.to, selected: true });
  editor.dispatch({ effects: highlights.of(Decoration.set(commentHighlights(ranges).map(range => Decoration.mark({
    class: range.selected ? 'cm-review-selected' : 'cm-review-mark',
  }).range(range.from, range.to)), true)) });
  scheduleLayout();
}
function flush() {
  if (!editor || inflight !== null || composing || restoring) return;
  const text = editor.state.doc.toString();
  if (text === confirmed) {
    pendingChanges = ChangeSet.empty(text.length);
    if (review.version === version) { for (const thread of review.threads) if (thread.file === review.file && thread.anchor) liveAnchors.set(thread.id, thread.anchor); refreshDecorations(); }
    finishComment(); return;
  }
  inflight = text;
  send('edit', { version, changes: pendingChanges.toJSON() });
  pendingChanges = ChangeSet.empty(text.length);
  $('status').textContent = t('Editing');
}
function busyButton(id, busy, idleLabel, busyLabel) {
  const element = $(id), label = t(busy ? busyLabel : idleLabel);
  element.classList.toggle('is-busy', busy); element.disabled = busy;
  element.setAttribute('aria-busy', String(busy)); element.setAttribute('aria-label', label); element.title = label;
}
function forward(force = false) {
  if (!editor || (!force && config.pdfSync !== 'automatic')) return;
  clearTimeout(syncTimer);
  const sync = () => {
    pendingPdfJump = null;
    busyButton('syncPdf', true, 'Sync PDF', 'Synchronizing PDF…');
    $('syncStatus').textContent = t('Synchronizing PDF…');
    send('forward', { line: editor.state.doc.lineAt(editor.state.selection.main.head).number, request: ++syncRequest });
  };
  if (force) sync(); else syncTimer = setTimeout(sync, 300);
}
class CommentMarker extends GutterMarker {
  toDOM(view) {
    const b = button(undefined, () => { view.focus(); compose(); });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 16 16', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 2.5h12v8H7l-3.5 3v-3H2z M8 4v5 M5.5 6.5h5');
    svg.append(path); b.append(svg);
    b.className = 'gutter-comment'; b.title = t('Add comment'); b.setAttribute('aria-label', t('Add comment')); return b;
  }
}
function markerExtension(side) {
  if (side === 'none') return [];
  return gutter({ side: side === 'right' ? 'after' : 'before', class: 'cm-review-gutter',
    lineMarker: (view, line) => view.state.doc.lineAt(view.state.selection.main.head).from === line.from ? new CommentMarker() : null,
    lineMarkerChange: update => update.selectionSet || update.docChanged,
    domEventHandlers: { mousedown(view, line, event) { event.preventDefault();
      const selected = view.state.selection.main;
      if (selected.empty || line.from < selected.from || line.from > selected.to) view.dispatch({ selection: { anchor: line.from } });
      compose(); return true; } },
  });
}
function initialize(msg) {
  if (editor) return;
  pendingChanges = ChangeSet.empty(msg.text.length);
  version = msg.version; confirmed = msg.text; config = msg.config; review.file = msg.file; pendingCompose = !!msg.compose;
  pdfjs.GlobalWorkerOptions.workerSrc = msg.worker;
  editor = new EditorView({ parent: $('source'), state: EditorState.create({ doc: msg.text,
    selection: msg.selection ? { anchor: msg.selection.from, head: msg.selection.to } : undefined,
    extensions: [lineNumbers(), highlightActiveLine(), history(), highlightSelectionMatches(), search({ top: true, createPanel: createSearchPanel,
        scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'center' }) }),
      texParser, EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-Alt-m', run: () => { compose(); return true; } },
        { key: 'Mod-s', run: () => { requestSave(); return true; } },
        { key: 'Escape', run: () => { if (!cards.has('new')) return false; cancelCompose(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      appearanceConfig.of(drawSelection()), comparisonConfig.of([]), nativeDecorations, decorations, markerConfig.of(markerExtension(config.markerSide)),
      EditorView.updateListener.of(update => {
        if (update.docChanged) for (const [id, tracked] of liveAnchors) liveAnchors.set(id, mapAnchor(tracked, update.changes));
        if (update.docChanged && draftTarget) {
          Object.assign(draftTarget, followDraftTarget(update.startState.doc, update.state.doc, draftTarget, update.changes));
          updateComposer();
        }
        if (update.docChanged && !restoring) {
          pendingChanges = pendingChanges.compose(update.changes);
          clearTimeout(flushTimer); flushTimer = setTimeout(flush, 60); scheduleLayout();
        }
        if (update.selectionSet) { forward(); }
        if (update.docChanged) updateComparisonCount();
        if (update.viewportChanged || update.geometryChanged || update.docChanged) scheduleLayout();
      }),
      EditorView.domEventHandlers({ compositionstart() { composing = true; }, compositionend() { composing = false; setTimeout(flush, 0); } }),
    ] }) });
  editor.scrollDOM.addEventListener('scroll', scheduleLayout, { passive: true });
  applyAppearance();
  if (previous.scrollTop) editor.scrollDOM.scrollTop = previous.scrollTop;
  new ResizeObserver(() => { scheduleLayout(); schedulePdf(); }).observe($('workspace'));
  if (conflictDraft && conflictDraft !== msg.text) send('compareUnsaved', { text: conflictDraft });
  else if (conflictDraft) { conflictDraft = ''; saveState(); }
  editor.focus(); forward();
}

function applyAppearance() {
  $('buildMode').value = config.buildMode || 'preview';
  updateBuildModeTitle();
  const size = config.fontSize || 14;
  const lineHeight = config.lineHeight > 0 ? (config.lineHeight < 8 ? config.lineHeight * size : config.lineHeight) : Math.round(size * 1.5);
  editor.dom.style.setProperty('--source-font-family', config.fontFamily || 'monospace');
  editor.dom.style.setProperty('--source-font-size', `${size}px`);
  editor.dom.style.setProperty('--source-line-height', `${lineHeight}px`);
  editor.dom.style.setProperty('--source-letter-spacing', `${config.letterSpacing || 0}px`);
  editor.dom.style.setProperty('--source-cursor-width', `${config.cursorWidth || 2}px`);
  editor.dom.style.fontVariantLigatures = config.fontLigatures ? 'normal' : 'none';
  editor.dom.dataset.cursorStyle = config.cursorStyle || 'line';
  editor.dom.dataset.cursorBlinking = config.cursorBlinking || 'blink';
  editor.dispatch({ effects: appearanceConfig.reconfigure([drawSelection({ cursorBlinkRate: config.cursorBlinking === 'solid' ? 0 : 1060 }), EditorState.tabSize.of(Number(config.tabSize) || 4)]) });
  editor.requestMeasure();
}
function applyDocument(msg) {
  const local = editor.state.doc.toString();
  const action = documentUpdate(msg, { version, confirmed, local, inflight });
  if (action === 'ignore') return;
  if (action === 'ack') {
    confirmed = msg.text; version = msg.version; inflight = null;
    if (local !== confirmed) flush(); else { $('status').textContent = t('Changes applied'); acceptPendingReview(); finishComment(); finishSave(); }
    return;
  }
  if (action === 'conflict') {
    conflictDraft = local; pendingComment = null; commentPending = false; saveRequested = false; buildRequested = null; openNativeRequested = false; saveState();
    send('compareUnsaved', { text: local });
  }
  restoring = true;
  const changes = sourceChanges(editor.state.doc, sourceText(msg.text));
  editor.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
  restoring = false; confirmed = msg.text; version = msg.version; inflight = null;
  pendingChanges = ChangeSet.empty(msg.text.length); acceptPendingReview();
  refreshDecorations();
}
function focusCard(id) {
  if (selectedThread === id) return;
  selectedThread = id;
  const thread = review.threads.find(thread => thread.id === id);
  if (thread) {
    const loc = locate(thread), rect = editor.coordsAtPos(loc.from), area = $('cards').getBoundingClientRect();
    const effects = !rect || rect.top < area.top + 36 || rect.top > area.bottom - 60
      ? EditorView.scrollIntoView(loc.from, { y: 'center' }) : [];
    editor.dispatch({ selection: { anchor: loc.from, head: loc.to }, effects });
  }
  refreshDecorations();
}
function visibleThreads() {
  return review.threads.filter(thread => thread.file === review.file && ($('resolved').checked || thread.status === 'open'));
}
function navigateComment(direction) {
  if (!editor) return;
  const id = adjacentComment(visibleThreads().map(thread => ({ id: thread.id, from: locate(thread).from })),
    selectedThread, editor.state.selection.main.head, direction);
  if (!id) return;
  focusCard(id);
  const thread = review.threads.find(thread => thread.id === id), loc = locate(thread);
  editor.dispatch({ selection: { anchor: loc.from, head: loc.to }, effects: EditorView.scrollIntoView(loc.from, { y: 'center' }) });
  refreshDecorations(); editor.focus();
}
$('previousComment').addEventListener('click', () => navigateComment(-1));
$('nextComment').addEventListener('click', () => navigateComment(1));
function clearCards() { for (const c of cards.values()) c.element.remove(); cards.clear(); }
function renderComments() {
  if (!editor) return;
  const currentIds = new Set();
  const threads = visibleThreads();
  $('previousComment').disabled = $('nextComment').disabled = threads.length === 0;
  for (const thread of threads) {
    currentIds.add(thread.id);
    const loc = locate(thread);
    const signature = JSON.stringify([thread.status, thread.comments, loc.status, loc.outdated]);
    if (cards.get(thread.id)?.signature === signature) continue;
    const old = cards.get(thread.id), scrollTop = old?.element.scrollTop || 0; const focus = document.activeElement?.dataset?.draft === key(thread.id);
    const selection = focus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    old?.element.remove();
    const card = make('article', undefined, 'card'); card.dataset.thread = thread.id;
    card.addEventListener('pointerdown', () => focusCard(thread.id));
    card.addEventListener('focusin', () => focusCard(thread.id));
    const head = make('div', undefined, 'card-heading');
    head.append(button(threadLabel(thread, loc), () => {
      const current = locate(review.threads.find(item => item.id === thread.id) || thread);
      selectedThread = thread.id; editor.dispatch({ selection: { anchor: current.from, head: current.to }, effects: EditorView.scrollIntoView(current.from, { y: 'center' }) });
      refreshDecorations(); editor.focus(); forward();
    }), button(thread.status === 'resolved' ? t('Reopen') : t('Resolve'), () => send(thread.status === 'resolved' ? 'reopen' : 'resolve', { thread: thread.id, review: review.active })),
      button(t('Delete thread'), () => send('deleteThread', { thread: thread.id, review: review.active })));
    card.append(head);
    if (loc.outdated) {
      const reattach = button(t('Attach to selected text'), () => {
        if (editor.state.selection.main.empty || inflight !== null || editor.state.doc.toString() !== confirmed) {
          $('error').textContent = t('Select the target text after changes are applied.'); return;
        }
        const target = snapshotSelection();
        send('reattach', { review: review.active, thread: thread.id, version, range: target.range, snapshot: target.snapshot });
      });
      reattach.addEventListener('pointerdown', event => event.stopPropagation());
      reattach.addEventListener('focusin', event => event.stopPropagation());
      card.append(reattach);
    }
    for (const c of thread.comments) {
      const isReply = c.id !== `${thread.id}.c1`;
      const section = make('div', undefined, isReply ? 'comment comment-reply' : 'comment comment-opening');
      if (isReply) section.append(make('small', `↳ ${t('Reply')}`, 'reply-label'));
      section.append(make('small', `${c.author === 'reviewer' ? t('You') : c.author === 'agent' ? t('AI') : c.author} · ${new Date(c.createdAt).toLocaleString(document.documentElement.lang)}`), make('p', c.body));
      if (c.author === 'reviewer') section.append(button(t('Edit'), () => {
        const input = make('textarea'); input.rows = 3; input.value = c.body;
        const submit = () => send('editComment', { thread: thread.id, comment: c.id, body: input.value, review: review.active });
        const cancel = () => { cards.delete(thread.id); card.remove(); renderComments(); editor.focus(); };
        input.addEventListener('keydown', event => {
          if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.stopPropagation(); if (!event.repeat) submit();
          }
        });
        const save = button(t('Save'), submit);
        save.title = `${t('Save')} · ${navigator.platform.includes('Mac') ? '⌘Enter' : 'Ctrl+Enter'}`;
        section.replaceChildren(input, save, button(t('Cancel'), cancel)); input.focus(); scheduleLayout();
      }));
      if (c.id !== `${thread.id}.c1`) section.append(button(t('Delete reply'), () => send('deleteComment', { thread: thread.id, comment: c.id, review: review.active })));
      card.append(section);
    }
    const input = make('textarea'); input.rows = 2; input.placeholder = t('Reply…'); input.setAttribute('aria-label', t('Reply')); input.dataset.draft = key(thread.id); input.value = drafts[key(thread.id)] || '';
    input.addEventListener('input', () => { drafts[key(thread.id)] = input.value; saveState(); });
    const submit = () => { if (input.value.trim()) send('reply', { thread: thread.id, body: input.value, review: review.active }); };
    input.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = ''; delete drafts[key(thread.id)]; saveState(); editor.focus(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    card.append(input, button(t('Reply'), submit)); $('cards').append(card); cards.set(thread.id, { element: card, signature });
    card.scrollTop = scrollTop;
    if (focus) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
  }
  for (const [id, c] of cards) if (id !== 'new' && !currentIds.has(id)) { c.element.remove(); cards.delete(id); }
  refreshDecorations(); scheduleLayout();
}
function finishComment() {
  if (!pendingComment || !draftTarget || inflight !== null || editor.state.doc.toString() !== confirmed) return;
  if (draftTarget.status !== 'attached' || editor.state.doc.sliceString(draftTarget.from, draftTarget.to) !== draftTarget.snapshot) {
    pendingComment = null; commentPending = false; $('error').textContent = t('The selected passage changed. Select the text and use Update selection.'); return;
  }
  const a = editor.state.doc.lineAt(draftTarget.from), b = editor.state.doc.lineAt(draftTarget.to);
  send('add', { ...pendingComment, version, range: { startLine: a.number, startColumn: draftTarget.from - a.from + 1,
    endLine: b.number, endColumn: draftTarget.to - b.from + 1 } });
  pendingComment = null;
}
function cancelCompose() {
  cards.get('new')?.element.remove(); cards.delete('new'); delete drafts[key('new')];
  draftTarget = null; pendingComment = null; commentPending = false; if (selectedThread === 'new') selectedThread = null;
  saveState(); refreshDecorations(); editor.focus();
}
function updateComposer() {
  const card = cards.get('new')?.element; if (!card || !draftTarget) return;
  card.querySelector('strong').textContent = t('Comment on line {0}', editor.state.doc.lineAt(draftTarget.from).number);
  card.querySelector('.quote').textContent = draftTarget.snapshot.slice(0, 180);
}
function compose() {
  if (!editor) return;
  $('showComments').checked = true; setColumns();
  if (cards.has('new')) { cards.get('new').element.querySelector('textarea').focus(); return; }
  draftTarget = { ...snapshotSelection(), status: 'attached' };
  const card = make('article', undefined, 'card composer');
  card.append(make('strong', t('Comment on line {0}', draftTarget.range.startLine)));
  const quote = make('p', draftTarget.snapshot.slice(0, 180), 'quote'); card.append(quote);
  const input = make('textarea'); input.rows = 3; input.placeholder = t('Write a comment…'); input.setAttribute('aria-label', t('Write a comment…')); input.value = drafts[key('new')] || '';
  input.addEventListener('input', () => { drafts[key('new')] = input.value; saveState(); });
  const submit = () => {
    if (!input.value.trim() || commentPending) return;
    commentPending = true; pendingComment = { review: review.active, body: input.value, snapshot: draftTarget.snapshot };
    flush(); finishComment();
  };
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCompose(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  card.append(input, button(t('Add'), submit), button(t('Cancel'), cancelCompose), button(t('Update selection'), () => {
    draftTarget = { ...snapshotSelection(), status: 'attached' }; updateComposer(); refreshDecorations(); input.focus();
  }));
  $('cards').append(card); cards.set('new', { element: card }); selectedThread = 'new';
  refreshDecorations(); scheduleLayout(); input.focus();
}

let pdfLoadGeneration = 0;
let pdf = null, pdfUri = '', pdfPage = 1, pdfTimer, pendingPdfJump = null, pdfLoading = false;
function applyPdfPosition(message) {
  if (message.request !== syncRequest) return;
  if (pdfLoading || !pdfView.pages.length) { pendingPdfJump = message; $('syncStatus').textContent = t('Loading PDF…'); return; }
  pendingPdfJump = null; pdfView.goTo(message.page, message.y);
  busyButton('syncPdf', false, 'Sync PDF', 'Synchronizing PDF…');
  $('syncStatus').textContent = t('Line {0} → PDF page {1}', message.line, message.page);
}
const pdfView = new ContinuousPdf($('pdfScroll'), {
  onPage(page) { pdfPage = page; $('pageNumber').value = page; },
  onInverse(location) { send('inverse', location); },
  onError(error) { $('syncStatus').textContent = t('Unable to display PDF: {0}', error.message); },
  onMeasure: timings.duration,
});
function schedulePdf() { clearTimeout(pdfTimer); pdfTimer = setTimeout(() => { if ($('showPdf').checked) pdfView.resize(); }, 100); }
async function loadPdf(msg) {
  const roots = $('roots'); roots.replaceChildren(...(msg.roots || []).map(name => { const option = make('option', name); option.value = name; return option; })); roots.value = msg.selectedRoot || '';
  $('selectPdf').title = msg.name || t('Select PDF');
  if (!msg.uri) { pdfLoading = false; pendingPdfJump = null; busyButton('syncPdf', false, 'Sync PDF', 'Synchronizing PDF…'); pdfLoadGeneration++; pdfView.clear(); pdf?.destroy(); pdf = null; pdfUri = ''; $('pageCount').textContent = ''; $('syncStatus').textContent = t('No PDF for this target. Build it first.'); return; }
  if (msg.uri === pdfUri) return;
  pdfUri = msg.uri; pdfLoading = true;
  const loadGeneration = ++pdfLoadGeneration;
  const started = performance.now();
  try {
    const previousPage = pdfPage; pdfView.clear(); await pdf?.destroy(); pdf = null;
    const loaded = await pdfjs.getDocument({ url: msg.uri, useSystemFonts: true, isEvalSupported: false }).promise;
    if (loadGeneration !== pdfLoadGeneration) { await loaded.destroy(); return; }
    pdf = loaded; await pdfView.load(loaded);
    if (loadGeneration !== pdfLoadGeneration) return;
    $('pageCount').textContent = `/ ${pdf.numPages}`; $('syncStatus').textContent = '';
    pdfLoading = false;
    if (pendingPdfJump) applyPdfPosition(pendingPdfJump);
    else { pdfView.goTo(Math.min(previousPage, pdf.numPages)); forward(); }
  } catch (e) { if (loadGeneration === pdfLoadGeneration) { pdfUri = ''; pdfLoading = false; pendingPdfJump = null; busyButton('syncPdf', false, 'Sync PDF', 'Synchronizing PDF…'); $('syncStatus').textContent = t('Unable to open PDF: {0}', e.message); } }
  finally { timings.duration('pdf.load', performance.now() - started); }
}
let comparisonLabel = '';
function updateComparisonCount() {
  if (!editor || !$('showComparison').checked) return;
  const count = getChunks(editor.state)?.chunks.length || 0;
  $('baselineLabel').textContent = t('Baseline: {0} · {1} changes', comparisonLabel, count);
}
function applyComparison(msg) {
  $('showComparison').checked = !!msg.enabled;
  $('comparisonBar').hidden = !msg.enabled;
  comparisonLabel = msg.label || '';
  editor.dispatch({ effects: comparisonConfig.reconfigure(msg.enabled
    ? unifiedMergeView({ original: msg.text, mergeControls: false, allowInlineDiffs: false, gutter: true, diffConfig: { scanLimit: 2000 } }) : []) });
  if (msg.message) $('error').textContent = msg.message;
  else $('error').textContent = '';
  updateComparisonCount(); editor.requestMeasure(); scheduleLayout();
}
$('showComparison').addEventListener('change', () => send('toggleComparison', { enabled: $('showComparison').checked }));
$('nextChange').addEventListener('click', () => { goToNextChunk(editor); editor.focus(); });
$('previousChange').addEventListener('click', () => { goToPreviousChunk(editor); editor.focus(); });
$('refreshBaseline').addEventListener('click', () => send('refreshBaseline'));
$('undoDelete').addEventListener('click', () => send('undoDelete'));
$('dismissDelete').addEventListener('click', () => { $('deletionNotice').hidden = true; });
const scrollComments = commentScrollHandler(
  { get scrollTop() { return editor?.scrollDOM.scrollTop || 0; }, set scrollTop(value) { if (editor) editor.scrollDOM.scrollTop = value; },
    get clientHeight() { return editor?.scrollDOM.clientHeight || 0; } },
  target => {
    for (let element = target instanceof Element ? target : target?.parentElement; element && element !== $('comments'); element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) return element;
    }
    return null;
  },
  element => element instanceof Element ? parseFloat(getComputedStyle(element).lineHeight) || editor.defaultLineHeight : editor.defaultLineHeight,
);
$('comments').addEventListener('wheel', scrollComments, { passive: false });
$('roots').addEventListener('change', () => send('selectRoot', { root: $('roots').value }));
$('selectPdf').addEventListener('click', () => send('selectPdf'));
$('prevPage').addEventListener('click', () => { if (pdf && pdfPage > 1) { pdfView.goTo(pdfPage - 1); } });
$('nextPage').addEventListener('click', () => { if (pdf && pdfPage < pdf.numPages) { pdfView.goTo(pdfPage + 1); } });
$('pageNumber').addEventListener('change', () => { if (pdf) { pdfView.goTo(Math.max(1, Math.min(pdf.numPages, Number($('pageNumber').value) || 1))); } });
$('syncPdf').addEventListener('click', () => forward(true));
function finishSave() { if (saveRequested && inflight === null && editor.state.doc.toString() === confirmed) { saveRequested = false; send('save'); if (openNativeRequested) { openNativeRequested = false; const selection = editor.state.selection.main; send('openNative', { from: selection.from, to: selection.to }); } if (buildRequested !== null) { send('build', { includeComments: buildRequested, mode: requestedBuildMode }); buildRequested = null; requestedBuildMode = undefined; } } }
function requestSave() { saveRequested = true; flush(); finishSave(); }
$('save').addEventListener('click', requestSave);
function updateBuildModeTitle() { $('buildMode').title = t($('buildMode').value === 'full' ? 'Full build (references and bibliography)' : 'Draft build (one TeX pass)'); }
$('buildMode').addEventListener('change', () => { updateBuildModeTitle(); send('setBuildMode', { mode: $('buildMode').value }); });
$('buildPdf').addEventListener('click', () => { requestedBuildMode ??= $('buildMode').value; busyButton('buildPdf', true, 'Build PDF', 'Building PDF…'); $('status').textContent = t('Building PDF…'); buildRequested = !!config.includePdfComments; requestSave(); });
$('addComment').addEventListener('click', compose);
$('resolved').addEventListener('change', renderComments);
$('reviewMenu').addEventListener('click', () => send('reviewActions', { showComments: $('showComments').checked, showPdf: $('showPdf').checked }));
function setColumns() {
  for (const [toggleId, hide, show] of [
    ['showComments', 'Hide comments', 'Show comments'],
    ['showPdf', 'Hide PDF', 'Show PDF'],
  ]) {
    const text = t($(toggleId).checked ? hide : show);
    $(toggleId).setAttribute('aria-label', text);
    $(toggleId).parentElement.title = text;
  }
  document.body.classList.toggle('no-comments', !$('showComments').checked);
  document.body.classList.toggle('no-pdf', !$('showPdf').checked);
  editor?.requestMeasure(); scheduleLayout(); schedulePdf(); saveState();
}
for (const id of ['showComments', 'showPdf']) $(id).addEventListener('change', setColumns);
if (previous.showComments === false) $('showComments').checked = false;
if (previous.showPdf === false) $('showPdf').checked = false;
function resizer(id, property, direction) {
  const element = $(id); let start, width;
  element.addEventListener('pointerdown', e => {
    start = e.clientX; width = (property === '--comment-width' ? $('comments') : $('pdf')).offsetWidth;
    element.setPointerCapture(e.pointerId);
  });
  element.addEventListener('pointermove', e => {
    if (!element.hasPointerCapture(e.pointerId)) return;
    const value = Math.max(180, Math.min($('workspace').clientWidth * .6, width + direction * (e.clientX - start)));
    $('workspace').style.setProperty(property, `${value}px`); editor?.requestMeasure(); scheduleLayout(); schedulePdf();
  });
}
resizer('resizeComments', '--comment-width', 1); resizer('resizePdf', '--pdf-width', -1);
function acceptPendingReview() {
  if (!pendingReview || !editor || inflight !== null || editor.state.doc.toString() !== confirmed || pendingReview.version !== version) return;
  const m = pendingReview; pendingReview = null;
  liveAnchors.clear();
  for (const thread of m.threads) if (thread.file === m.file && thread.anchor) liveAnchors.set(thread.id, thread.anchor);
    const changed = review.active !== m.active;
    if (changed) { clearCards(); draftTarget = null; selectedThread = null; $('deletionNotice').hidden = true; }
    review = m;
    $('commentCount').textContent = m.threads.filter(thread => thread.file === review.file && thread.status === 'open').length || '';
    if (editor && JSON.stringify(config) !== JSON.stringify(m.config)) {
      config = m.config; clearTimeout(syncTimer); editor.dispatch({ effects: markerConfig.reconfigure(markerExtension(config.markerSide)) });
      applyAppearance();
    }
    renderComments();
    if (pendingCompose) { pendingCompose = false; compose(); }

}
window.addEventListener('message', event => timings.measure(`message.${event.data?.type || 'unknown'}`, () => {
  const m = event.data;
  if (m.type === 'action') {
    if (m.action === 'fullBuild') { requestedBuildMode = 'full'; $('buildPdf').click(); }
    else if (m.action === 'openNative') { openNativeRequested = true; requestSave(); }
    else if (m.action === 'toggleComments' || m.action === 'togglePdf') {
      const toggle = $(m.action === 'toggleComments' ? 'showComments' : 'showPdf'); toggle.checked = !toggle.checked; setColumns();
    }
  }
  else if (m.type === 'init') { initialize(m); setColumns(); }
  else if (['document', 'ack', 'conflict'].includes(m.type)) applyDocument(m);
  else if (m.type === 'activateSelection') {
    const length = editor.state.doc.length;
    editor.dispatch({ selection: { anchor: Math.min(length, m.from), head: Math.min(length, m.to) }, effects: EditorView.scrollIntoView(Math.min(length, m.from), { y: 'center' }) });
    if (m.compose) compose(); else editor.focus();
  }
  else if (m.type === 'syntax') {
    if (m.version !== version || inflight || editor.state.doc.toString() !== confirmed) return;
    const marks = m.ranges.filter(([from, to]) => to > from && to <= editor.state.doc.length).map(([from, to, color, font]) => {
      const foreground = /^#[0-9a-f]{3,8}$/i.test(m.colors[color] || '') ? m.colors[color] : 'var(--vscode-editor-foreground)';
      return Decoration.mark({ attributes: { style: `color:${foreground};font-style:${font & 1 ? 'italic' : 'normal'};font-weight:${font & 2 ? 'bold' : 'normal'};text-decoration:${font & 4 ? 'underline' : 'none'}` } }).range(from, to);
    });
    editor.dispatch({ effects: nativeTokens.of(Decoration.set(marks, true)) });
  } else if (m.type === 'syntaxError') { editor.dispatch({ effects: nativeTokens.of(Decoration.none) }); $('error').textContent = m.error; }
  else if (m.type === 'review') { pendingReview = m; acceptPendingReview(); } else if (m.type === 'comparison') applyComparison(m);
  else if (m.type === 'deleted') { $('deletionNotice').hidden = false; $('error').textContent = ''; }
  else if (m.type === 'deletionUndone') $('deletionNotice').hidden = true;
  else if (m.type === 'commentSaved') {
    drafts[key(m.key)] = ''; commentPending = false;
    if (m.key === 'new') { cards.get('new')?.element.remove(); cards.delete('new'); draftTarget = null; }
    else { cards.get(m.key)?.element.remove(); cards.delete(m.key); }
    saveState(); $('error').textContent = '';
  } else if (m.type === 'error') { pendingComment = null; commentPending = false; busyButton('buildPdf', false, 'Build PDF', 'Building PDF…'); busyButton('syncPdf', false, 'Sync PDF', 'Synchronizing PDF…'); $('error').textContent = m.error; }
  else if (m.type === 'building') { $('buildMode').disabled = m.busy; busyButton('buildPdf', m.busy, 'Build PDF', 'Building PDF…'); if (m.busy) $('status').textContent = t('Building PDF…'); }
  else if (m.type === 'syncing') { if (m.request === syncRequest) busyButton('syncPdf', m.busy || !!pendingPdfJump, 'Sync PDF', 'Synchronizing PDF…'); }
  else if (m.type === 'built') { $('status').textContent = m.unchanged ? t('PDF is up to date') : m.mode === 'preview' ? t('Preview · {0}s', m.seconds) : t('Built · {0}s', m.seconds); $('status').title = m.mode === 'preview' ? t('References may need a full build') : ''; forward(); }
  else if (m.type === 'exported') $('status').textContent = t('Exported {0} threads ({1} skipped)', m.count, m.skipped);
  else if (m.type === 'recoveryOpened') { if (conflictDraft === m.text) { conflictDraft = ''; saveState(); } }
  else if (m.type === 'savedDocument') $('status').textContent = t('Saved');
  else if (m.type === 'pdf') loadPdf(m);
  else if (m.type === 'pdfPosition') applyPdfPosition(m);
  else if (m.type === 'syncStatus') $('syncStatus').textContent = m.message;
  else if (m.type === 'sourcePosition') {
    const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, m.line)));
    const pos = Math.min(line.to, line.from + Math.max(0, m.column - 1));
    editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); editor.focus(); scheduleLayout();
  }
}));
function activeThemeIdentity() {
  const body = document.body, styles = getComputedStyle(body);
  return { id: body.dataset.vscodeThemeId, name: body.dataset.vscodeThemeName, kind: body.dataset.vscodeThemeKind || [...body.classList].find(name => name.startsWith('vscode-')),
    foreground: styles.getPropertyValue('--vscode-editor-foreground').trim(), background: styles.getPropertyValue('--vscode-editor-background').trim() };
}
let lastTheme = JSON.stringify(activeThemeIdentity());
new MutationObserver(() => {
  const theme = activeThemeIdentity(), next = JSON.stringify(theme);
  if (next !== lastTheme) { lastTheme = next; send('theme', { theme }); }
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id', 'data-vscode-theme-name', 'data-vscode-theme-kind'] });
send('ready', { theme: activeThemeIdentity() });
