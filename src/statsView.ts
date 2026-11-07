import * as vscode from 'vscode';
import { renderStatsHtml } from './statsHtml';
import { StatKind, Stats, recordOp, summarize } from './stats';

const STATS_KEY = 'chunkStage.stats';

/** Usage stats, kept in global state so every window and workspace adds to the same totals. */
export class StatsStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  get(): Stats | undefined {
    return this.state.get<Stats>(STATS_KEY);
  }

  record(kind: StatKind, lines: number): void {
    void Promise.resolve(this.state.update(STATS_KEY, recordOp(this.get(), kind, lines, new Date()))).then(() =>
      this.emitter.fire(),
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** The "Chunk: Show Stats" page; a single panel that redraws as you stage. */
export class StatsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: StatsStore) {
    this.subscription = store.onDidChange(() => this.render());
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('chunkStage.stats', 'Chunk Stage Stats', vscode.ViewColumn.Active, {
      enableScripts: false,
    });
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.render();
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }

  private render(): void {
    if (this.panel) {
      const stats = this.store.get();
      this.panel.webview.html = renderStatsHtml(stats, summarize(stats, new Date()));
    }
  }
}
