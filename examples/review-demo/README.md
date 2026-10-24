# Review demo

A fictional two-page document used in the TeX Review screenshots and demo.
`main.tex` is the current draft; `baseline.tex` is a saved earlier version.
`comments.json` contains sample review threads.

```sh
latexmk -lualatex -synctex=1 main.tex
python3 seed_review.py
```

Open this folder in VS Code or Cursor, then open `main.tex` with TeX Review.
The seeding script creates a new local `.review/` store and refuses to replace
an existing store.
