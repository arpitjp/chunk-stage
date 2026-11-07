/**
 * The stats page as static HTML: no scripts, styled with the editor theme's
 * colors. Independent of VS Code, so it renders the same anywhere.
 */
import { DayEntry, Stats, Summary, linesOf } from './stats';

export function renderStatsHtml(stats: Stats | undefined, summary: Summary): string {
  const body = stats
    ? `
      <section class="cards">
        ${card(n(stats.linesStaged), 'lines staged', `${n(stats.linesUnstaged)} unstaged`, split(stats.linesStaged, stats.linesUnstaged))}
        ${card(n(stats.stages + stats.unstages), 'operations', [plural(stats.stages, 'stage'), plural(stats.unstages, 'unstage'), plural(stats.undos, 'undo')].join(' · '))}
        ${card(plural(summary.streak, 'day'), 'current streak', summary.streak > 0 ? 'Keep it going.' : 'Stage something to start one.')}
        ${card(n(linesOf(summary.today)), 'lines today', todayNote(summary))}
      </section>
      <section>
        <div class="heading"><h2>Last 30 days</h2>${legend()}</div>
        ${flowChart(summary.history.slice(-30))}
      </section>
      <section>
        <h2>Last 13 weeks</h2>
        ${heatMap(summary.history)}
        <p class="footer">${summary.bestDay ? `Best day: ${n(summary.bestDay.lines)} lines on ${formatDay(summary.bestDay.day)}. ` : ''}Counting since ${formatDay(stats.since)}.</p>
      </section>`
    : `<p class="muted">Nothing yet. Select some changed lines and press <kbd>Ctrl+Shift+S</kbd> to stage them; your stats show up here.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${STYLE}</style>
</head>
<body>
<h1>Chunk Stage</h1>
${body}
</body>
</html>`;
}

const STYLE = `
  :root { --stage: var(--vscode-charts-green, #3fb950); --unstage: var(--vscode-charts-red, #f85149); --muted: var(--vscode-descriptionForeground); --border: var(--vscode-widget-border, var(--vscode-panel-border, #8884)); }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 32px; max-width: 880px; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 20px; }
  h2 { font-size: 1em; font-weight: 600; margin: 0; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  section + section { margin-top: 32px; }
  section > h2, .heading { margin-bottom: 12px; }
  .heading { display: flex; justify-content: space-between; align-items: baseline; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; background: var(--vscode-editorWidget-background); }
  .value { font-size: 2em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .label, .note, .muted, .footer { color: var(--muted); }
  .label { margin-top: 2px; }
  .note { margin-top: 10px; font-size: .9em; }
  .split { display: flex; height: 4px; margin-top: 12px; border-radius: 2px; overflow: hidden; gap: 2px; }
  .split .s { background: var(--stage); } .split .u { background: var(--unstage); }
  .legend { display: flex; gap: 14px; font-size: .9em; color: var(--muted); }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .area.stage { fill: url(#fade-stage); } .area.unstage { fill: url(#fade-unstage); }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line.stage, .dot.stage { stroke: var(--stage); } .line.unstage, .dot.unstage { stroke: var(--unstage); }
  .dot { fill: var(--vscode-editor-background, #1e1e1e); stroke-width: 2; }
  .stop-stage { stop-color: var(--stage); } .stop-unstage { stop-color: var(--unstage); }
  .baseline { stroke: var(--border); }
  .hit { fill: transparent; } .hit:hover { fill: var(--vscode-foreground); fill-opacity: .06; }
  .axis { fill: var(--muted); font-size: 10px; }
  .flow .axis { font-size: 13px; }
  .cell { fill: var(--border); fill-opacity: .35; }
  .cell.stage { fill: var(--stage); } .cell.unstage { fill: var(--unstage); }
  .cell.l1 { fill-opacity: .3; } .cell.l2 { fill-opacity: .5; } .cell.l3 { fill-opacity: .75; } .cell.l4 { fill-opacity: 1; }
  .cell.today { stroke: var(--vscode-foreground); stroke-width: 1.5; }
  .footer { margin-top: 12px; }
  kbd { font-family: var(--vscode-editor-font-family); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
`;

