import * as path from 'path';
import * as vscode from 'vscode';
import { LineRange } from './diff';
import { Git } from './git';
import { ChangeHighlight, Flash, selectedRanges } from './highlight';
import { StageHistory } from './history';
import { StatsPanel, StatsStore } from './statsView';
import { Action, Plan, Snapshot, formatCounts, planFor } from './plan';
import {
  ApplyRequest,
  ApplyResponse,
  COMPANION_APPLY_COMMANDS,
  COMPANION_SNAPSHOT_COMMAND,
  FileSnapshot,
  MAIN_APPLY_COMMAND,
  MAIN_HELLO_COMMAND,
} from './protocol';
import { ChangeTracker, GitExtensionBridge, errorMessage } from './tracker';

/** The parts of the built-in git extension API (`vscode.git`) used here. */
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}
interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
  status(): Promise<void>;
}

type Debounced = ((delayMs?: number) => void) & { cancel(): void };

/** Contributed in package.json from media/chunk-stage.ttf. */
const ICON = '$(chunk-stage)';

/** The git extension's command behind the diff editor's "Stage" hunk action: stages the given text. */
const GIT_STAGE_TEXT_COMMAND = 'git.diff.stageSelection';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Chunk Stage', { log: true });
  const gitApi = await getGitApi(log);
  const bridge = gitApi && (await createBridge(gitApi, log));
  const tracker = new ChangeTracker(new Git(gitApi?.git.path ?? configuredGitPath()), log, bridge);
  const history = new StageHistory();
  const stats = new StatsStore(context.globalState);
  const statsPanel = new StatsPanel(stats);
  const companion = await CompanionLink.connect();
  const status = new SelectionStatus(tracker, companion);
  const highlight = new ChangeHighlight();
  const refreshSoon = debounce(() => void tracker.refresh(), 300);
  // Index writes and undo/redo must not interleave, e.g. when ⌘Z is held down.
  const serial = serialQueue();

  /** Stages or unstages the active editor's selection, or what the companion asks for. */
  const applyToSelection = (action: Action, request?: ApplyRequest): Promise<ApplyResponse['outcome']> => {
    const doc = request ? documentFor(request.uri) : vscode.window.activeTextEditor?.document;
    if (!doc) {
      return Promise.resolve('unavailable');
    }
    const editor = editorFor(doc);
    const ranges = request?.ranges ?? (editor ? selectedRanges(editor) : []);
    const paint = (where: { lines: LineRange[]; gaps: number[] }, replacing?: Flash) =>
      editor && !request?.painted ? highlight.show(editor, action, where, replacing) : undefined;
    // Painted before anything is awaited, so the lines light up on the keypress itself.
    const preview = tracker.peekPlan(doc, action, ranges);
    let lit = preview && paint(preview);
    status.showBusy(action);
    return serial(async (): Promise<ApplyResponse['outcome']> => {
      try {
        const outcome = await tracker.apply(doc, action, ranges, (plan) => {
          lit = paint(plan, lit);
        });
        if (outcome.kind !== 'done') {
          lit?.clear();
        }
        switch (outcome.kind) {
          case 'done': {
            lit?.fade();
            const { plan, location, transition } = outcome;
            const counts = formatCounts(plan);
            history.record(doc, {
              location,
              ...transition,
              action,
              label: `${action} ${counts}`,
              lines: plan.lines,
              gaps: plan.gaps,
            });
            stats.record(action, plan.added + plan.removed);
            flash(`$(check) ${action === 'stage' ? 'Staged' : 'Unstaged'} ${counts}`);
            break;
          }
          case 'nothing':
            flash(`No ${action === 'stage' ? 'unstaged' : 'staged'} changes in the selection.`);
            break;
          case 'unavailable':
            void vscode.window.showInformationMessage(outcome.reason);
            break;
        }
        return outcome.kind;
      } catch (err) {
        lit?.clear();
        log.error(`Failed to ${action} lines in ${doc.uri.fsPath}: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage(`Couldn't ${action} the selection: ${errorMessage(err)}`);
        return 'failed';
      } finally {
        status.refresh();
      }
    });
  };

  const applyForCompanion = async (request: ApplyRequest): Promise<ApplyResponse> => {
    const outcome = await applyToSelection(request.action, request);
    const doc = documentFor(request.uri);
    const after = doc && (await tracker.getDiff(doc).catch(() => undefined));
    return { outcome, snapshot: doc && after?.ok ? toFileSnapshot(doc.uri, after) : undefined };
  };

  const travel = (direction: 'undo' | 'redo') =>
    serial(async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      const entry = doc && (direction === 'undo' ? history.peekUndo(doc) : history.peekRedo(doc));
      if (!editor || !doc || !entry) {
        await vscode.commands.executeCommand(direction);
        return;
      }
      const [expected, next] = direction === 'undo' ? [entry.after, entry.before] : [entry.before, entry.after];
      const effect: Action = direction === 'redo' ? entry.action : entry.action === 'stage' ? 'unstage' : 'stage';
      const lit = highlight.show(editor, effect, entry);
      try {
        await tracker.replaceEntry(doc.uri, entry.location, expected, next);
        lit.fade();
        if (direction === 'undo') {
          history.markUndone(doc);
        } else {
          history.markRedone(doc);
        }
        stats.record('undo', 0);
        flash(`$(check) ${direction === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`);
      } catch (err) {
        lit.clear();
        history.clear(doc.uri.fsPath);
        log.warn(`Failed to ${direction} ${entry.label} in ${doc.uri.fsPath}: ${errorMessage(err)}`);
        void vscode.window.showWarningMessage(`Couldn't ${direction} ${entry.label}: ${errorMessage(err)}`);
      }
    });

  context.subscriptions.push(
    log,
    tracker,
    history,
    status,
    highlight,
    companion,
    new HistoryContext(history),
    stats,
    statsPanel,
    vscode.commands.registerCommand('chunkStage.showStats', () => statsPanel.show()),
    vscode.commands.registerCommand('chunkStage.stageSelection', () => applyToSelection('stage')),
    vscode.commands.registerCommand('chunkStage.unstageSelection', () => applyToSelection('unstage')),
    vscode.commands.registerCommand(MAIN_APPLY_COMMAND, applyForCompanion),
    vscode.commands.registerCommand(MAIN_HELLO_COMMAND, () => {
      companion.connected();
      status.refresh();
      return true;
    }),
    vscode.commands.registerCommand('chunkStage.undo', () => travel('undo')),
    vscode.commands.registerCommand('chunkStage.redo', () => travel('redo')),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.reason === undefined && e.contentChanges.length > 0) {
        history.clearRedo(e.document);
      }
    }),
    tracker.onDidChangeExternally((fsPath) => history.clear(fsPath)),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        refreshSoon();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      tracker.forget(doc.uri);
      // Like the editor's own undo; a reopened document also restarts its version numbers.
      history.clear(doc.uri.fsPath);
    }),
    { dispose: () => refreshSoon.cancel() },
  );
  if (gitApi) {
    context.subscriptions.push(watchRepositories(gitApi, refreshSoon));
  }
}

