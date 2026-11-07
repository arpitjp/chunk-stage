import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { LineRange } from './diff';
import { BlobRef, InRepo } from './git';
import { Action } from './plan';

export interface HistoryEntry {
  location: InRepo;
  before: BlobRef | null;
  after: BlobRef | null;
  action: Action;
  /** Shown after undo/redo, e.g. "stage +3 −2". */
  label: string;
  /** Where the operation showed in the editor; still valid whenever the entry can be undone or redone. */
  lines: LineRange[];
  gaps: number[];
  /** The editor text when the operation happened: its version, length and fingerprint. */
  text: TextStamp;
}

interface TextStamp {
  version: number;
  length: number;
  hash: string;
}

const MAX_ENTRIES_PER_FILE = 100;

/**
 * Undo/redo for stage and unstage operations, interleaved with the editor's
 * own text undo.
 *
 * An operation can be undone only while the editor text is exactly what it was
 * when the operation happened: either nothing was typed since, or what was
 * typed has been undone. Otherwise undo belongs to the editor. Redo works the
 * same way, and a new text edit clears it, just like the editor's redo.
 */
export class StageHistory implements vscode.Disposable {
  private readonly undoStacks = new Map<string, HistoryEntry[]>();
  private readonly redoStacks = new Map<string, HistoryEntry[]>();
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  record(doc: vscode.TextDocument, entry: Omit<HistoryEntry, 'text'>): void {
    const stack = stackFor(this.undoStacks, doc.uri.fsPath);
    const text = doc.getText();
    stack.push({ ...entry, text: { version: doc.version, length: text.length, hash: fingerprint(text) } });
    if (stack.length > MAX_ENTRIES_PER_FILE) {
      stack.shift();
    }
    this.redoStacks.delete(doc.uri.fsPath);
    this.emitter.fire();
  }

  /** The operation undo should revert now, if undo belongs to us. */
  peekUndo(doc: vscode.TextDocument): HistoryEntry | undefined {
    return peekMatching(this.undoStacks, doc);
  }

  /** The operation redo should reapply now, if redo belongs to us. */
  peekRedo(doc: vscode.TextDocument): HistoryEntry | undefined {
    return peekMatching(this.redoStacks, doc);
  }

  markUndone(doc: vscode.TextDocument): void {
    this.move(this.undoStacks, this.redoStacks, doc.uri.fsPath);
  }

  markRedone(doc: vscode.TextDocument): void {
    this.move(this.redoStacks, this.undoStacks, doc.uri.fsPath);
  }

  /** A new text edit makes everything that was undone unreachable, as in the editor. */
  clearRedo(doc: vscode.TextDocument): void {
    if (this.redoStacks.delete(doc.uri.fsPath)) {
      this.emitter.fire();
    }
  }

  /** Forgets a file's history, e.g. after its index or HEAD changed outside this extension. */
  clear(fsPath: string): void {
    const hadUndo = this.undoStacks.delete(fsPath);
    const hadRedo = this.redoStacks.delete(fsPath);
    if (hadUndo || hadRedo) {
      this.emitter.fire();
    }
  }

  has(doc: vscode.TextDocument): boolean {
    return this.undoStacks.has(doc.uri.fsPath) || this.redoStacks.has(doc.uri.fsPath);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private move(from: Map<string, HistoryEntry[]>, to: Map<string, HistoryEntry[]>, key: string): void {
    const entry = from.get(key)?.pop();
    if (from.get(key)?.length === 0) {
      from.delete(key);
    }
    if (entry) {
      stackFor(to, key).push(entry);
    }
    this.emitter.fire();
  }
}

function stackFor(stacks: Map<string, HistoryEntry[]>, key: string): HistoryEntry[] {
  let stack = stacks.get(key);
  if (!stack) {
    stack = [];
    stacks.set(key, stack);
  }
  return stack;
}

function peekMatching(stacks: Map<string, HistoryEntry[]>, doc: vscode.TextDocument): HistoryEntry | undefined {
  const stack = stacks.get(doc.uri.fsPath);
  const top = stack?.[stack.length - 1];
  return top && sameText(top.text, doc) ? top : undefined;
}

/** Checked on every keystroke, so the full-text hash is the last resort. */
function sameText(stamp: TextStamp, doc: vscode.TextDocument): boolean {
  if (doc.version === stamp.version) {
    return true;
  }
  const text = doc.getText();
  return text.length === stamp.length && fingerprint(text) === stamp.hash;
}

function fingerprint(text: string): string {
  return createHash('sha1').update(text).digest('base64');
}
