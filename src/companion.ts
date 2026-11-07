import * as vscode from 'vscode';
import { computeFileDiff, renderPieces } from './diff';
import { ChangeHighlight, selectedRanges } from './highlight';
import { Action, Snapshot, planFor } from './plan';
import {
  ApplyRequest,
  ApplyResponse,
  COMPANION_APPLY_COMMANDS,
  COMPANION_CONTEXT_KEY,
  COMPANION_SNAPSHOT_COMMAND,
  FileSnapshot,
  MAIN_APPLY_COMMAND,
  MAIN_HELLO_COMMAND,
} from './protocol';

const MAX_FILES = 32;

interface KnownFile {
  file: FileSnapshot;
  /** Operations sent to the main extension and not answered yet; `file` already reflects them. */
  pending: number;
  /** Whether the main extension sent a newer state while operations were pending. */
  missedUpdate: boolean;
  diff: { version: number; snapshot: Snapshot } | undefined;
}

/**
 * The local half of Chunk Stage in remote windows (see protocol.ts). It plans
 * a stage or unstage from the index and HEAD versions the main extension sent
 * last, paints the highlight right away, and has the main extension do the write.
 */
export function activate(context: vscode.ExtensionContext): void {
  // In local windows the main extension runs next to the editor and needs no help.
  if (vscode.env.remoteName === undefined) {
    return;
  }
  const highlight = new ChangeHighlight();
  const files = new Map<string, KnownFile>();
  let active = false;

  const setActive = (value: boolean) => {
    if (active !== value) {
      active = value;
      void vscode.commands.executeCommand('setContext', COMPANION_CONTEXT_KEY, value);
    }
  };

  const learn = (file: FileSnapshot) => {
    const key = vscode.Uri.from(file.uri).toString();
    // While our own writes are in flight, their answers carry the newer state.
    const known = files.get(key);
    if (known && known.pending > 0) {
      known.missedUpdate = true;
      return;
    }
    files.delete(key);
    files.set(key, { file, pending: 0, missedUpdate: false, diff: undefined });
    if (files.size > MAX_FILES) {
      files.delete(files.keys().next().value!);
    }
    setActive(true);
    warm.schedule();
  };

  const snapshotOf = (known: KnownFile, doc: vscode.TextDocument): Snapshot => {
    if (known.diff?.version !== doc.version) {
      const { state, bom, indexText, headText } = known.file;
      known.diff = {
        version: doc.version,
        snapshot: {
          state,
          bom,
          version: doc.version,
          unstaged: computeFileDiff(indexText, doc.getText()),
          staged: headText === undefined ? undefined : computeFileDiff(indexText, headText),
        },
      };
    }
    return known.diff.snapshot;
  };

  /** Diffs the active file ahead of time, so a keypress only has to pick lines. */
  const warm = idle(() => {
    const doc = vscode.window.activeTextEditor?.document;
    const known = doc && files.get(doc.uri.toString());
    if (doc && known) {
      snapshotOf(known, doc);
    }
  });

  const apply = async (action: Action) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const ranges = selectedRanges(editor);
    const known = files.get(doc.uri.toString());
    const plan = known && planFor(snapshotOf(known, doc), action, ranges);
    const lit = plan && highlight.show(editor, action, plan);
    if (known && plan) {
      // Plan the next keypress against the index as it will be, not as it was.
      known.file = { ...known.file, indexText: renderPieces(plan.diff, plan.pieces) };
      known.diff = undefined;
      known.pending++;
    }
    const request: ApplyRequest = { uri: doc.uri, action, ranges, painted: lit !== undefined };
    let response: ApplyResponse | undefined;
    try {
      response = await vscode.commands.executeCommand<ApplyResponse>(MAIN_APPLY_COMMAND, request);
    } catch {
      // The main extension is gone; let its own shortcuts take over again.
      setActive(false);
    } finally {
      if (known && plan) {
        known.pending--;
      }
    }
    if (response?.outcome === 'done') {
      lit?.fade();
    } else {
      lit?.clear();
    }
    if (!known || !plan) {
      if (response?.snapshot) {
        learn(response.snapshot);
      }
      return;
    }
    if (known.pending > 0) {
      return;
    }
    if (response?.snapshot && !known.missedUpdate) {
      learn(response.snapshot);
    } else {
      // Our guess may be off, or something else changed the file meanwhile; ask for the real state.
      files.delete(doc.uri.toString());
      void hello();
    }
  };

  const hello = () =>
    Promise.resolve(vscode.commands.executeCommand<boolean>(MAIN_HELLO_COMMAND)).then(
      (ok) => setActive(ok === true),
      () => undefined,
    );

  context.subscriptions.push(
    highlight,
    warm,
    vscode.commands.registerCommand(COMPANION_SNAPSHOT_COMMAND, learn),
    vscode.commands.registerCommand(COMPANION_APPLY_COMMANDS.stage, () => apply('stage')),
    vscode.commands.registerCommand(COMPANION_APPLY_COMMANDS.unstage, () => apply('unstage')),
    vscode.window.onDidChangeActiveTextEditor(() => warm.schedule()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        warm.schedule();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => files.delete(doc.uri.toString())),
    { dispose: () => setActive(false) },
  );
  // The main extension may have started first; tell it we're here.
  void hello();
}

export function deactivate(): void {}

/** Runs `fn` once things have been quiet for a moment. */
function idle(fn: () => void, ms = 80): { schedule(): void; dispose(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    schedule: () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    },
    dispose: () => clearTimeout(timer),
  };
}