export function deactivate(): void {}

/**
 * Status bar buttons previewing what staging or unstaging the selection would
 * do, plus the `chunkStage.hasUnstaged` / `chunkStage.hasStaged` context keys
 * for the active file.
 */
class SelectionStatus implements vscode.Disposable {
  private readonly stageButton: PlanButton;
  private readonly unstageButton: PlanButton;
  private readonly schedule = debounce(() => void this.update(), 40);
  private readonly subscriptions: vscode.Disposable[];
  private readonly contextValues = new Map<string, boolean>();
  private generation = 0;

  constructor(
    private readonly tracker: ChangeTracker,
    private readonly companion: CompanionLink,
  ) {
    // Clicks go through the companion when it's there, so it can paint the highlight locally.
    const command = (action: Action, main: string) => () => (companion.active ? COMPANION_APPLY_COMMANDS[action] : main);
    this.stageButton = new PlanButton('chunkStage.stage', 'stage', command('stage', 'chunkStage.stageSelection'), 102);
    this.unstageButton = new PlanButton('chunkStage.unstage', 'unstage', command('unstage', 'chunkStage.unstageSelection'), 101);
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.schedule();
        }
      }),
      tracker.onDidChange(() => this.schedule(0)),
    ];
    this.schedule(0);
  }

  /** Immediate feedback on the clicked button while git works. */
  showBusy(action: Action): void {
    (action === 'stage' ? this.stageButton : this.unstageButton).showBusy();
  }

  refresh(): void {
    this.schedule(0);
  }

  dispose(): void {
    this.schedule.cancel();
    this.subscriptions.forEach((s) => s.dispose());
    this.stageButton.dispose();
    this.unstageButton.dispose();
  }

  private async update(): Promise<void> {
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    let stage: Plan | undefined;
    let unstage: Plan | undefined;
    let hasUnstaged = false;
    let hasStaged = false;
    if (editor) {
      const result = await this.tracker.getDiff(editor.document).catch(() => undefined);
      // A newer update is already on its way when the editor changed meanwhile.
      if (generation !== this.generation || editor !== vscode.window.activeTextEditor) {
        return;
      }
      if (result?.ok) {
        if (result.version !== editor.document.version) {
          return;
        }
        this.companion.send(editor.document.uri, result);
        const ranges = selectedRanges(editor);
        hasUnstaged = result.unstaged.changes.length > 0;
        hasStaged = (result.staged?.changes.length ?? 0) > 0;
        stage = hasUnstaged ? planFor(result, 'stage', ranges) : undefined;
        unstage = hasStaged ? planFor(result, 'unstage', ranges) : undefined;
      }
    }
    this.stageButton.show(stage);
    this.unstageButton.show(unstage);
    this.setContext('chunkStage.hasUnstaged', hasUnstaged);
    this.setContext('chunkStage.hasStaged', hasStaged);
  }

  private setContext(key: string, value: boolean): void {
    if (this.contextValues.get(key) !== value) {
      this.contextValues.set(key, value);
      void vscode.commands.executeCommand('setContext', key, value);
    }
  }
}

