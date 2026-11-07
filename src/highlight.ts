import * as vscode from 'vscode';
import { HIGHLIGHT_COLORS, Rgba, ThemeKey, parseColor } from './colors';
import { LineRange } from './diff';
import { Action } from './plan';

/** How long the highlight stays after a write has landed. */
const LINGER_MS = 700;
/** How much stronger the accent bar on the left is than the background tint. */
const ACCENT_GAIN = 4;

type HighlightPart = 'lines' | 'above' | 'below';

/** A highlight on some lines of one editor; see `ChangeHighlight.show`. */
export interface Flash {
  /** Removes the highlight shortly, once the change has landed. */
  fade(): void;
  /** Removes the highlight right away. */
  clear(): void;
}

class FlashState implements Flash {
  ranges: Record<HighlightPart, vscode.Range[]> = { lines: [], above: [], below: [] };
  /** Editor lines covered, for spotting overlapping flashes. */
  span: LineRange[] = [];
  revision = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: number,
    readonly editor: vscode.TextEditor,
    readonly action: Action,
    private readonly owner: ChangeHighlight,
  ) {}

  fade(): void {
    this.timer ??= setTimeout(() => this.clear(), LINGER_MS);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.owner.remove(this);
  }
}

/**
 * Tints the lines being staged (green) or unstaged (red) the moment the
 * action starts, so the editor reacts right away even while git, the network
 * and the gutter catch up. Lines that only exist in the other version show as
 * a thin bar where they were. Several flashes can be on screen at once, e.g.
 * when staging hunk after hunk in quick succession.
 */
export class ChangeHighlight implements vscode.Disposable {
  private readonly flashes = new Set<FlashState>();
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  /** Per editor, the decoration types currently set and which flashes they show. */
  private readonly applied = new Map<vscode.TextEditor, Map<string, string>>();
  private readonly subscriptions: vscode.Disposable[];
  private colors: Record<Action, Rgba>;
  private nextId = 0;

