import * as path from 'path';
import * as vscode from 'vscode';
import { LineRange } from './diff';
import { Git } from './git';
import { StageHistory } from './history';
import { Action, Plan, formatCounts, planFor } from './plan';
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
  const status = new SelectionStatus(tracker);
  const highlight = new ChangeHighlight();
  const refreshSoon = debounce(() => void tracker.refresh(), 300);
  // Index writes and undo/redo must not interleave, e.g. when ⌘Z is held down.
  const serial = serialQueue();

  const applyToSelection = (action: Action) =>
    serial(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const doc = editor.document;
      status.showBusy(action);
      try {
        const outcome = await tracker.apply(doc, action, selectedRanges(editor), (plan) =>
          highlight.show(editor, action, plan),
        );
        switch (outcome.kind) {
          case 'done': {
            highlight.fadeSoon();
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
      } catch (err) {
        highlight.clear();
        log.error(`Failed to ${action} lines in ${doc.uri.fsPath}: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage(`Couldn't ${action} the selection: ${errorMessage(err)}`);
      } finally {
        status.refresh();
      }
    });

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
      highlight.show(editor, effect, entry);
      try {
        await tracker.replaceEntry(doc.uri, entry.location, expected, next);
        highlight.fadeSoon();
        if (direction === 'undo') {
          history.markUndone(doc);
        } else {
          history.markRedone(doc);
        }
        flash(`$(check) ${direction === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`);
      } catch (err) {
        highlight.clear();
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
    new HistoryContext(history),
    vscode.commands.registerCommand('chunkStage.stageSelection', () => applyToSelection('stage')),
    vscode.commands.registerCommand('chunkStage.unstageSelection', () => applyToSelection('unstage')),
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
    vscode.workspace.onDidCloseTextDocument((doc) => tracker.forget(doc.uri)),
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
  private readonly stageButton = new PlanButton('chunkStage.stage', 'stage', 'chunkStage.stageSelection', 102);
  private readonly unstageButton = new PlanButton('chunkStage.unstage', 'unstage', 'chunkStage.unstageSelection', 101);
  private readonly schedule = debounce(() => void this.update(), 40);
  private readonly subscriptions: vscode.Disposable[];
  private readonly contextValues = new Map<string, boolean>();
  private generation = 0;

  constructor(private readonly tracker: ChangeTracker) {
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

/** How long the highlight stays after a write has landed. */
const HIGHLIGHT_LINGER_MS = 1000;

/**
 * Tints the lines being staged (green) or unstaged (amber) the moment the
 * action starts, so the editor reacts right away even while git, the network
 * and the gutter catch up. Lines that only exist in the other version show as
 * a thin bar where they were.
 */
class ChangeHighlight implements vscode.Disposable {
  private readonly types: Record<Action, { lines: vscode.TextEditorDecorationType; above: vscode.TextEditorDecorationType; below: vscode.TextEditorDecorationType }>;
  private shown: { editor: vscode.TextEditor; action: Action } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    const typesFor = (color: vscode.ThemeColor) => ({
      lines: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: color }),
      above: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderColor: color,
        borderStyle: 'solid',
        borderWidth: '2px 0 0 0',
      }),
      below: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderColor: color,
        borderStyle: 'solid',
        borderWidth: '0 0 2px 0',
      }),
    });
    this.types = {
      stage: typesFor(new vscode.ThemeColor('chunkStage.stagedLinesBackground')),
      unstage: typesFor(new vscode.ThemeColor('chunkStage.unstagedLinesBackground')),
    };
  }

  show(editor: vscode.TextEditor, action: Action, where: { lines: LineRange[]; gaps: number[] }): void {
    this.clear();
    const lastLine = editor.document.lineCount - 1;
    const line = (n: number) => new vscode.Range(n, 0, n, 0);
    const types = this.types[action];
    editor.setDecorations(
      types.lines,
      where.lines.map((r) => new vscode.Range(r.start, 0, Math.min(r.end, lastLine), 0)),
    );
    editor.setDecorations(types.above, where.gaps.filter((gap) => gap <= lastLine).map(line));
    editor.setDecorations(types.below, where.gaps.some((gap) => gap > lastLine) ? [line(lastLine)] : []);
    this.shown = { editor, action };
  }

  fadeSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), HIGHLIGHT_LINGER_MS);
  }

  clear(): void {
    clearTimeout(this.timer);
    if (this.shown) {
      const { editor, action } = this.shown;
      Object.values(this.types[action]).forEach((type) => editor.setDecorations(type, []));
      this.shown = undefined;
    }
  }

  dispose(): void {
    this.clear();
    for (const types of Object.values(this.types)) {
      Object.values(types).forEach((type) => type.dispose());
    }
  }
}

/** A status bar button for one action; its tooltip says how many lines it would stage or unstage. */
class PlanButton implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly title: string;

  constructor(
    id: string,
    private readonly action: Action,
    command: string,
    priority: number,
  ) {
    this.title = action === 'stage' ? 'Stage selected lines' : 'Unstage selected lines';
    this.item = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
    this.item.name = this.title;
    this.item.command = command;
  }

  show(plan: Plan | undefined): void {
    if (!plan) {
      this.item.hide();
      return;
    }
    this.item.text = `${ICON} ${this.action === 'stage' ? 'Stage' : 'Unstage'}`;
    this.item.tooltip = `${this.title}: ${formatCounts(plan)}`;
    this.item.show();
  }

  showBusy(): void {
    this.item.text = `$(loading~spin) ${this.action === 'stage' ? 'Staging' : 'Unstaging'}…`;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Selected editor lines; an empty selection means the cursor's line. */
function selectedRanges(editor: vscode.TextEditor): LineRange[] {
  return editor.selections.map((selection) => {
    // A selection ending at column 0 doesn't include that line.
    const endsAtLineStart = !selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line;
    return { start: selection.start.line, end: selection.end.line - (endsAtLineStart ? 1 : 0) };
  });
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

function serialQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
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
