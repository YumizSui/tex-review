import { commentTagIds, commentTagLabels, commentTags, commentMatches, commentPreview, commentReplyFilters, commentReplyLabels } from '../src/core/commentFilters';
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
import { projectComments } from '../src/core/projectComments';
import { sourceLinkedCards, revealCommentCard, survivingCommentAnchor, offscreenCommentCards } from '../src/core/cardLayout';

const api = acquireVsCodeApi();
const $ = id => document.getElementById(id);
// A retained webview may reload newer assets before its host regenerates HTML.
// Upgrade the previous card container before restoring state or accepting input.
if (!$('commentLayout')) {
  const layout = document.createElement('div'); layout.id = 'commentLayout';
  while ($('cards').firstChild) layout.append($('cards').firstChild);
  $('cards').append(layout);
}
const previous = api.getState() || {};
let editor, version = 0, documentGeneration = 0, confirmed = '', inflight = null, restoring = false, conflictDraft = previous.conflictDraft || '';
let review = { active: null, reviews: [], threads: [], file: '' }, config = {}, draftTarget = null;
let drafts = previous.drafts || {}, cards = new Map(), selectedThread = null, activeRange = null;
let openNativeRequested = false, pendingNavigation = null, navigationSent = false, pendingThread = null;
const sourceStates = new Map();
let overview = previous.overview || false;
let commentQuery = previous.commentQuery || '', tagFilter = previous.tagFilter || [];
let replyFilter = commentReplyFilters.includes(previous.replyFilter) ? previous.replyFilter : 'all';
const hasCommentFilter = () => !!commentQuery || tagFilter.length > 0 || replyFilter !== 'all';
const closedOverviewFiles = new Set(previous.closedOverviewFiles || []);
const savedComposers = previous.composers || {};
let pendingChanges = ChangeSet.empty(0), pendingReview = null, pendingComment = null;
const liveAnchors = new Map();
let syncRequest = 0, requestedBuildMode;
let flushTimer, syncTimer, commentPending = false, composing = false, saveRequested = false, pendingCompose = false, buildRequested = null;
const layoutMeasureKey = {};
let followSource = false, commentOffset = 0, commentOrigin = 0, lastLinkedSourceTop = null, expectedRailScroll = null, layoutAnchor = null, commentLayoutDirty = true, cachedCommentLayout = null, resetCommentList = false, commentFilterSignature = '';
let alignComment = false, revealComment = null, alignmentSample = null, alignmentStable = 0, alignmentFrames = 0, alignmentGeneration = 0, restoringCommentFocus = false, pendingCommentScroll = null;
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
const transactionConfig = new Compartment();
const appearanceConfig = new Compartment();
const comparisonConfig = new Compartment();
const markerConfig = new Compartment(), highlights = StateEffect.define();
const key = id => `${review.active || '(new)'}:${id === 'new' ? review.file + ':' : ''}${id}`;
const send = (type, extra = {}) => api.postMessage({ type, file: review.file, generation: documentGeneration, ...extra });
const timings = performanceMonitor(entry => send('performance', entry));
timings.observe();
const saveState = () => {
  if (review.file) { if (draftTarget) savedComposers[review.file] = draftTarget; else delete savedComposers[review.file]; }
  api.setState({ drafts, composers: savedComposers, conflictDraft, file: review.file, overview, commentQuery, tagFilter, replyFilter, closedOverviewFiles: [...closedOverviewFiles], commentScrollTop: $('cards').scrollTop, commentPadding: parseFloat($('commentLayout').style.paddingTop) || 10, scrollTop: editor?.scrollDOM.scrollTop,
    showPdf: $('showPdf').checked, showComments: $('showComments').checked });
};
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
function requestCommentAlignment(id = selectedThread) {
  const generation = ++alignmentGeneration;
  requestAnimationFrame(() => {
    if (generation !== alignmentGeneration) return;
    alignComment = true; revealComment = id; alignmentSample = null; alignmentStable = alignmentFrames = 0; scheduleLayout();
  });
}
function cancelCommentAlignment() { ++alignmentGeneration; alignComment = false; revealComment = null; }
function measureLayout() {
  if (!$('showComments').checked || overview) return null;
  const area = $('commentBody').getBoundingClientRect(), rail = $('cards');
  const signature = [area.width, area.height, editor.contentHeight, layoutAnchor];
  if (commentLayoutDirty || !cachedCommentLayout || signature.some((value, i) => value !== cachedCommentLayout.signature[i])) {
    const byId = new Map(review.threads.map(thread => [thread.id, thread]));
    const items = [...$('commentLayout').children].map(element => {
      const id = element.dataset.thread || 'new', thread = byId.get(id);
      const target = id === 'new' ? draftTarget : thread ? locate(thread) : null;
      if (!target) return null;
      const from = Math.max(0, Math.min(editor.state.doc.length, target.from));
      const anchor = Math.max(10, editor.lineBlockAt(from).top + editor.documentTop + editor.scrollDOM.scrollTop - area.top);
      return {id, element, anchor, height:element.getBoundingClientRect().height, label:thread ? threadLabel(thread) : null};
    }).filter(Boolean);
    const placement = sourceLinkedCards(items, layoutAnchor);
    cachedCommentLayout = {signature, items, ...placement}; commentLayoutDirty = false;
  }
  return {...cachedCommentLayout, height:area.height, sourceTop:editor.scrollDOM.scrollTop,
    sourceMaximum:Math.max(0,editor.scrollDOM.scrollHeight-editor.scrollDOM.clientHeight)};
}
function applyLayout(result) {
  if (editor.dom.style.getPropertyValue('--review-comment-overflow') !== '0px') editor.dom.style.setProperty('--review-comment-overflow', '0px');
  if (!result) { aboveComments.hidden = belowComments.hidden = true; return; }
  const rail = $('cards'), before = rail.scrollTop;
  const last = result.items.at(-1);
  const contentBottom = result.paddingTop + result.items.reduce((sum,item,i)=>sum+item.height+result.gaps[i],0);
  const tail = Math.max(10,result.height-(last?.height || 0)-10,result.sourceMaximum-result.origin+result.height-contentBottom);
  const setStyle = (element, name, value) => { const px = `${Math.round(value * 100) / 100}px`; if (element.style[name] !== px) element.style[name] = px; };
  setStyle($('commentLayout'),'paddingTop',result.paddingTop); setStyle($('commentLayout'),'paddingBottom',tail);
  result.items.forEach((item,i) => {
    setStyle(item.element,'marginTop',result.gaps[i]);
    const label = item.element.querySelector('.card-heading > button');
    if (item.label && label && label.textContent !== item.label) label.textContent = item.label;
    item.element.classList.toggle('is-active',item.id === selectedThread);
    item.element.setAttribute('aria-current',String(item.id === selectedThread));
  });
  commentOrigin = result.origin;
  const baseline = result.sourceTop - commentOrigin;
  let alignmentPosition = null;
  if (resetCommentList && result.items.length) { rail.scrollTop = result.items[0].element.offsetTop-10; commentOffset = rail.scrollTop-baseline; resetCommentList = false; }
  else if (alignComment) {
    const target = result.items.find(item => item.id === (revealComment || selectedThread));
    // Explicit navigation is rare: use the laid-out box rather than estimated
    // packing coordinates, including when a resolved card just disappeared.
    if (target) alignmentPosition = [result.sourceTop, target.element.offsetTop, target.element.offsetHeight, rail.clientHeight, editor.contentHeight];
    rail.scrollTop = target ? revealCommentCard(Math.max(0, baseline), target.element.offsetTop, target.element.offsetHeight, rail.clientHeight) : Math.max(0, baseline);
    commentOffset = rail.scrollTop - baseline;
  }
  else if (followSource || lastLinkedSourceTop !== null && Math.abs(result.sourceTop-lastLinkedSourceTop) > .5) rail.scrollTop = Math.max(0,baseline+commentOffset);
  else { rail.scrollTop = before; commentOffset = rail.scrollTop-baseline; }
  lastLinkedSourceTop = result.sourceTop; expectedRailScroll = rail.scrollTop;
  if (alignComment && alignmentPosition) {
    const stable = alignmentSample && alignmentPosition.every((value, i) => Math.abs(value - alignmentSample[i]) < .5);
    alignmentStable = stable ? alignmentStable + 1 : 0; alignmentSample = alignmentPosition; ++alignmentFrames;
    if (alignmentStable < 2 && alignmentFrames < 12) {
      const generation = alignmentGeneration;
      requestAnimationFrame(() => { if (generation === alignmentGeneration) scheduleLayout(); });
    } else { alignComment = false; revealComment = null; }
  } else { alignComment = false; revealComment = null; }
  followSource = false;
  let top = result.paddingTop;
  const positions = result.items.map((item, i) => {
    top += result.gaps[i]; const position = {id: item.id, top, height: item.height}; top += item.height; return position;
  });
  const outside = offscreenCommentCards(positions, rail.scrollTop, result.height);
  updateOutsideComments(aboveComments, outside.above, true);
  updateOutsideComments(belowComments, outside.below, false);
}