  constructor() {
    this.colors = this.resolveColors();
    const restyle = () => {
      this.colors = this.resolveColors();
      this.disposeTypes();
      this.render();
    };
    this.subscriptions = [
      vscode.window.onDidChangeActiveColorTheme(restyle),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.colorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) {
          restyle();
        }
      }),
    ];
  }

  /**
   * Highlights `where` in `editor`. Passing the flash already shown for the
   * same operation moves it to `where` instead of adding another.
   */
  show(editor: vscode.TextEditor, action: Action, where: { lines: LineRange[]; gaps: number[] }, replacing?: Flash): Flash {
    let flash = replacing instanceof FlashState && this.flashes.has(replacing) ? replacing : undefined;
    if (!flash) {
      flash = new FlashState(this.nextId++, editor, action, this);
      this.flashes.add(flash);
    }
    const lastLine = editor.document.lineCount - 1;
    const line = (n: number) => new vscode.Range(n, 0, n, 0);
    flash.ranges = {
      lines: where.lines.map((r) => new vscode.Range(r.start, 0, Math.min(r.end, lastLine), 0)),
      above: where.gaps.filter((gap) => gap <= lastLine).map(line),
      below: where.gaps.some((gap) => gap > lastLine) ? [line(lastLine)] : [],
    };
    flash.span = [...where.lines, ...where.gaps.map((gap) => ({ start: gap, end: gap }))];
    flash.revision++;
    // An older flash under the same lines would blend colors with this one.
    for (const other of this.flashes) {
      if (other !== flash && other.editor === editor && overlaps(other.span, flash.span)) {
        this.flashes.delete(other);
      }
    }
    this.render();
    return flash;
  }

  remove(flash: FlashState): void {
    if (this.flashes.delete(flash)) {
      this.render();
    }
  }

  dispose(): void {
    this.flashes.forEach((flash) => flash.clear());
    this.subscriptions.forEach((s) => s.dispose());
    this.disposeTypes();
  }

  /** Sends only the decoration types whose ranges changed; over remote connections each one is a round trip. */
  private render(): void {
    const wanted = new Map<vscode.TextEditor, Map<string, FlashState[]>>();
    for (const flash of this.flashes) {
      const byType = wanted.get(flash.editor) ?? new Map<string, FlashState[]>();
      wanted.set(flash.editor, byType);
      for (const part of ['lines', 'above', 'below'] as const) {
        if (flash.ranges[part].length > 0) {
          const key = `${flash.action}:${part}`;
          byType.set(key, [...(byType.get(key) ?? []), flash]);
        }
      }
    }

    for (const editor of new Set([...this.applied.keys(), ...wanted.keys()])) {
      const before = this.applied.get(editor) ?? new Map<string, string>();
      const after = new Map<string, string>();
      for (const [key, flashes] of wanted.get(editor) ?? []) {
        const signature = flashes.map((f) => `${f.id}.${f.revision}`).join(',');
        after.set(key, signature);
        if (before.get(key) !== signature) {
          const part = key.slice(key.lastIndexOf(':') + 1) as HighlightPart;
          editor.setDecorations(this.typeFor(key), flashes.flatMap((f) => f.ranges[part]));
        }
      }
      for (const key of before.keys()) {
        if (!after.has(key)) {
          editor.setDecorations(this.typeFor(key), []);
        }
      }
      if (after.size > 0) {
        this.applied.set(editor, after);
      } else {
        this.applied.delete(editor);
      }
    }
  }

  private typeFor(key: string): vscode.TextEditorDecorationType {
    let type = this.types.get(key);
    if (!type) {
      const [action, part] = key.split(':') as [Action, HighlightPart];
      const { r, g, b, a } = this.colors[action];
      const tint = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      const accent = `rgba(${r}, ${g}, ${b}, ${Math.min(1, a * ACCENT_GAIN).toFixed(3)})`;
      const bar = (width: string): vscode.DecorationRenderOptions => ({
        isWholeLine: true,
        borderColor: accent,
        borderStyle: 'solid',
        borderWidth: width,
      });
      type = vscode.window.createTextEditorDecorationType(
        part === 'lines' ? { ...bar('0 0 0 2px'), backgroundColor: tint } : bar(part === 'above' ? '2px 0 0 0' : '0 0 2px 0'),
      );
      this.types.set(key, type);
    }
    return type;
  }

  private disposeTypes(): void {
    this.types.forEach((type) => type.dispose());
    this.types.clear();
    this.applied.clear();
  }

  /** The highlight colors for the current theme, honoring `workbench.colorCustomizations`. */
  private resolveColors(): Record<Action, Rgba> {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const customizations = workbench.get<Record<string, unknown>>('colorCustomizations') ?? {};
    const forTheme = customizations[`[${workbench.get<string>('colorTheme')}]`];
    const themeKey = themeKeyOf(vscode.window.activeColorTheme.kind);
    const resolve = (action: Action): Rgba => {
      const { id, defaults } = HIGHLIGHT_COLORS[action];
      const themed = typeof forTheme === 'object' && forTheme !== null ? (forTheme as Record<string, unknown>)[id] : undefined;
      return parseColor(themed) ?? parseColor(customizations[id]) ?? parseColor(defaults[themeKey]) ?? parseColor(defaults.dark)!;
    };
    return { stage: resolve('stage'), unstage: resolve('unstage') };
  }
}

function themeKeyOf(kind: vscode.ColorThemeKind): ThemeKey {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'highContrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'highContrastLight';
    default:
      return 'dark';
  }
}

function overlaps(a: LineRange[], b: LineRange[]): boolean {
  return a.some((x) => b.some((y) => x.start <= y.end && y.start <= x.end));
}

/** Selected editor lines; an empty selection means the cursor's line. */
export function selectedRanges(editor: vscode.TextEditor): LineRange[] {
  return editor.selections.map((selection) => {
    // A selection ending at column 0 doesn't include that line.
    const endsAtLineStart = !selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line;
    return { start: selection.start.line, end: selection.end.line - (endsAtLineStart ? 1 : 0) };
  });
}
