# Chunk Stage

Stage or unstage just the lines you select. Review a change piece by piece, keep what you've reviewed staged, and leave the rest for later. Works in VS Code and Cursor, locally and over Remote SSH, WSL and containers.

## Using it

Select some lines (or put the cursor on a changed line), then:

- click **Stage** or **Unstage** in the status bar (hover to see how many lines change),
- or right-click and pick **Chunk: Stage Selected Lines** / **Chunk: Unstage Selected Lines**,
- or press the shortcut.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Stage selected lines | `Ctrl+Shift+S` | `Ctrl+Alt+Shift+S` |
| Unstage selected lines | `Ctrl+Shift+U` | `Ctrl+Alt+Shift+U` |
| Undo the last stage/unstage | `Cmd+Z` | `Ctrl+Z` |
| Redo it | `Cmd+Shift+Z` | `Ctrl+Shift+Z` / `Ctrl+Y` |

The affected lines light up the moment you act (green for stage, amber for unstage), so you get feedback right away even when git or a remote connection takes a moment to update the gutter.

## What it does

- **Selected lines only.** Unchanged lines in the selection are ignored. A partly selected block is split where that's unambiguous (added lines, removed lines, or lines changed one for one); otherwise the whole block is taken, so the staged file always makes sense.
- **Deleted lines** are included when the selection covers the lines right above and below where they were.
- **Blank lines** around a staged selection come along, so you don't end up with stray blank-line changes.
- **New files** can be staged partly, too.
- **Undo and redo** follow your editing history: `Cmd+Z` undoes the last stage or unstage when that was your last action in the file, and undoes typing otherwise.
- **Unsaved edits** are staged as you see them, like VS Code's own "Stage Selected Ranges".

It only ever writes git's staging area, never your files, and it refuses to write if something else changed the staged version in the meantime.

Symlinked folders and files, submodules, worktrees, nested repositories, case-insensitive file systems and unusual file names (spaces, Unicode, `[brackets]`) are all handled.

## Not supported

Binary files, files that aren't UTF-8, files with git filters such as Git LFS, files with merge conflicts, and ignored files. The editor's **Edit → Undo** menu only undoes text; use the shortcut to undo staging.

## Colors

The highlight colors follow your theme and can be changed in `settings.json`:

```json
"workbench.colorCustomizations": {
  "chunkStage.stagedLinesBackground": "#3fb95040",
  "chunkStage.unstagedLinesBackground": "#d2992240"
}
```

## Requirements

Git on the machine where your files are (for remote windows, the remote machine), and VS Code 1.80 or newer.

## Development

```sh
npm install
npm test            # unit tests plus integration tests against real git repos
npm run package     # builds chunk-stage-<version>.vsix
npm run build:icon  # rebuilds media/chunk-stage.ttf from scripts/build-icon-font.js
```

Press `F5` in VS Code to try it in a development window.
