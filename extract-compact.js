// ============================================================================
// extract-compact.js
// Paste the BODY of this file as the `code` for figma_execute (EXECUTE_CODE).
//
// The Bridge wraps your code in (async function(){ ... })(), so:
//   - `await` works anywhere
//   - you MUST `return` your value (a bare final expression returns nothing)
//   - whatever you return is what lands in Claude's context — so we return a
//     COMPACT STRING, never the raw node objects.
//
// What it does: walks the current selection, and for each node emits one line
// with only the fields you actually build from, swapping raw values for your
// Figma variable/token names where they're bound, and dropping defaults/empties.
// ============================================================================

const MAX_DEPTH = 12;          // guard against runaway trees + the 5s timeout
const varCache = new Map();    // id -> variable name, so we resolve each once

async function varName(id) {
  if (!id) return null;
  if (varCache.has(id)) return varCache.get(id);
  let name = null;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    name = v ? v.name : null;            // e.g. "color/brand/primary"
  } catch (e) { name = null; }
  varCache.set(id, name);
  return name;
}

function hex(c) {
  if (!c) return null;
  const h = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 1 ? h(c.a) : "");
}

// Resolve a paint (fill/stroke) to a token name if bound, else a hex value.
async function paint(node, prop) {
  const bound = node.boundVariables && node.boundVariables[prop];
  if (bound && bound[0] && bound[0].id) {
    const n = await varName(bound[0].id);
    if (n) return n;
  }
  const arr = node[prop];
  if (Array.isArray(arr) && arr.length) {
    const p = arr.find((x) => x.visible !== false && x.type === "SOLID");
    if (p) return hex(p.color);
  }
  return null;
}

// Resolve a numeric prop (spacing/padding/radius) to a token name if bound.
async function num(node, prop) {
  const bound = node.boundVariables && node.boundVariables[prop];
  if (bound && bound.id) {
    const n = await varName(bound.id);
    if (n) return n;
  }
  const v = node[prop];
  return (typeof v === "number" && v !== 0) ? String(Math.round(v)) : null;
}

async function line(node, depth) {
  const pad = "  ".repeat(depth);
  const bits = [];

  // --- auto layout (the stuff you actually need to rebuild it) ---
  if (node.layoutMode && node.layoutMode !== "NONE") {
    bits.push(node.layoutMode === "HORIZONTAL" ? "row" : "col");
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN")
      bits.push("main:" + node.primaryAxisAlignItems.toLowerCase());
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN")
      bits.push("cross:" + node.counterAxisAlignItems.toLowerCase());
    const gap = await num(node, "itemSpacing");
    if (gap) bits.push("gap " + gap);
    // padding — collapse to one token when uniform, else list what's set
    const pl = await num(node, "paddingLeft"), pr = await num(node, "paddingRight");
    const pt = await num(node, "paddingTop"), pb = await num(node, "paddingBottom");
    const ps = [pt, pr, pb, pl].filter(Boolean);
    if (ps.length) bits.push("pad " + (new Set([pt, pr, pb, pl]).size === 1 ? pt : `${pt||0}/${pr||0}/${pb||0}/${pl||0}`));
  }

  const radius = await num(node, "cornerRadius") || await num(node, "topLeftRadius");
  if (radius) bits.push("radius " + radius);

  const line1 = `${pad}${node.name} [${node.type.toLowerCase()}${bits.length ? ", " + bits.join(", ") : ""}]`;

  // --- sub-attributes on their own indented lines, only when present ---
  const sub = [];
  const fill = await paint(node, "fills");
  if (fill) sub.push(`${pad}  fill: ${fill}`);
  const stroke = await paint(node, "strokes");
  if (stroke) sub.push(`${pad}  stroke: ${stroke}`);

  if (node.type === "TEXT") {
    const f = node.fontName && node.fontName.family
      ? `${node.fontName.family} ${node.fontName.style}` : "";
    const sz = typeof node.fontSize === "number" ? `${node.fontSize}` : "";
    const color = await paint(node, "fills");
    sub.push(`${pad}  "${(node.characters || "").slice(0, 60)}"`);
    if (f || sz) sub.push(`${pad}  type: ${[f, sz].filter(Boolean).join(" / ")}`);
  }

  return [line1, ...sub].join("\n");
}

async function walk(node, depth, out) {
  if (depth > MAX_DEPTH) return;
  if (node.visible === false) return;              // skip hidden layers entirely
  out.push(await line(node, depth));
  // Don't descend into instances — reference them by name, that's the point.
  if (node.type === "INSTANCE") {
    const main = await (node.getMainComponentAsync ? node.getMainComponentAsync() : null);
    if (main) out[out.length - 1] += `  → instance of ${main.name}`;
    return;
  }
  if ("children" in node) {
    for (const child of node.children) await walk(child, depth + 1, out);
  }
}

// --- entry point ---
const sel = figma.currentPage.selection;
if (!sel.length) return "No selection. Select a frame/component and re-run.";
const out = [];
for (const node of sel) await walk(node, 0, out);
return out.join("\n");