function card(value: string, label: string, note = '', extra = ''): string {
  return `<div class="card"><div class="value">${value}</div><div class="label">${label}</div>${note ? `<div class="note">${note}</div>` : ''}${extra}</div>`;
}

/** A thin bar showing staged against unstaged lines. */
function split(staged: number, unstaged: number): string {
  if (staged + unstaged === 0) {
    return '';
  }
  return `<div class="split"><div class="s" style="flex: ${staged}"></div><div class="u" style="flex: ${unstaged}"></div></div>`;
}

function legend(): string {
  return `<div class="legend"><span><i style="background: var(--stage)"></i>staged</span><span><i style="background: var(--unstage)"></i>unstaged</span></div>`;
}

function todayNote({ today, typicalDay }: Summary): string {
  if (typicalDay.lines === 0) {
    return plural(today.ops, 'operation');
  }
  const usual = `${n(typicalDay.lines)} lines`;
  return linesOf(today) >= typicalDay.lines ? `Ahead of your usual ${usual}.` : `Your usual day: ${usual}.`;
}

/**
 * Staged lines flow above the baseline and unstaged lines mirror them below,
 * as smooth shaded curves; each day can be hovered for its numbers.
 */
function flowChart(days: DayEntry[]): string {
  const width = 820;
  const height = 180;
  const pad = 14;
  const peakStaged = Math.max(1, ...days.map((d) => d.staged));
  const peakUnstaged = Math.max(...days.map((d) => d.unstaged));
  const below = Math.max(peakUnstaged, peakStaged / 4);
  const scale = (height - 2 * pad) / (peakStaged + below);
  const mid = pad + peakStaged * scale;
  const x = (i: number) => (i / (days.length - 1)) * width;
  const curve = (sign: number, pick: (d: DayEntry) => number) =>
    smoothPath(days.map((d, i): [number, number] => [x(i), mid - sign * pick(d) * scale]));
  const area = (path: string) => `${path} L${width},${mid} L0,${mid} Z`;
  const up = curve(1, (d) => d.staged);
  const down = curve(-1, (d) => d.unstaged);

  const today = days[days.length - 1];
  const dot = (value: number, sign: number, kind: string) =>
    value > 0 ? `<circle class="dot ${kind}" cx="${x(days.length - 1)}" cy="${mid - sign * value * scale}" r="3.5"/>` : '';
  const slot = width / (days.length - 1);
  const hits = days
    .map(
      (d, i) =>
        `<rect class="hit" x="${Math.max(0, x(i) - slot / 2)}" y="0" width="${slot}" height="${height}"><title>${dayTitle(d)}</title></rect>`,
    )
    .join('');
  const label = (i: number, anchor: string) =>
    `<text class="axis" x="${x(i)}" y="${height + 16}" text-anchor="${anchor}">${formatDay(days[i].day)}</text>`;
  const fade = (kind: string, from: number, to: number) =>
    `<linearGradient id="fade-${kind}" x1="0" y1="${from}" x2="0" y2="${to}"><stop offset="0" class="stop-${kind}" stop-opacity=".45"/><stop offset="1" class="stop-${kind}" stop-opacity=".02"/></linearGradient>`;

  return `<svg class="flow" viewBox="-4 0 ${width + 8} ${height + 20}" width="100%" role="img" aria-label="Lines staged and unstaged per day">
    <defs>${fade('stage', 0, 1)}${fade('unstage', 1, 0)}</defs>
    <path class="area stage" d="${area(up)}"/><path class="area unstage" d="${area(down)}"/>
    <line class="baseline" x1="0" x2="${width}" y1="${mid}" y2="${mid}"/>
    <path class="line stage" d="${up}"/><path class="line unstage" d="${down}"/>
    ${dot(today.staged, 1, 'stage')}${dot(today.unstaged, -1, 'unstage')}
    <text class="axis" x="0" y="12">+${n(peakStaged)}</text>${peakUnstaged > 0 ? `<text class="axis" x="0" y="${mid + peakUnstaged * scale + 12}">−${n(peakUnstaged)}</text>` : ''}
    ${label(0, 'start')}${label(Math.floor(days.length / 2), 'middle')}${label(days.length - 1, 'end')}
    ${hits}
  </svg>`;
}

