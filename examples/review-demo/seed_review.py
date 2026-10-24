"""Create the fictional review used by the documentation; never replace a store."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
source = (root / 'main.tex').read_text()
comments = json.loads((root / 'comments.json').read_text())
events = []
for index, comment in enumerate(comments, 1):
    quote = comment['quote']
    if source.count(quote) != 1:
        raise SystemExit('Each sample quote must occur exactly once')
    line = source[:source.index(quote)].count('\n') + 1
    thread = f'demo_{index}'
    events.append(dict(op='add_thread', id=thread, file='main.tex',
                       range=dict(startLine=line, endLine=line), snapshot=quote,
                       author='reviewer', body=comment['body'], ts='2026-01-01T12:00:00Z'))
    if comment.get('reply'):
        events.append(dict(op='reply', thread=thread, author='agent',
                           body=comment['reply'], ts='2026-01-01T12:01:00Z'))
store = root / '.review'
if store.exists():
    raise SystemExit('A .review store already exists; nothing was changed')
store.mkdir()
(store / 'demo.log.jsonl').write_text(''.join(json.dumps(event) + '\n' for event in events))
(store / 'state.json').write_text(json.dumps(dict(active='demo')) + '\n')
print('Created the demo review')