/** Maintains `chunkStage.canUndo` / `chunkStage.canRedo`, which route ⌘Z / ⌘⇧Z to stage history. */
class HistoryContext implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly values = new Map<string, boolean>();

  constructor(private readonly history: StageHistory) {
    // Updated synchronously: holding ⌘Z must switch between text undo and stage undo at the right step.
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.update();
        }
      }),
      history.onDidChange(() => this.update()),
    ];
    this.update();
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }

  private update(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const known = doc !== undefined && this.history.has(doc);
    this.set('chunkStage.canUndo', known && this.history.peekUndo(doc) !== undefined);
    this.set('chunkStage.canRedo', known && this.history.peekRedo(doc) !== undefined);
  }

  private set(key: string, value: boolean): void {
    if (this.values.get(key) !== value) {
      this.values.set(key, value);
      void vscode.commands.executeCommand('setContext', key, value);
    }
  }
}

/**
 * The main extension's end of the link to the companion (see protocol.ts):
 * keeps it supplied with the active file's index and HEAD versions.
 */
class CompanionLink implements vscode.Disposable {
  private lastSent: string | undefined;

  private constructor(public active: boolean) {}

  static async connect(): Promise<CompanionLink> {
    // Only remote windows need it; locally this extension already runs next to the editor.
    const found = isRemote() && (await vscode.commands.getCommands(true)).includes(COMPANION_SNAPSHOT_COMMAND);
    return new CompanionLink(found);
  }

  /** The companion started after this extension did. */
  connected(): void {
    this.active = isRemote();
    this.lastSent = undefined;
  }

  send(uri: vscode.Uri, snapshot: Snapshot): void {
    if (!this.active) {
      return;
    }
    const key = [uri.toString(), JSON.stringify(snapshot.state), snapshot.bom, snapshot.staged !== undefined].join('\0');
    if (key === this.lastSent) {
      return;
    }
    this.lastSent = key;
    vscode.commands.executeCommand(COMPANION_SNAPSHOT_COMMAND, toFileSnapshot(uri, snapshot)).then(undefined, async () => {
      // Resend next time; give up on the companion only if it's really gone.
      this.lastSent = undefined;
      this.active = (await vscode.commands.getCommands(true)).includes(COMPANION_SNAPSHOT_COMMAND);
    });
  }

