/**
 * How the main extension and its companion talk. In a remote window the main
 * extension runs on the remote machine, next to git, and the companion runs
 * locally, next to the editor. Every call between them crosses the network, so
 * the companion keeps what it needs to plan a stage or unstage on its own and
 * paints the highlight without waiting for the remote side.
 *
 * They talk through commands, which work across extension hosts; URIs passed
 * as `vscode.Uri` are translated between the remote and local spelling.
 */
import type * as vscode from 'vscode';
import { LineRange } from './diff';
import { Action } from './plan';
import { StageableState } from './git';

/** Registered by the companion. Takes a `FileSnapshot`. */
export const COMPANION_SNAPSHOT_COMMAND = 'chunkStage.companion.snapshot';
/** Registered by the companion: stage/unstage the active selection, painting the highlight locally. */
export const COMPANION_APPLY_COMMANDS: Record<Action, string> = {
  stage: 'chunkStage.companion.stageSelection',
  unstage: 'chunkStage.companion.unstageSelection',
};
/** Registered by the main extension. Takes nothing; returns true. The companion calls it when it starts. */
export const MAIN_HELLO_COMMAND = 'chunkStage.main.hello';
/** Registered by the main extension. Takes `ApplyRequest`, returns `ApplyResponse`. */
export const MAIN_APPLY_COMMAND = 'chunkStage.main.apply';
/** Context key set by the companion while it handles the shortcuts and status bar buttons. */
export const COMPANION_CONTEXT_KEY = 'chunkStage.companion';

/** What the companion needs to plan stage/unstage for one file against the live editor text. */
export interface FileSnapshot {
  uri: vscode.Uri;
  state: StageableState;
  bom: boolean;
  indexText: string;
  /** Missing for untracked files or unreadable HEAD versions; see `Snapshot.staged`. */
  headText: string | undefined;
}

export interface ApplyRequest {
  uri: vscode.Uri;
  action: Action;
  ranges: LineRange[];
  /** Whether the companion already shows the highlight, so the main extension shouldn't. */
  painted: boolean;
}

export interface ApplyResponse {
  outcome: 'done' | 'nothing' | 'unavailable' | 'failed';
  /** The file after the operation, when it can be staged. */
  snapshot: FileSnapshot | undefined;
}