/**
 * One cell per day, a column per week: brighter for more lines, green where
 * staging dominated and red where unstaging did.
 */
function heatMap(days: DayEntry[]): string {
  const cell = 13;
  const gap = 3;
  const left = 30;
  const top = 16;
  const offset = days[0].weekday;
  const max = Math.max(1, ...days.map(linesOf));
  const weeks = Math.ceil((days.length + offset) / 7);

  let months = '';
  let lastMonth = -1;
  const cells = days
    .map((d, i) => {
      const column = Math.floor((i + offset) / 7);
      const row = (i + offset) % 7;
      const month = Number(d.day.slice(5, 7));
      if (row === 0 || i === 0) {
        if (month !== lastMonth && column < weeks - 1) {
          months += `<text class="axis" x="${left + column * (cell + gap)}" y="10">${formatMonth(d.day)}</text>`;
        }
        lastMonth = month;
      }
      const lines = linesOf(d);
      const level = d.ops === 0 ? 0 : Math.max(1, Math.ceil((lines / max) * 4));
      const kind = d.ops === 0 ? '' : d.unstaged > d.staged ? 'unstage' : 'stage';
      const isToday = i === days.length - 1 ? ' today' : '';
      return `<rect class="cell ${kind} l${level}${isToday}" x="${left + column * (cell + gap)}" y="${top + row * (cell + gap)}" width="${cell}" height="${cell}" rx="3"><title>${dayTitle(d)}</title></rect>`;
    })
    .join('');
  const weekday = (row: number, name: string) =>
    `<text class="axis" x="0" y="${top + row * (cell + gap) + cell - 3}">${name}</text>`;
  const width = left + weeks * (cell + gap);
  const height = top + 7 * (cell + gap);
  return `<svg viewBox="0 0 ${width} ${height}" width="${Math.round(width * 1.3)}" style="max-width: 100%" role="img" aria-label="Activity per day">
    ${months}${weekday(1, 'Mon')}${weekday(3, 'Wed')}${weekday(5, 'Fri')}${cells}
  </svg>`;
}

/** A smooth curve through `points` that never overshoots them (monotone cubic interpolation). */
export function smoothPath(points: Array<[number, number]>): string {
  const count = points.length;
  if (count === 0) {
    return '';
  }
  const fmt = ([px, py]: [number, number]) => `${px.toFixed(1)},${py.toFixed(1)}`;
  if (count === 1) {
    return `M${fmt(points[0])}`;
  }
  const slopes = points.slice(1).map(([px, py], i) => (py - points[i][1]) / (px - points[i][0]));
  const tangents = points.map((_, i) => {
    if (i === 0) {
      return slopes[0];
    }
    if (i === count - 1) {
      return slopes[count - 2];
    }
    return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  });
  for (let i = 0; i < count - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      tangents[i] = t * a * slopes[i];
      tangents[i + 1] = t * b * slopes[i];
    }
  }
  let path = `M${fmt(points[0])}`;
  for (let i = 0; i < count - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const third = (x1 - x0) / 3;
    path += ` C${fmt([x0 + third, y0 + tangents[i] * third])} ${fmt([x1 - third, y1 - tangents[i + 1] * third])} ${fmt([x1, y1])}`;
  }
  return path;
}

function dayTitle(d: DayEntry): string {
  if (d.ops === 0) {
    return `${formatDay(d.day)}: nothing`;
  }
  return `${formatDay(d.day)}: ${n(d.staged)} staged · ${n(d.unstaged)} unstaged · ${plural(d.ops, 'operation')}`;
}

function n(value: number): string {
  return value.toLocaleString();
}

function plural(count: number, word: string): string {
  return `${n(count)} ${word}${count === 1 ? '' : 's'}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMonth(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, { month: 'short' });
}
