import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { computeFileDiff } from '../diff';
import { Git, IndexTransition, StageableState } from '../git';
import { Action, Snapshot, indexContent, planFor } from '../plan';

export const git = new Git('git');

export const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');

/** Runs git in `cwd` without hooks, signing or the file-protocol guard (for local submodules). */
export function gitIn(cwd: string, ...args: string[]): string {
  const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always'];
  return execFileSync('git', [...config, ...args], { cwd, encoding: 'utf8' });
}

/** Builds the same snapshot the extension does, from git and the given editor text. */
export async function snapshotOf(file: string, working: string): Promise<Snapshot> {
  const state = await git.fileState(file);
  assert.ok(state.kind === 'tracked' || state.kind === 'untracked', `unexpected state ${state.kind}`);
  if (state.kind === 'untracked') {
    return { state, version: 1, bom: false, unstaged: computeFileDiff('', working), staged: undefined };
  }
  const index = (await git.readBlob(state.root, state.sha)).toString('utf8');
  const head = state.head ? (await git.readBlob(state.root, state.head.sha)).toString('utf8') : '';
  return { state, version: 1, bom: false, unstaged: computeFileDiff(index, working), staged: computeFileDiff(index, head) };
}

/** Stages or unstages editor lines `start..end`, like the extension's commands. */
export async function applyLines(
  file: string,
  working: string,
  action: Action,
  start: number,
  end: number,
): Promise<{ state: StageableState; transition: IndexTransition }> {
  const snapshot = await snapshotOf(file, working);
  const plan = planFor(snapshot, action, [{ start, end }]);
  assert.ok(plan, `nothing to ${action}`);
  const transition = await git.writeIndex(snapshot.state, indexContent(snapshot, plan)?.bytes ?? null);
  return { state: snapshot.state, transition };
}