  dispose(): void {}
}

function toFileSnapshot(uri: vscode.Uri, { state, bom, unstaged, staged }: Snapshot): FileSnapshot {
  return { uri, state, bom, indexText: unstaged.oldLines.join(''), headText: staged?.newLines.join('') };
}

function isRemote(): boolean {
  return vscode.env.remoteName !== undefined;
}

function documentFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = vscode.Uri.from(uri).toString();
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
}

function editorFor(doc: vscode.TextDocument): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  return active?.document === doc ? active : vscode.window.visibleTextEditors.find((e) => e.document === doc);
}

/** A status bar button for one action, saying how many lines it would stage or unstage. */
class PlanButton implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(
    id: string,
    private readonly action: Action,
    private readonly command: () => string,
    priority: number,
  ) {
    this.item = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
    this.item.name = action === 'stage' ? 'Stage selected lines' : 'Unstage selected lines';
  }

  show(plan: Plan | undefined): void {
    if (!plan) {
      this.item.hide();
      return;
    }
    this.item.command = this.command();
    this.item.text = `${ICON} ${this.action === 'stage' ? 'Stage' : 'Unstage'} ${formatCounts(plan)}`;
    this.item.show();
  }

  showBusy(): void {
    this.item.text = `$(loading~spin) ${this.action === 'stage' ? 'Staging' : 'Unstaging'}…`;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function flash(message: string): void {
  vscode.window.setStatusBarMessage(message, 3000);
}

async function getGitApi(log: vscode.LogOutputChannel): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.enabled ? exports.getAPI(1) : undefined;
  } catch (err) {
    log.warn(`Built-in git extension unavailable: ${errorMessage(err)}`);
    return undefined;
  }
}

async function createBridge(gitApi: GitApi, log: vscode.LogOutputChannel): Promise<GitExtensionBridge> {
  const canStageText = (await vscode.commands.getCommands(true)).includes(GIT_STAGE_TEXT_COMMAND);
  if (!canStageText) {
    log.info(`${GIT_STAGE_TEXT_COMMAND} is unavailable; the gutter will update on the git extension's schedule.`);
  }
  return {
    // Relative to the git extension's root, which keeps the workspace's spelling of symlinked folders.
    relativePath: (uri) => {
      const repository = canStageText ? gitApi.getRepository(uri) : null;
      if (!repository) {
        return undefined;
      }
      const relative = path.relative(repository.rootUri.fsPath, uri.fsPath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative.split(path.sep).join('/')
        : undefined;
    },
    stage: (uri, text) =>
      vscode.commands.executeCommand(GIT_STAGE_TEXT_COMMAND, { modifiedUri: uri, originalWithModifiedChanges: text }),
    // The git extension waits ~1 s after noticing an index change and then holds
    // off further refreshes for 5 s; asking directly makes its views catch up now.
    refresh: (uri) => {
      gitApi
        .getRepository(uri)
        ?.status()
        .catch((err: unknown) => log.warn(`git status refresh failed: ${errorMessage(err)}`));
    },
  };
}

function configuredGitPath(): string {
  const setting = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  const first = Array.isArray(setting) ? setting[0] : setting;
  return first || 'git';
}

/** Calls `onChange` whenever any repository's status changes (index, HEAD, files). */
function watchRepositories(api: GitApi, onChange: () => void): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [];
  const watch = (repository: GitRepository): void => {
    subscriptions.push(repository.state.onDidChange(onChange));
  };
  api.repositories.forEach(watch);
  subscriptions.push(api.onDidOpenRepository(watch));
  return { dispose: () => subscriptions.forEach((s) => s.dispose()) };
}

function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

function debounce(fn: () => void, ms: number): Debounced {
  let timer: NodeJS.Timeout | undefined;
  const run = (delayMs = ms): void => {
    clearTimeout(timer);
    timer = setTimeout(fn, delayMs);
  };
  return Object.assign(run, { cancel: () => clearTimeout(timer) });
}
