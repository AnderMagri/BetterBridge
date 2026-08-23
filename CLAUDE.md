# Figma build rules (BetterBridge)

Drop this in the project root (or paste into project instructions). It's what
makes the token savings happen automatically instead of only when someone
remembers to ask for them.

## Building anything new in Figma

Use `buildSpec` via `figma_execute`. Do not hand-write imperative Figma API
code, and do not chain many separate MCP write calls for one piece of UI.

```js
return await buildSpec({
  build: {
    type: "frame", name: "Product Card", layout: "col",
    gap: "spacing/md", pad: "spacing/lg", radius: "radius/lg",
    fill: "color/surface/card", w: 320, h: "hug",
    children: [
      { type: "text", text: "Golf Balls — Dozen", font: "Inter/Semi Bold", size: 16 },
      { use: "Button/Primary", props: { label: "Add to cart" } }
    ]
  }
});
```

## Editing something that already exists

**Use `patchSpec`. Do not rebuild an existing node from scratch to change one
field, and do not resend a whole spec to change a label or a color.**

```js
return await patchSpec([
  { id: "12:345", text: "Golf Balls — Half Dozen" },
  { id: "12:349", props: { State: "Hover" } },
  { id: "12:350", fill: "color/surface/highlight" }
]);
```

Get the `id` from a prior `buildSpec`/`patchSpec` result, or from the current
selection. Supported fields: `remove`, `name`, `text` (+ optional `font`
override for mixed-style text nodes), `props` (instances only), `fill`,
`stroke`, `gap`, `pad`, `radius`, `w`, `h`.

This is the highest-leverage rule in this file — most Figma work here is
revising something that already exists, not creating from nothing.

## Registry first — never rebuild what exists

1. At the start of a session, if `figma.manifest.json` exists in the project
   folder, read it and call once: `return globalThis.setManifest({ ...components })`
2. No manifest yet, or it's gone stale? Call `manifestSummary()` — cheap,
   current-page-only by default — and either write its result to
   `figma.manifest.json` or pass it inline as `buildSpec`'s `manifest` field
   for the rest of the session.
3. Any component in the registry must be referenced with `use: "<Name>"`.
   **Never** rebuild a registry component out of frames/text primitives.
4. Only build primitives for things genuinely not in the registry yet.

## Verifying a build

Prefer a screenshot over re-reading the tree when the question is "does this
look right" rather than "what are the exact values."

```js
// via the existing CAPTURE_SCREENSHOT capability — already resolution-capped
// to what Claude's vision actually uses, so it doesn't cost more than it needs to
```

Re-read the tree (`extract-compact.js`) only when you need exact values back,
not just a visual check. `buildSpec` and `patchSpec` results already include
enough (id, name, w, h, patched/failed/unresolved counts) to confirm a plain
success without any follow-up call at all.

## Doing several things in one sitting

If building or patching multiple independent things, do it in **one**
`figma_execute` call that runs several `buildSpec`/`patchSpec` calls and
returns one combined summary — not one round trip per component. Each
separate call carries its own request/response overhead on top of the payload
itself.

## Handling `unresolved` and `failed`

- `"Button/Primary"` in `unresolved` → the component name is wrong or not in
  the registry. Fix the name or search for the right one. Do **not** silently
  build a lookalike.
- `"var:spacing/md"` → that token name doesn't exist. Check real variable
  names rather than guessing a new one.
- `"font:…"` → the font isn't available; it fell back to Inter.
- `"mixedFont:…"` → the text node has mixed styling; pass an explicit `font`
  in the patch op to set one before changing its content.
- `failed` (patchSpec only) → the whole op errored (usually a bad/stale id).
  `unresolved` is a partial miss inside an otherwise-successful op.

Report unresolved/failed items rather than papering over them — a silent
lookalike or a silently-dropped edit is worse than a visible gap.

## Graduating components

When a repeatedly-built primitive stabilizes, say so and offer to promote it:
turn it into a real component, then add it to `figma.manifest.json` (or just
re-run `manifestSummary()`). From then on it's referenced by name — the
cheapest possible form.

## Spec reference

**buildSpec** primitive node:
```
{ type: "frame|text|rectangle|ellipse", name,
  layout: "row|col", gap, pad, radius,   // token NAME (string) or number
  fill, stroke,                          // token NAME or "#hex"
  w, h,                                  // number | "hug" | "fill"
  align: "center|end|between",           // main axis
  cross: "center|end|stretch",           // cross axis
  text, font: "Inter/Semi Bold", size,   // text only
  children: [ ... ] }
```

**buildSpec** registry instance:
```
{ use: "Button/Primary",
  props: { label: "Add to cart", State: "Default" },
  slots: { media: [ ...nodes ] } }
```

**buildSpec** top level:
```
{ at: {x, y}, parentId: "123:45", manifest: {...}, select: false, build: <node> }
```

**patchSpec** (array of ops):
```
[{ id: "123:45", remove?, name?, text?, font?, props?, fill?, stroke?, gap?, pad?, radius?, w?, h? }]
```

**manifestSummary**`(opts?)` — `{ allPages: true }` to scan the whole file
instead of just the current page. Returns
`{ "Name": { nodeId, key, props? } }`.
