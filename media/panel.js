/* Local UI only: no network, no HTML interpretation of review text. */
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let state = { active: null, reviews: [], threads: [], target: null };
const saved = vscode.getState() || {};
let drafts = saved.drafts || {};
let pinnedTarget = saved.pinnedTarget || null;
let pending = new Set();
let threadSignature = '';
const persist = () => vscode.setState({ drafts, pinnedTarget, currentOnly: $('currentOnly').checked, resolved: $('resolved').checked });
$('currentOnly').checked = !!saved.currentOnly;
$('resolved').checked = !!saved.resolved;
const draftKey = key => `${state.active || '(new)'}:${key}`;
function send(type, extra = {}) { vscode.postMessage({ type, review: state.active, ...extra }); }
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, fn, quiet = false) {
  const el = node('button', text, quiet ? 'quiet' : '');
  el.type = 'button'; el.addEventListener('click', fn); return el;
}
function updateTarget() {
  const t = pinnedTarget || state.target;
  $('target').textContent = t ? `${t.file} · ${t.range.startLine}–${t.range.endLine}行` : '本文で範囲を選択してください';
  $('snapshot').textContent = t?.snapshot || '';
  $('add').disabled = !t || !($('newBody').value.trim()) || pending.has('new');
}
$('newBody').addEventListener('input', () => {
  if ($('newBody').value && !pinnedTarget) pinnedTarget = state.target;
  if (!$('newBody').value) pinnedTarget = null;
  drafts[draftKey('new')] = $('newBody').value; persist(); updateTarget();
});
$('newBody').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) $('add').click();
});
$('add').addEventListener('click', () => {
  if ($('add').disabled) return;
  pending.add('new');
  send('add', { body: $('newBody').value, target: pinnedTarget || state.target });
  updateTarget();
});
$('settings').addEventListener('click', () => send('settings'));
$('newReview').addEventListener('click', () => send('newReview'));
$('reviews').addEventListener('change', () => send('switch', { name: $('reviews').value }));
for (const id of ['currentOnly', 'resolved']) $(id).addEventListener('change', () => { persist(); renderThreads(true); });

function renderThreads(force = false) {
  const filtered = state.threads.filter(t => ($('resolved').checked || t.status !== 'resolved') &&
    (!$('currentOnly').checked || t.file === state.target?.file));
  const signature = JSON.stringify([state.active, filtered]);
  if (!force && signature === threadSignature) return;
  threadSignature = signature;
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.draft;
  const selection = focused?.selectionStart;
  const end = focused?.selectionEnd;
  const scroll = document.documentElement.scrollTop;
  const content = document.createDocumentFragment();
  if (!filtered.length) content.append(node('p', '表示するコメントはありません。本文で範囲を選び、上の欄から追加できます。', 'empty'));
  for (const t of filtered) {
    const card = node('article', undefined, `thread ${t.status}`);
    const top = node('div', undefined, 'thread-heading');
    const loc = t.location || t.range;
    const link = button(`${t.file} · ${loc.startLine}–${loc.endLine}行`, () => send('navigate', { thread: t.id }), true);
    link.classList.add('location'); top.append(link, node('span', t.status === 'resolved' ? '解決済み' : '未解決', 'badge'));
    card.append(top);
    if (loc.outdated) card.append(node('p', '本文が変更されています。引用を確認してください。', 'outdated'));
    const quote = node('details'); quote.append(node('summary', '対象の本文'), node('pre', t.snapshot)); card.append(quote);
    for (const c of t.comments) {
      const comment = node('div', undefined, 'comment');
      const meta = node('div', undefined, 'meta');
      meta.append(node('strong', c.author === 'reviewer' ? '自分' : c.author === 'agent' ? 'AI' : c.author));
      if (c.createdAt) meta.append(node('span', new Date(c.createdAt).toLocaleString('ja-JP')));
      if (c.editedAt) meta.append(node('span', '編集済み'));
      comment.append(meta, node('p', c.body, 'body'));
      if (c.author === 'reviewer') {
        comment.append(button('編集', () => {
          const input = node('textarea'); input.value = c.body; input.rows = 3; input.setAttribute('aria-label', 'コメントを編集');
          const actions = node('div', undefined, 'actions');
          actions.append(button('保存', () => { if (input.value.trim()) send('edit', { thread: t.id, comment: c.id, body: input.value }); }),
            button('キャンセル', () => renderThreads(true), true));
          comment.replaceChildren(meta, input, actions); input.focus();
        }, true));
      }
      card.append(comment);
    }
    const reply = node('textarea'); reply.rows = 2; reply.placeholder = '返信…'; reply.setAttribute('aria-label', '返信');
    reply.dataset.draft = draftKey(t.id); reply.value = drafts[draftKey(t.id)] || '';
    reply.addEventListener('input', () => { drafts[draftKey(t.id)] = reply.value; persist(); });
    const actions = node('div', undefined, 'actions');
    const submit = button('返信', () => {
      if (!reply.value.trim() || pending.has(t.id)) return;
      pending.add(t.id); submit.disabled = true;
      send('reply', { thread: t.id, body: reply.value });
    });
    reply.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) submit.click();
    });
    actions.append(button(t.status === 'resolved' ? '再開' : '解決', () => send(t.status === 'resolved' ? 'reopen' : 'resolve', { thread: t.id }), true), submit);
    card.append(reply, actions); content.append(card);
  }
  $('threads').replaceChildren(content);
  if (focusKey) {
    const target = Array.from(document.querySelectorAll('textarea[data-draft]')).find(el => el.dataset.draft === focusKey);
    if (target) { target.focus({ preventScroll: true }); target.setSelectionRange(selection, end); }
  }
  document.documentElement.scrollTop = scroll;
}
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'state') {
    const switched = msg.active !== state.active;
    state = msg;
    document.body.classList.toggle('buttons-left', state.buttonSide === 'left');
    const previous = $('reviews').value;
    const names = state.reviews.length ? state.reviews : ['(コメント追加時に作成)'];
    if (Array.from($('reviews').options).map(o => o.value).join('\n') !== names.join('\n')) {
      $('reviews').replaceChildren(...names.map(name => { const option = node('option', name); option.value = name; return option; }));
    }
    $('reviews').value = state.active || names[0];
    $('reviews').disabled = !state.reviews.length;
    if (switched) { pinnedTarget = null; $('newBody').value = drafts[draftKey('new')] || ''; pending.clear(); }
    else if (document.activeElement !== $('newBody') && !$('newBody').value) $('newBody').value = drafts[draftKey('new')] || '';
    updateTarget(); renderThreads();
  } else if (msg.type === 'saved') {
    drafts[draftKey(msg.key)] = ''; pending.delete(msg.key);
    if (msg.key === 'new') { $('newBody').value = ''; pinnedTarget = null; }
    persist(); updateTarget(); renderThreads(true); $('error').textContent = '';
  } else if (msg.type === 'error') {
    $('error').textContent = msg.error; pending.clear(); updateTarget(); renderThreads(true);
  } else if (msg.type === 'compose') { $('newBody').focus(); }
});
send('ready');
