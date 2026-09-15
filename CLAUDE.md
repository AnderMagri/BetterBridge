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
      { type: "text", text: "Golf Balls — Dozen", textStyle: "Heading/H3" },
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
selection. Supported fields: `remove`, `name`, `text` (+ optional `font`),
`textStyle`, `props` (instances only), `fill`, `stroke`, `effect`, `gap`,
`pad`, `radius`, `w`, `h`.

This is the highest-leverage rule in this file — most Figma work here is
revising something that already exists, not creating from nothing.

## Design system first — tokens and styles, not raw values

1. At the start of a session, call `designSystem()` once. It's small: whether
   the file is connected to a design system (`source: "library" | "local" |
   "none"`), library names, counts, and whether strict mode is on.
2. If `connected` is true, **build with token and style names**: `fill`,
   `stroke`, `gap`, `pad`, `radius` take token names; `textStyle` and `effect`
   take style names; `fill`/`stroke` also accept a paint style name. Tokens
   from enabled libraries work the same as local ones.
3. Don't guess names. When you need them, call `designSystem({ list: true })`
   once and keep the result for the session. It can be large on a big system,
   so don't repeat it.
4. **Strict mode ("DS only") is on by default** when a design system exists.
   Raw hex colours and raw non-zero spacing/radius numbers are refused and come
   back as `strict:` entries; text without a `textStyle` is flagged. Fix these
   by using the right token or style. **Don't try to turn strict mode off.** If
   the system genuinely lacks a token for something, report that to the user,
   who can switch "DS only" off in the plugin window.
5. With strict mode off, raw values apply but are listed in `offSystem`.
   Mention them to the user rather than ignoring them.

## Saved actions — don't redo what a recipe does for free

The plugin's **Actions** menu runs recipes from the BetterBridge repo's
`actions/` folder with no Claude tokens at all.

- If the user asks for a **DS foundation** (base tokens, text styles, shadows)
  and `designSystem()` shows none, tell them to run **Actions → Create DS
  foundation** in the plugin window rather than building it yourself.
- If they ask for a **design system page** with swatches, type specimens and
  basic Button / Input / Card components, point them to **Actions → Build the
  DS page**.
- `runRecipe(recipe)` is also available through `figma_execute`, for a recipe
  the user gives you. It returns `{ ok, created, skipped, stopped?, unresolved? }`.

## Icons — use the connected set, never draw icons

1. `designSystem()` includes `icons: { connected, name, count, usedOnPage? }`.
   The icon set is chosen **per file**.
2. Place icons with `{ icon: "<name>" }` in a buildSpec node. Find names with
   `await findIcons("arrow")`. It returns a short list, so **never** ask for the
   whole set. Without a connected set, it searches library icons already used
   on the current page.
3. Never build an icon out of vectors or shapes. If the icon isn't available,
   say so. The user picks or connects a set from the Icons picker in the
   plugin window (open the icon library → **+ Connect icons from this file**).
4. `"icon:…"` in `unresolved` → not in the set (search with `findIcons`), or
   the library isn't published so it can't be imported here.

## Several files connected at once

Each file has its own design system, icon set and "DS only" setting. When
working across files, call `designSystem()` in **each** file (each
`figma_execute` runs in one file) and use that file's names. Never carry token,
style or icon names over from another file.

## Registry first — never rebuild what exists

1. At the start of a session, if `figma.manifest.json` exists in the project
   folder, read it and pass the whole file once:
   `return globalThis.setManifest({ components: {...}, styles: {...} })`.
   Its `styles` section is how library styles get resolved — the plugin API
   can't list them on its own.
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
- `"var:spacing/md"` / `"color:…"` → no token (or paint style) with that
  name in the file or its enabled libraries. Check `designSystem({ list: true })`
  rather than guessing a new one.
- `"ambiguous:…"` → two collections or libraries share the name. Prefix the
  one you mean: `"Semantic:color/primary"`.
- `"varType:…"` → right name, wrong kind (e.g. a number token used as a fill).
- `"textStyle:…"` / `"effect:…"` / `"import:…"` → style not found, or a
  library item couldn't be imported.
- `"strict:…"` → strict mode refused a raw value. Use a token or style.
- `"field:…"` → a misspelled field, or one that doesn't apply to that node
  (`gap` without `layout`, `text` on a frame). Fix the spec.
- `"size:…"` → `hug` without auto layout, or `fill` without an auto-layout
  parent.
- `"slot:…"` → that slot doesn't exist; the real slot names are listed.
- `"ignored:…"` → an instruction was overridden (e.g. `size` next to a
  `textStyle`). Not a miss, but don't keep sending it.
- `"font:…"` → the font isn't available; it fell back to Inter.
- `"mixedFont:…"` → the text had mixed styling; it was changed, but that
  styling may be lost. Pass `font` or `textStyle` when that matters.
- `failed` (patchSpec only) → the whole op errored (usually a bad/stale id).
  `unresolved` is a partial miss inside an otherwise-successful op.

Report unresolved/failed items rather than papering over them — a silent
lookalike or a silently-dropped edit is worse than a visible gap. For builds
that must be all-or-nothing, pass `atomic: true`: any unresolved entry removes
the whole build. A build that throws partway is always rolled back.

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
  fill, stroke,                          // token NAME, paint style NAME, or "#hex"
  effect,                                // effect style NAME
  w, h,                                  // number | "hug" | "fill"
  align: "start|center|end|between",     // main axis (needs layout)
  cross: "start|center|end|stretch",     // cross axis (needs layout)
  text, textStyle,                       // text only; textStyle wins over font/size
  font: "Inter/Semi Bold", size,         // text only
  children: [ ... ] }                    // frame only
```
Token names may be scoped: `"Collection:name"` or `"Library:name"`.

**buildSpec** icon: `{ icon: "arrow-right", name?, w?, h? }`

**buildSpec** registry instance:
```
{ use: "Button/Primary",
  props: { label: "Add to cart", State: "Default" },
  slots: { media: [ ...nodes ] } }
```

**buildSpec** top level:
```
{ at: {x, y}, parentId: "123:45", manifest: {...}, select: false,
  strict: true, atomic: true, build: <node> }
```

**patchSpec** (array of ops, optional `{ strict: true }` second argument):
```
[{ id: "123:45", remove?, name?, text?, font?, textStyle?, props?, fill?, stroke?, effect?,
   gap?, pad?, radius?, w?, h? }]
```

**designSystem**`(opts?)` — returns `{ connected, source, libraries, tokens,
styles, registry, strict, icons }`.

**findIcons**`(query, limit?)` — `{ connected, set, total, icons: [names] }`. `{ list: true }` adds every token and style name;
`{ refresh: true }` re-reads enabled libraries first.

**manifestSummary**`(opts?)` — `{ allPages: true }` to scan the whole file
instead of just the current page. Returns
`{ "Name": { nodeId, key, props? } }`.
