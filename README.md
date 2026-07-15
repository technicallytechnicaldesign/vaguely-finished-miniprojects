# vaguely-finished-miniprojects

Public GitHub Pages surface for the workspace.

**Live page:** the Prompt Dictionary is served as `index.html` at the repo's GitHub Pages URL
(`https://<username>.github.io/vaguely-finished-miniprojects/`).

## How it stays current
`index.html` is **generated, never hand-edited.** The workspace refresh engine
(`_SYSTEM/scripts/refresh.ps1` -> `publish-pages.ps1`) copies the canonical
`CORE/WORKSPACE_OPS/04_DOCS/prompt-dictionary.html` into this repo and pushes on every
refresh where the content changed. To edit the page, edit the source in the workspace,
not here.

Scope today: just the Prompt Dictionary (OPS-0122). Widen later if useful.
