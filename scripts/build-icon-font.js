// Builds media/chunk-stage.ttf: a one-glyph icon font used as `$(chunk-stage)`
// in status bar items. Font glyphs take the theme's text color, unlike images.
//
// Run: npm run build:icon
const fs = require('fs');
const path = require('path');
const svg2ttf = require('svg2ttf');

// Geometry in a 256-unit design grid (y down), traced from images/icon.png.
const STROKE = 18;
const R = STROKE / 2;
const BOX = { min: 31, max: 224 };

const fills = [
  circle(69, 69.5, 38.5),
  capsule(68.5, 102, 68.5, 215), // stem below the ring
  capsule(138, 70, 170.5, 70), // top bar
  arcBand(170.5, 86.5, 16, -90, 0), // rounded corner
  capsule(186.5, 86.5, 186.5, 120), // upper drop
  capsule(186.5, 158, 186.5, 186.5), // lower drop
  capsule(157, 186.5, 215, 186.5), // ground bar
  capsule(137, 215, 151, 215), // left dash
  capsule(177, 215, 199, 215), // right dash
];
const holes = [circle(69, 69.5, 38.5 - STROKE)];

// Font units: 1000 per em, glyph square sitting on the baseline like codicons.
const UNITS = 1000;
const MARGIN = 40;
const scale = (UNITS - 2 * MARGIN) / (BOX.max - BOX.min);
const toFont = ([x, y]) => [MARGIN + (x - BOX.min) * scale, UNITS - MARGIN - (y - BOX.min) * scale];

// Overlapping fills merge under the nonzero rule as long as they all wind the
// same way; holes wind the other way.
const contours = [
  ...fills.map((points) => orient(points.map(toFont), -1)),
  ...holes.map((points) => orient(points.map(toFont), 1)),
];
const d = contours
  .map((points) => `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`)
  .join('');

const svgFont = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="chunk-stage" horiz-adv-x="${UNITS}">
<font-face font-family="chunk-stage" units-per-em="${UNITS}" ascent="${UNITS}" descent="0"/>
<missing-glyph horiz-adv-x="0"/>
<glyph glyph-name="chunk-stage" unicode="&#xE900;" horiz-adv-x="${UNITS}" d="${d}"/>
</font></defs></svg>`;

const out = path.join(__dirname, '..', 'media', 'chunk-stage.ttf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(svg2ttf(svgFont, { description: 'Chunk Stage icon', version: '1.0' }).buffer));
console.log(`wrote ${path.relative(process.cwd(), out)}`);

function circle(cx, cy, r, steps = 64) {
  return Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** A stroke from (x1, y1) to (x2, y2) with round caps. */
function capsule(x1, y1, x2, y2, steps = 16) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const half = (cx, cy, from) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = from + (Math.PI * i) / steps;
      return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
  return [...half(x2, y2, angle - Math.PI / 2), ...half(x1, y1, angle + Math.PI / 2)];
}

/** A stroke along a circular arc (degrees, y down) with flat ends. */
function arcBand(cx, cy, radius, fromDeg, toDeg, steps = 16) {
  const arc = (r) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  return [...arc(radius + R), ...arc(radius - R).reverse()];
}

/** Returns the contour winding in the requested direction (sign of its area). */
function orient(points, sign) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.sign(area) === sign ? points : [...points].reverse();
}
