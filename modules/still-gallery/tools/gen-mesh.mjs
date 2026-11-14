/**
 * Generates a seamless low-poly triangular mesh as a flat SVG tile.
 *
 * Why a real triangulation instead of a CSS gradient: a "low poly" surface is
 * defined by *many* planar faces meeting at hard edges. Two-stop gradients can
 * only ever produce a smooth ramp — one fold. A tiled mesh gives the page an
 * actual geometric substrate, and because every triangle is filled flat the
 * result stays cheap to paint (no filters, no blur).
 *
 * Seamlessness: only interior vertices are jittered, so the four borders keep
 * the regular grid spacing and any tile edge matches its neighbour exactly.
 */
import fs from 'node:fs';

const SIZE = 960;
const CELLS = 8;
const STEP = SIZE / CELLS;
const JITTER = 0.3;

// Deterministic PRNG so the file is reproducible; a random mesh would churn the
// diff every time it is regenerated.
let seed = 20261109;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// Deliberately low contrast: the mesh is a substrate, not the subject. The
// gallery photographs have to stay the brightest thing on the page.
const PALETTE = ['#e4e9f3', '#dde4f0', '#d6deec', '#e9edf6', '#cfd8e8', '#e1e7f2', '#d9e1ef'];

const vert = (gx, gy) => {
  const edgeX = gx === 0 || gx === CELLS;
  const edgeY = gy === 0 || gy === CELLS;
  const jx = edgeX ? 0 : (rand() - 0.5) * 2 * JITTER * STEP;
  const jy = edgeY ? 0 : (rand() - 0.5) * 2 * JITTER * STEP;
  return [gx * STEP + jx, gy * STEP + jy];
};

const points = [];
for (let gy = 0; gy <= CELLS; gy += 1) {
  const row = [];
  for (let gx = 0; gx <= CELLS; gx += 1) row.push(vert(gx, gy));
  points.push(row);
}

const tris = [];
for (let gy = 0; gy < CELLS; gy += 1) {
  for (let gx = 0; gx < CELLS; gx += 1) {
    const a = points[gy][gx];
    const b = points[gy][gx + 1];
    const c = points[gy + 1][gx + 1];
    const d = points[gy + 1][gx];
    // Alternating diagonals stop the grid from reading as a checkerboard of
    // identical rhombi — that is what makes a mesh look machine-generated.
    if ((gx + gy) % 2 === 0) {
      tris.push([a, b, c], [a, c, d]);
    } else {
      tris.push([a, b, d], [b, c, d]);
    }
  }
}

const num = (n) => Math.round(n * 10) / 10;
const polys = tris
  .map(([p, q, r], i) => {
    const fill = PALETTE[Math.floor(rand() * PALETTE.length)];
    const d = `M${num(p[0])} ${num(p[1])}L${num(q[0])} ${num(q[1])}L${num(r[0])} ${num(r[1])}Z`;
    return `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="0.5"/>`;
  })
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges"><rect width="${SIZE}" height="${SIZE}" fill="#e5e9f2"/>${polys}</svg>\n`;

fs.writeFileSync(process.argv[2], svg);
console.log(`wrote ${process.argv[2]} — ${tris.length} triangles, ${svg.length} bytes`);