function orderCommentCards() {
  const rail = $('commentLayout');
  const ordered = [...cards].map(([id, entry]) => {
    const thread = review.threads.find(thread => thread.id === id);
    return {id, entry, from: id === 'new' ? draftTarget?.from ?? Infinity : thread ? locate(thread).from : Infinity};
  }).sort((a,b)=>a.from-b.from || a.id.localeCompare(b.id));
  let next = rail.firstElementChild;
  for (const {entry} of ordered) {
    if (entry.element !== next) rail.insertBefore(entry.element, next);
    next = entry.element.nextElementSibling;
  }
}

function refreshDecorations() {
  if (!editor) return;
  for (const [id,entry] of cards) {
    const active = id === selectedThread;
    if (entry.element.classList.contains('is-active') !== active) { entry.element.classList.toggle('is-active',active); commentLayoutDirty = true; }
  }
  const ranges = review.threads.filter(t => t.file === review.file && t.status === 'open' && commentMatches(t, commentQuery, tagFilter, replyFilter)).map(locate)
    .filter(t => !t.outdated && t.to > t.from)
    .map(t => ({ from: t.from, to: t.to, selected: t.id === selectedThread }));
  if (draftTarget?.to > draftTarget?.from) ranges.push({ from: draftTarget.from, to: draftTarget.to, selected: true });
  const selectedType = commentTags(selectedThread === 'new' ? draftTarget?.tags : review.threads.find(thread => thread.id === selectedThread)?.tags)[0];
  editor.dispatch({ effects: highlights.of(Decoration.set(commentHighlights(ranges).map(range => Decoration.mark({
    class: range.selected ? 'cm-review-selected' : 'cm-review-mark',
    attributes: range.selected ? { 'data-comment-type': selectedType } : {},
  }).range(range.from, range.to)), true)) });
  scheduleLayout();
}
function flush() {
  if (!editor || inflight !== null || composing || restoring) return;
  const text = editor.state.doc.toString();
  if (text === confirmed) {
    pendingChanges = ChangeSet.empty(text.length);
    if (review.version === version) { for (const thread of review.threads) if (thread.file === review.file && thread.anchor) liveAnchors.set(thread.id, thread.anchor); refreshDecorations(); }
    finishComment(); finishNavigation(); return;
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
  if (!editor || config.pdfEnabled === false || (!force && config.pdfSync !== 'automatic')) return;
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
  if (msg.selection?.thread) {
    commentQuery = ''; tagFilter = []; replyFilter = 'all'; $('commentSearch').value = ''; updateTagFilter();
    if (msg.showResolved) $('resolved').checked = true;
  }
  if (editor) {
    sourceStates.set(review.file, { state: editor.state, scrollTop: editor.scrollDOM.scrollTop, commentScrollTop: $('cards').scrollTop, commentPadding: parseFloat($('commentLayout').style.paddingTop) || 10, draftTarget,
      conflictDraft, selectedThread });
    clearCards(); editor.destroy(); liveAnchors.clear();
  }
  if (msg.renamedFrom && msg.renamedFrom !== msg.file) {
    if (sourceStates.has(msg.renamedFrom)) sourceStates.set(msg.file, sourceStates.get(msg.renamedFrom));
    sourceStates.delete(msg.renamedFrom);
    if (savedComposers[msg.renamedFrom]) { savedComposers[msg.file]=savedComposers[msg.renamedFrom]; delete savedComposers[msg.renamedFrom]; }
    for (const draftKey of Object.keys(drafts)) if (draftKey.endsWith(`:${msg.renamedFrom}:new`)) {
      drafts[draftKey.slice(0,-(`${msg.renamedFrom}:new`.length))+msg.file+':new']=drafts[draftKey]; delete drafts[draftKey];
    }
  }
  const cached = sourceStates.get(msg.file);
  cancelCommentAlignment(); followSource = false; lastLinkedSourceTop = null; expectedRailScroll = null; cachedCommentLayout = null; commentLayoutDirty = true; layoutAnchor = null;
  pendingCommentScroll = cached?.commentScrollTop ?? (previous.file === msg.file ? previous.commentScrollTop || 0 : 0);
  $('commentLayout').style.paddingTop = `${cached?.commentPadding ?? (previous.file === msg.file ? previous.commentPadding || 10 : 10)}px`;
  clearTimeout(flushTimer); clearTimeout(syncTimer);
  pendingReview = null; pendingChanges = ChangeSet.empty(msg.text.length); inflight = null;
  draftTarget = null; pendingComment = null; commentPending = false; selectedThread = msg.thread || cached?.selectedThread || null; layoutAnchor = selectedThread;
  pendingThread = msg.thread || null; navigationSent = false;
  conflictDraft = cached?.conflictDraft || (previous.file === msg.file ? previous.conflictDraft || '' : '');
  pendingChanges = ChangeSet.empty(msg.text.length);
  version = msg.version; documentGeneration = msg.generation ?? 0; confirmed = msg.text; config = msg.config; review.file = msg.file; if (msg.active !== undefined) review.active = msg.active; pendingCompose = !!msg.selection?.compose || !!msg.compose;
  pdfjs.GlobalWorkerOptions.workerSrc = msg.worker;
  editor = new EditorView({ parent: $('source'), state: EditorState.create({ doc: msg.text,
    selection: msg.selection && Number.isFinite(msg.selection.from) ? { anchor: Math.min(msg.text.length, msg.selection.from), head: Math.min(msg.text.length, msg.selection.to ?? msg.selection.from) } : undefined,
    extensions: [lineNumbers(), highlightActiveLine(), history(), highlightSelectionMatches(), search({ top: true, createPanel: createSearchPanel,
        scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'center' }) }),
      config.pdfEnabled === false ? [] : texParser, EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-Alt-m', run: () => { compose(); return true; } },
        { key: 'Mod-s', run: () => { requestSave(); return true; } },
        { key: 'Escape', run: () => { if (!cards.has('new')) return false; cancelCompose(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      transactionConfig.of(EditorState.readOnly.of(!!msg.transactionPending)), appearanceConfig.of(drawSelection()), comparisonConfig.of([]), nativeDecorations, decorations, markerConfig.of(markerExtension(config.markerSide)),
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
        if (update.selectionSet) {
          forward();
          // Keep the captured comment target while selecting other text to copy.
          if (draftTarget) updateComposer();
        }
        if (update.docChanged) updateComparisonCount();
        if (update.geometryChanged || update.docChanged) commentLayoutDirty = true;
        if (update.viewportChanged || update.geometryChanged || update.docChanged) scheduleLayout();
      }),
      EditorView.domEventHandlers({ compositionstart() { composing = true; }, compositionend() { composing = false; setTimeout(flush, 0); } }),
    ] }) });
  if (cached) {
    let state = cached.state;
    if (state.doc.toString() !== msg.text) state = state.update({ changes: sourceChanges(state.doc, sourceText(msg.text)), annotations: Transaction.addToHistory.of(false) }).state;
    editor.setState(state);
    editor.dispatch({ effects: [nativeTokens.of(Decoration.none), transactionConfig.reconfigure(EditorState.readOnly.of(!!msg.transactionPending)), comparisonConfig.reconfigure([])] });
  }
  if (msg.selection) {
    const line = Number.isFinite(msg.selection.line) ? editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, msg.selection.line))) : null;
    const from = line ? Math.min(line.to, line.from + Math.max(0, (msg.selection.column || 1) - 1)) : Math.min(msg.text.length, msg.selection.from || 0);
    const to = line ? from : Math.min(msg.text.length, msg.selection.to ?? from);
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  }
  const savedTarget = cached?.draftTarget || savedComposers[msg.file];
  if (savedTarget) {
    const target = cached ? { ...savedTarget, ...followDraftTarget(cached.state.doc, editor.state.doc, savedTarget) }
      : { ...savedTarget, from: Math.min(msg.text.length, savedTarget.from), to: Math.min(msg.text.length, savedTarget.to), status: msg.text.slice(savedTarget.from, savedTarget.to) === savedTarget.snapshot ? 'attached' : 'uncertain' };
    editor.dispatch({ selection: { anchor: target.from, head: target.to } });
    compose(); draftTarget = target; updateComposer();
  }
  editor.scrollDOM.addEventListener('scroll', () => { followSource = true; scheduleLayout(); saveState(); }, { passive: true });
  applyAppearance();
  if (cached && !msg.selection && !msg.thread) editor.scrollDOM.scrollTop = cached.scrollTop;
  else if (!cached && previous.file === msg.file && previous.scrollTop && !msg.selection) editor.scrollDOM.scrollTop = previous.scrollTop;
  if (conflictDraft && conflictDraft !== msg.text) send('compareUnsaved', { text: conflictDraft });
  else if (conflictDraft) { conflictDraft = ''; saveState(); }
  editor.focus(); forward(); finishNavigation();
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
  const action = documentUpdate(msg, { version, confirmed, local, inflight, generation: documentGeneration });
  if (action === 'ignore') return;
  if (action === 'ack') {
    confirmed = msg.text; version = msg.version; documentGeneration = msg.generation ?? 0; inflight = null;
    if (local !== confirmed) flush(); else { $('status').textContent = t('Changes applied'); acceptPendingReview(); finishComment(); finishSave(); finishNavigation(); }
    return;
  }
  if (action === 'refresh') {
    version = msg.version; documentGeneration = msg.generation ?? 0; inflight = null;
    pendingChanges = sourceChanges(sourceText(confirmed), editor.state.doc);
    flush(); finishSave(); finishNavigation(); return;
  }
  if (action === 'conflict') {
    conflictDraft = local; pendingNavigation = null; navigationSent = false; pendingComment = null; commentPending = false; saveRequested = false; buildRequested = null; openNativeRequested = false; saveState();
    send('compareUnsaved', { text: local });
  }
  restoring = true;
  const changes = sourceChanges(editor.state.doc, sourceText(msg.text));
  editor.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
  restoring = false; confirmed = msg.text; version = msg.version; documentGeneration = msg.generation ?? 0; inflight = null;
  pendingChanges = ChangeSet.empty(msg.text.length); acceptPendingReview();
  refreshDecorations();
}
function focusCard(id) {
  if (restoringCommentFocus || selectedThread === id) return;
  selectedThread = id; layoutAnchor = id;
  requestCommentAlignment();
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
  return review.threads.filter(thread => thread.file === review.file && ($('resolved').checked || thread.status === 'open') && commentMatches(thread, commentQuery, tagFilter, replyFilter));
}
function manuscriptThreads() { return projectComments(review.threads.filter(thread => commentMatches(thread, commentQuery, tagFilter, replyFilter)), review.files || [review.file], $('resolved').checked); }
function jumpThread(thread) {
  if (overview && closedOverviewFiles.delete(thread.file)) saveState();
  if (thread.file !== review.file) {
    requestNavigation({ file: thread.file, thread: thread.id }); return;
  }
  selectedThread = null; focusCard(thread.id);
  const loc = locate(thread);
  editor.dispatch({ selection: { anchor: loc.from, head: loc.to }, effects: EditorView.scrollIntoView(loc.from, { y: 'center' }) });
  renderOverview(); refreshDecorations(); editor.focus(); forward(true);
}
function navigateComment(direction) {
  if (!editor) return;
  const threads = manuscriptThreads();
  let at = threads.findIndex(thread => thread.id === selectedThread);
  if (at < 0) {
    const fileIndex = (review.files || [review.file]).indexOf(review.file);
    const line = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    at = direction > 0
      ? threads.findIndex(thread => (review.files || [review.file]).indexOf(thread.file) > fileIndex || thread.file === review.file && thread.range.startLine >= line)
      : threads.findLastIndex(thread => (review.files || [review.file]).indexOf(thread.file) < fileIndex || thread.file === review.file && thread.range.startLine <= line);
    if (at < 0) at = direction > 0 ? 0 : threads.length - 1;
  } else at = (at + direction + threads.length) % threads.length;
  if (threads[at]) jumpThread(threads[at]);
}
function requestNavigation(request) {
  pendingNavigation = request;
  if (!navigationSent) { flush(); finishNavigation(); }
}
function finishNavigation() {
  if (!pendingNavigation || navigationSent || !editor || composing || inflight !== null || commentPending || pendingComment || saveRequested || buildRequested !== null || editor.state.doc.toString() !== confirmed) return;
  if (conflictDraft) { $('error').textContent = t('Resolve unsaved changes before switching files.'); pendingNavigation = null; return; }
  const request = pendingNavigation; pendingNavigation = null; navigationSent = true;
  send('navigate', { target: request.file, selection: request.selection, thread: request.thread, root: request.root, explicit: request.explicit });
}
function renderOverview() {
  const threads = manuscriptThreads();
  $('commentEmpty').hidden = overview || visibleThreads().length > 0 || cards.has('new') || !hasCommentFilter();
  $('previousComment').disabled = $('nextComment').disabled = threads.length === 0;
  $('overviewCount').textContent = review.threads.filter(thread => (review.files || []).includes(thread.file) && thread.status === 'open' && commentMatches(thread, commentQuery, tagFilter, replyFilter)).length || '';
  const list = $('commentOverview');
  list.hidden = !overview; $('cards').hidden = overview;
  $('currentComments').classList.toggle('active', !overview); $('allComments').classList.toggle('active', overview);
  $('currentComments').setAttribute('aria-pressed', String(!overview)); $('allComments').setAttribute('aria-pressed', String(overview));
  if (!overview) return;
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  if (!threads.length) { list.append(make('p', t(hasCommentFilter() ? 'No matching comments.' : 'No comments in this manuscript.'), 'overview-empty')); return; }
  const counts = new Map();
  for (const thread of threads) counts.set(thread.file, (counts.get(thread.file) || 0) + 1);
  let group;
  for (const thread of threads) {
    if (group?.dataset.file !== thread.file) {
      const file = thread.file;
      group = make('details', undefined, 'overview-group'); group.dataset.file = file;
      group.open = !closedOverviewFiles.has(file);
      const heading = make('summary', undefined, 'overview-file');
      const count = counts.get(file);
      heading.setAttribute('aria-label', `${file} (${count})`);
      heading.append(make('span', file), make('span', String(count), 'count'));
      group.append(heading);
      const disclosure = group;
      group.addEventListener('toggle', () => {
        if (!disclosure.isConnected) return;
        const closed = !disclosure.open;
        if (closed === closedOverviewFiles.has(file)) return;
        if (closed) closedOverviewFiles.add(file); else closedOverviewFiles.delete(file);
        saveState();
      });
      list.append(group);
    }
    const entry = button(undefined, () => { overview = false; jumpThread(thread); renderOverview(); scheduleLayout(); saveState(); });
    entry.className = 'overview-comment' + (selectedThread === thread.id ? ' active' : '');
    entry.dataset.commentType = commentTags(thread.tags)[0];
    entry.setAttribute('aria-current', String(selectedThread === thread.id));
    entry.append(make('small', `${t('Line {0}', thread.range.startLine)} · ${commentTags(thread.tags).map(tag => t(commentTagLabels[tag])).join(' · ')}`), make('span', commentPreview(thread, commentQuery)));
    group.append(entry);
  }
  list.scrollTop = scrollTop;
}
function updateTagFilter() {
  const active = tagFilter.length > 0 || replyFilter !== 'all';
  $('filterCommentTags').classList.toggle('is-filtered', active);
  $('filterCommentTags').setAttribute('aria-pressed', String(active));
  $('filterCommentTags').title = active
    ? [...tagFilter.map(tag => t(commentTagLabels[tag])), ...(replyFilter !== 'all' ? [t(commentReplyLabels[replyFilter])] : [])].join(' · ')
    : t('Filter comments');
}
const commentFilterPopover = make('div', undefined, 'comment-filter-popover');
commentFilterPopover.hidden = true; commentFilterPopover.id = 'commentFilterPopover';
commentFilterPopover.setAttribute('role', 'dialog'); commentFilterPopover.setAttribute('aria-label', t('Filter comments'));
$('comments').append(commentFilterPopover);
$('filterCommentTags').setAttribute('aria-haspopup', 'dialog');
$('filterCommentTags').setAttribute('aria-controls', commentFilterPopover.id);
$('filterCommentTags').setAttribute('aria-expanded', 'false');
function closeCommentFilter(focus = false) {
  commentFilterPopover.hidden = true; $('filterCommentTags').setAttribute('aria-expanded', 'false');
  if (focus) $('filterCommentTags').focus({preventScroll:true});
}
function renderCommentFilter() {
  const focused = document.activeElement?.dataset.filterChoice;
  commentFilterPopover.replaceChildren();
  const choice = (label, selected, id, action) => {
    const control = button(t(label), () => { action(); updateTagFilter(); renderComments(); saveState(); renderCommentFilter(); });
    control.className = 'filter-choice'; control.dataset.filterChoice = id; control.setAttribute('aria-pressed', String(selected));
    return control;
  };
  commentFilterPopover.append(make('strong', t('Comment type'), 'filter-heading'));
  const types = make('div', undefined, 'filter-types');
  types.append(choice('All types', !tagFilter.length, 'all-types', () => { tagFilter = []; }));
  for (const tag of commentTagIds) types.append(choice(commentTagLabels[tag], tagFilter.includes(tag), tag,
    () => { tagFilter = tagFilter.includes(tag) ? tagFilter.filter(item => item !== tag) : [...tagFilter, tag]; }));
  commentFilterPopover.append(types, make('strong', t('Replies'), 'filter-heading'));
  for (const filter of commentReplyFilters) commentFilterPopover.append(choice(commentReplyLabels[filter], replyFilter === filter, filter, () => {replyFilter = filter;}));
  const clear = button(t('Clear filters'), () => { tagFilter = []; replyFilter = 'all'; updateTagFilter(); renderComments(); saveState(); renderCommentFilter(); });
  clear.className = 'filter-clear'; commentFilterPopover.append(clear);
  if (focused) [...commentFilterPopover.querySelectorAll('button')].find(control => control.dataset.filterChoice === focused)?.focus({preventScroll:true});
}
commentFilterPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommentFilter(true); }
});
document.addEventListener('pointerdown', event => {
  if (!commentFilterPopover.hidden && !commentFilterPopover.contains(event.target) && !$('filterCommentTags').contains(event.target)) closeCommentFilter();
});
$('toggleCommentSearch').addEventListener('click', () => {
  const row = $('commentSearchRow'); row.hidden = !row.hidden;
  if (!row.hidden) $('commentSearch').focus();
  else { commentQuery = ''; $('commentSearch').value = ''; renderComments(); saveState(); }
  scheduleLayout();
});
let commentSearchTimer;
$('commentSearch').value = commentQuery;
$('commentSearchRow').hidden = !commentQuery;
$('commentSearch').addEventListener('input', () => {
  clearTimeout(commentSearchTimer);
  commentSearchTimer = setTimeout(() => { commentQuery = $('commentSearch').value; renderComments(); saveState(); }, 100);
});
$('commentSearch').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault(); clearTimeout(commentSearchTimer); commentQuery = ''; $('commentSearch').value = ''; $('commentSearchRow').hidden = true;
  renderComments(); saveState(); $('toggleCommentSearch').focus();
});
$('filterCommentTags').addEventListener('click', () => {
  if (!commentFilterPopover.hidden) { closeCommentFilter(); return; }
  renderCommentFilter(); commentFilterPopover.style.top = `${$('commentHeader').offsetHeight + 4}px`;
  commentFilterPopover.hidden = false; $('filterCommentTags').setAttribute('aria-expanded', 'true');
  commentFilterPopover.querySelector('button')?.focus({preventScroll:true});
});
updateTagFilter();
const outsideCommentButton = (above) => {
  const control = button('', () => {
    const id = control.dataset.thread;
    if (id === 'new') { requestCommentAlignment(id); cards.get(id)?.element.querySelector('textarea')?.focus({preventScroll:true}); }
    else { const thread = review.threads.find(thread => thread.id === id); if (thread) jumpThread(thread); }
  });
  control.className = 'outside-comments ' + (above ? 'above' : 'below'); control.hidden = true;
  $('commentBody').append(control); return control;
};
const aboveComments = outsideCommentButton(true), belowComments = outsideCommentButton(false);
function updateOutsideComments(control, ids, above) {
  control.hidden = !ids.length;
  if (!ids.length) return;
  const label = t(above ? (ids.length === 1 ? '{0} comment above' : '{0} comments above') : (ids.length === 1 ? '{0} comment below' : '{0} comments below'), ids.length);
  control.textContent = `${above ? '↑' : '↓'} ${label}`; control.setAttribute('aria-label', label);
  control.dataset.thread = above ? ids.at(-1) : ids[0];
}
$('allComments').addEventListener('click', () => { overview = true; renderOverview(); saveState(); });
$('currentComments').addEventListener('click', () => { overview = false; renderOverview(); scheduleLayout(); saveState(); });
$('sources').addEventListener('change', () => requestNavigation({ file: $('sources').value }));
$('previousComment').addEventListener('click', () => navigateComment(-1));
$('nextComment').addEventListener('click', () => navigateComment(1));
function clearCards() { for (const c of cards.values()) c.element.remove(); cards.clear(); }
function renderComments() {
  if (!editor) return;
  commentLayoutDirty = true;
  const filterSignature = JSON.stringify([commentQuery,tagFilter,replyFilter]);
  if (filterSignature !== commentFilterSignature) { resetCommentList = hasCommentFilter(); commentFilterSignature = filterSignature; }
  const previousIds = [...cards.keys()], previousAnchor = layoutAnchor;
  const currentIds = new Set(), restoreScroll = [], railScroll = $('cards').scrollTop;
  const focusedInput = document.activeElement instanceof HTMLTextAreaElement && $('cards').contains(document.activeElement) ? document.activeElement : null;
  const focusedSelection = focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd] : null;
  let restoreInput = null;
  const threads = visibleThreads();
  $('commentCount').textContent = review.threads.filter(thread => thread.file === review.file && thread.status === 'open' && commentMatches(thread, commentQuery, tagFilter, replyFilter)).length || '';
  renderOverview();
  for (const thread of threads) {
    currentIds.add(thread.id);
    const loc = locate(thread);
    const signature = JSON.stringify([thread.status, thread.tags, thread.comments, loc.status, loc.outdated]);
    if (cards.get(thread.id)?.signature === signature) continue;
    const old = cards.get(thread.id), scrollTop = old?.element.scrollTop || 0, replySaved = old?.replySaved; const focus = document.activeElement?.dataset?.draft === key(thread.id);
    const selection = focus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    old?.element.remove();
    const card = make('article', undefined, 'card'); card.dataset.thread = thread.id; card.dataset.commentType = commentTags(thread.tags)[0];
    card.addEventListener('pointerdown', () => focusCard(thread.id));
    card.addEventListener('focusin', () => focusCard(thread.id));
    const head = make('div', undefined, 'card-heading');
    head.append(button(threadLabel(thread, loc), () => {
      const current = locate(review.threads.find(item => item.id === thread.id) || thread);
      selectedThread = thread.id; layoutAnchor = thread.id; requestCommentAlignment(); editor.dispatch({ selection: { anchor: current.from, head: current.to }, effects: EditorView.scrollIntoView(current.from, { y: 'center' }) });
      refreshDecorations(); editor.focus(); forward();
    }));
    const resolved = thread.status === 'resolved';
    const action = button('', () => send(resolved ? 'reopen' : 'resolve', { thread: thread.id, review: review.active }));
    action.className = 'thread-action';
    action.title = t(resolved ? 'Reopen' : 'Resolve');
    action.setAttribute('aria-label', action.title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', resolved ? 'M3 6h6a4 4 0 1 1-3.5 6 M3 6l3-3 M3 6l3 3' : 'M3 8l3 3 7-7');
    svg.append(path); action.append(svg);
    const more = button('…', () => send('threadActions', { thread: thread.id, review: review.active }));
    more.className = 'thread-action'; more.title = t('Comment options');
    more.setAttribute('aria-label', more.title);
    head.append(action, more);
    card.append(head);
    const tags = make('div', undefined, 'thread-tags');
    tags.textContent = commentTags(thread.tags).map(tag => t(commentTagLabels[tag])).join(' · ');
    card.append(tags);
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
    const submit = () => {
      const entry = cards.get(thread.id);
      if (!input.value.trim() || entry?.pendingReply) return;
      entry.pendingReply = { body: input.value, focus: card.contains(document.activeElement) };
      send('reply', { thread: thread.id, body: input.value, review: review.active });
    };
    input.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = ''; delete drafts[key(thread.id)]; saveState(); editor.focus(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    card.append(input, button(t('Reply'), submit)); $('commentLayout').append(card); cards.set(thread.id, { element: card, signature, pendingReply: old?.pendingReply });
    restoreScroll.push({card, scrollTop, replySaved});
    if (replySaved?.focus) restoreInput = { input, selection: [input.value.length, input.value.length] };
    else if (focus) restoreInput = { input, selection };
  }
  for (const [id, c] of cards) if (id !== 'new' && !currentIds.has(id)) { c.element.remove(); cards.delete(id); }
  const remainingIds = [...cards.keys()];
  if (previousIds.some(id => !cards.has(id))) {
    const previousOrder = cachedCommentLayout?.items.map(item => item.id) || previousIds;
    layoutAnchor = survivingCommentAnchor(previousOrder, remainingIds, previousAnchor);
    if (!cards.has(selectedThread)) selectedThread = null;
    // The previous rail offset belongs to a different packing/origin. It cannot
    // be carried across resolution or deletion without stranding survivors.
    commentOffset = 0; followSource = true;
    if (layoutAnchor) requestCommentAlignment(layoutAnchor);
  }
  orderCommentCards();
  const restored = restoreInput || (focusedInput?.isConnected ? {input:focusedInput,selection:focusedSelection} : null);
  if (restored) { restoringCommentFocus = true; restored.input.focus({preventScroll:true}); restored.input.setSelectionRange(...restored.selection); restoringCommentFocus = false; }
  for (const {card, scrollTop, replySaved} of restoreScroll) card.scrollTop = replySaved ? card.scrollHeight : scrollTop;
  $('cards').scrollTop = pendingCommentScroll ?? railScroll; pendingCommentScroll = null;
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
function cancelCompose(focus = true) {
  cards.get('new')?.element.remove(); cards.delete('new'); delete drafts[key('new')];
  draftTarget = null; pendingComment = null; commentPending = false; if (selectedThread === 'new') selectedThread = null;
  if (layoutAnchor === 'new') {
    const items = cachedCommentLayout?.items || [], at = items.findIndex(item=>item.id==='new');
    layoutAnchor = items.slice(at+1).find(item=>cards.has(item.id))?.id || [...cards.keys()][0] || null;
    followSource = true;
  }
  commentLayoutDirty = true;
  saveState(); refreshDecorations(); if (focus) editor.focus();
}
function updateComposer() {
  const card = cards.get('new')?.element; if (!card || !draftTarget) return;
  card.querySelector('strong').textContent = t('Comment on line {0}', editor.state.doc.lineAt(draftTarget.from).number);
  card.querySelector('.quote').textContent = draftTarget.snapshot.slice(0, 180);
  const types = card.querySelector('.composer-type');
  if (types) types.value = commentTags(draftTarget.tags)[0];
  card.dataset.commentType = commentTags(draftTarget.tags)[0];
  const update = card.querySelector('.composer-update-selection'), current = snapshotSelection();
  if (update) update.hidden = draftTarget.status === 'attached' && current.from === draftTarget.from && current.to === draftTarget.to && current.snapshot === draftTarget.snapshot;
}
function compose() {
  if (!editor) return;
  $('showComments').checked = true; setColumns(); $('commentEmpty').hidden = true;
  if (cards.has('new')) { cards.get('new').element.querySelector('textarea').focus(); return; }
  draftTarget = { ...snapshotSelection(), status: 'attached', tags: ['action'] };
  const card = make('article', undefined, 'card composer'); card.dataset.thread = 'new'; commentLayoutDirty = true;
  const heading = make('div',undefined,'composer-heading'); heading.append(make('strong', t('Comment on line {0}', draftTarget.range.startLine))); card.append(heading);
  const quote = make('p', draftTarget.snapshot.slice(0, 180), 'quote'); card.append(quote);
  const type = make('select');
  type.className = 'composer-type'; type.title = t('Comment type'); type.setAttribute('aria-label',t('Comment type'));
  for (const tag of commentTagIds) { const option = make('option',t(commentTagLabels[tag])); option.value = tag; type.append(option); }
  type.addEventListener('change',()=>{
    if (!draftTarget) return;
    draftTarget.tags = [type.value]; updateComposer(); refreshDecorations(); saveState(); card.querySelector('textarea').focus({preventScroll:true});
  });
  card.append(type);
  const input = make('textarea'); input.rows = 3; input.placeholder = t('Write a comment…'); input.setAttribute('aria-label', t('Write a comment…')); input.value = drafts[key('new')] || '';
  input.addEventListener('input', () => { drafts[key('new')] = input.value; saveState(); });
  const submit = () => {
    if (!input.value.trim() || commentPending) return;
    commentPending = true; pendingComment = { review: review.active, body: input.value, snapshot: draftTarget.snapshot, tags: commentTags(draftTarget.tags) };
    flush(); finishComment();
  };
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCompose(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  const actions = make('div',undefined,'composer-actions');
  const add = button(t('Add'), submit); add.className = 'composer-submit'; add.disabled = !input.value.trim();
  input.addEventListener('input',()=>{ add.disabled = !input.value.trim(); });
  const cancel = button(t('Cancel'),()=>cancelCompose()); cancel.className = 'composer-cancel';
  const update = button(t('Update selection'), () => {
    draftTarget = { ...snapshotSelection(), status: 'attached', tags: draftTarget.tags }; updateComposer(); refreshDecorations(); input.focus();
  }); update.className = 'composer-update-selection';
  actions.append(add,cancel,update); card.append(input,actions);
  $('commentLayout').append(card); cards.set('new', { element: card }); selectedThread = 'new';
  layoutAnchor = 'new'; updateComposer(); orderCommentCards(); requestCommentAlignment(); refreshDecorations(); scheduleLayout(); input.focus();
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
new ResizeObserver(() => { scheduleLayout(); schedulePdf(); }).observe($('workspace'));
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
function syncSourceFromComments(before, after) {
  if (!editor || overview || Math.abs(after - before) < .5) return;
  cancelCommentAlignment(); followSource = false;
  editor.scrollDOM.scrollTop += after - before;
  // Retain overflow at either source boundary so dense discussions remain reachable.
  commentOffset = after - (editor.scrollDOM.scrollTop - commentOrigin);
  lastLinkedSourceTop = editor.scrollDOM.scrollTop;
  expectedRailScroll = after;
  scheduleLayout(); saveState();
}
let draggingCommentRail = false;
const scrollComments = commentScrollHandler(
  $('cards'),
  (target, event) => {
    for (let element = target instanceof Element ? target : target?.parentElement; element && element !== $('cards'); element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) {
        return element;
      }
    }
    return null;
  },
  element => parseFloat(getComputedStyle(element).lineHeight) || editor.defaultLineHeight,
  undefined,
  owner => {
    // A thread owns its boundaries. Only a reply textarea may chain to its thread.
    if (owner.classList.contains('card')) return owner;
    for (let parent = owner.parentElement; parent && parent !== $('cards'); parent = parent.parentElement)
      if (parent.scrollHeight > parent.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
    return $('cards');
  },
  delta => syncSourceFromComments($('cards').scrollTop - delta, $('cards').scrollTop),
);
$('comments').addEventListener('wheel', event => {
  cancelCommentAlignment(); followSource = false;
  if (!overview) scrollComments(event);
}, {passive:false});
$('commentBody').addEventListener('pointerdown', event => {
  if (event.target.closest('.card,button,input,textarea,label,summary')) return;
  selectedThread = null; cancelCommentAlignment(); refreshDecorations(); scheduleLayout(); saveState();
});
$('cards').addEventListener('pointerdown', event => { draggingCommentRail = event.target === $('cards'); });
window.addEventListener('pointerup', () => { draggingCommentRail = false; });
window.addEventListener('pointercancel', () => { draggingCommentRail = false; });
$('cards').addEventListener('scroll', () => {
  const top = $('cards').scrollTop;
  if (expectedRailScroll === null || Math.abs(top - expectedRailScroll) > 1) {
    if (draggingCommentRail && expectedRailScroll !== null) syncSourceFromComments(expectedRailScroll, top);
    else commentOffset = top - (editor.scrollDOM.scrollTop - commentOrigin);
  }
  expectedRailScroll = top; scheduleLayout(); saveState();
}, { passive: true });
$('source').addEventListener('wheel', cancelCommentAlignment, {passive:true});
$('source').addEventListener('pointerdown', cancelCommentAlignment, {passive:true});
$('roots').addEventListener('change', () => requestNavigation({ file: $('roots').value, root: $('roots').value, explicit: true }));
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
  const textOnly = config.pdfEnabled === false;
  $('showPdf').parentElement.hidden = textOnly;
  document.body.classList.toggle('text-only', textOnly);
  document.body.classList.toggle('no-pdf', textOnly || !$('showPdf').checked);
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
    if (pendingThread) { const thread = review.threads.find(thread => thread.id === pendingThread); pendingThread = null; if (thread) jumpThread(thread); }
    const sources = $('sources'); sources.replaceChildren(...(review.files || [review.file]).map(file => { const option = make('option', file); option.value = file; return option; }));
    if (!(review.files || []).includes(review.file)) { const option = make('option', review.file); option.value = review.file; sources.append(option); }
    sources.value = review.file; sources.title = review.file; saveState();

}
window.addEventListener('message', event => timings.measure(`message.${event.data?.type || 'unknown'}`, () => {
  const m = event.data;
  if (m.file && m.file !== review.file && !['source', 'init', 'requestNavigation'].includes(m.type)) return;
  if (m.type === 'requestNavigation') { requestNavigation(m); }
  else if (m.type === 'action') {
    if (m.action === 'fullBuild') { requestedBuildMode = 'full'; $('buildPdf').click(); }
    else if (m.action === 'openNative') { openNativeRequested = true; requestSave(); }
    else if (m.action === 'toggleComments' || m.action === 'togglePdf') {
      const toggle = $(m.action === 'toggleComments' ? 'showComments' : 'showPdf'); toggle.checked = !toggle.checked; setColumns();
    }
  }
  else if (m.type === 'init' || m.type === 'source') { initialize(m); setColumns(); }
  else if (['document', 'ack', 'conflict'].includes(m.type)) applyDocument(m);
  else if (m.type === 'activateSelection') {
    const length = editor.state.doc.length;
    editor.dispatch({ selection: { anchor: Math.min(length, m.from), head: Math.min(length, m.to) }, effects: EditorView.scrollIntoView(Math.min(length, m.from), { y: 'center' }) });
    if (m.compose) compose(); else editor.focus();
  }
  else if (m.type === 'linkCopied') $('status').textContent = t('Comment link copied');
  else if (m.type === 'transaction') { editor.dispatch({effects:transactionConfig.reconfigure(EditorState.readOnly.of(!!m.busy))}); $('status').textContent = m.busy ? t('AI edit pending') : t('Changes applied'); }
  else if (m.type === 'syntax') {
    if (m.version !== version || inflight || editor.state.doc.toString() !== confirmed) return;
    for (const type of ['action', 'question', 'todo']) {
      const color = m.accents?.[type];
      if (/^#[0-9a-f]{3,8}$/i.test(color || '')) document.body.style.setProperty(`--review-syntax-${type}`, color);
      else document.body.style.removeProperty(`--review-syntax-${type}`);
    }
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
    const entry = cards.get(m.key), pending = entry?.pendingReply;
    if (m.key === 'new' || (pending && drafts[key(m.key)] === pending.body)) drafts[key(m.key)] = '';
    commentPending = false;
    if (m.key === 'new') { cards.get('new')?.element.remove(); cards.delete('new'); draftTarget = null; if (m.thread && !pendingNavigation) pendingThread = m.thread; }
    else if (entry) {
      // Keep the existing card until the updated review arrives, preserving its viewport.
      entry.signature = null; entry.replySaved = pending && { ...pending, focus: pending.focus && entry.element.contains(document.activeElement) }; entry.pendingReply = null;
      const input = entry.element.querySelector('textarea[data-draft]');
      if (input) input.value = drafts[key(m.key)] || '';
    }
    saveState(); $('error').textContent = ''; finishNavigation();
  } else if (m.type === 'error') { for (const entry of cards.values()) entry.pendingReply = null; pendingNavigation = null; navigationSent = false; pendingComment = null; commentPending = false; busyButton('buildPdf', false, 'Build PDF', 'Building PDF…'); busyButton('syncPdf', false, 'Sync PDF', 'Synchronizing PDF…'); $('error').textContent = m.error; }
  else if (m.type === 'building') { $('buildMode').disabled = $('roots').disabled = m.busy; busyButton('buildPdf', m.busy, 'Build PDF', 'Building PDF…'); if (m.busy) $('status').textContent = t('Building PDF…'); }
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
