# BetterBridge

A fork of the **Figma Desktop Bridge** plugin (from Southleft's
[`figma-console-mcp`](https://github.com/southleft/figma-console-mcp)) that
cuts token consumption on both the read and write side of an AI-assisted
Figma workflow, and makes Claude reuse existing components instead of
rebuilding them.

> ⚠️ **Upstream attribution / licensing.** Everything except the additions
> listed below is upstream code. Check the upstream project's LICENSE before
> distributing this fork, and keep the attribution intact.

## For reviewers / anyone this gets forwarded to

Building or editing UI through Claude normally costs tokens two ways: Claude
writes verbose imperative code for every change, and it often rebuilds
components from scratch because it has no cheap way to know what already
exists. This fork moves that verbose work **into the plugin**, where it costs
no model tokens, and gives Claude a way to reference existing components by
name instead of reinventing them. Measured on a representative build (one
product card, spec vs. hand-written equivalent), the create path alone runs
roughly **75–80% fewer output tokens**; registry reuse and the new edit path
add more on top of that, especially across a normal session of repeated
revisions. **Token savings only translate to dollar savings under
metered/API billing** — if your team is on a fixed Claude plan, the benefit
shows up as more headroom under your usage limits rather than a line-item
cost reduction. Either way, the multiplier that matters most for a real
estimate is your own: **(tokens saved per build) × (builds per week) × (your
billing rate or plan headroom)** — plug in your team's numbers rather than
taking this repo's word for it.

**Test status:** the core logic (buildSpec, patchSpec, manifestSummary) is
validated against a mocked Figma Plugin API — 31 assertions covering
creation, registry resolution, variable binding, editing, deletion, and
failure handling, including one real bug the tests caught before shipping.
It has **not yet been run against live Figma.** See
[Before you install](#before-you-install-validate-it) below.

## What this adds over upstream

### 1. `buildSpec()` — create, registry-aware

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

Claude sends a small spec; the plugin does font loading, variable binding,
instance creation, and slot filling locally. `{ use: "Name" }` resolves
against a project registry (or, absent one, by matching names on the current
page) instead of rebuilding a lookalike from primitives.

### 2. `patchSpec()` — edit what already exists

The gap in the first version of this fork: it could only create. Most real
work is revision, not creation.

```js
return await patchSpec([
  { id: "12:345", text: "Golf Balls — Half Dozen" },
  { id: "12:349", props: { State: "Hover" } },
  { id: "12:350", remove: true }
]);
```

Change a few fields on an existing node without resending or rebuilding the
tree around it.

### 3. `manifestSummary()` — cheap registry export

```js
return await manifestSummary();
// { "Button/Primary": { nodeId: "1:234", key: null, props: ["label","State"] } }
```

A lightweight snapshot of local components (current page by default, or
`{ allPages: true }`) — just names, ids, and prop names, no descriptions or
visual data — meant to be written straight into `figma.manifest.json`.

### 4. Token names, not hex, throughout

`fill`, `stroke`, `gap`, `pad`, and `radius` all accept a Figma variable name
(`"color/brand/primary"`, `"spacing/md"`) and bind the real variable. Raw
`#hex` and numbers still work as a fallback.

### 5. `unresolved` / `failed`, always

Nothing that can't be resolved is silently faked. A missing component name,
an unknown token, a stale node id — all come back explicitly so Claude (or
you) can fix the real problem instead of shipping a lookalike.

## Install

> **Sharing this with someone?** Point them at [INSTALL.md](INSTALL.md) — a
> full step-by-step guide including the MCP server half, troubleshooting, and
> what we'd like testers to report back.

1. Figma Desktop → **Plugins → Development → Import plugin from manifest…**
2. Select this folder's `manifest.json`
3. Run it — appears as **BetterBridge**, distinct from the original Desktop
   Bridge, so both can be installed side by side.

> Figma caches plugin code at the application level. After any edit to
> `code.js` / `ui.html`, **re-import the manifest** — restarting the plugin
> alone will not pick up changes.

Runs alongside the same MCP server as upstream (ports 9223–9232). No server
changes required — everything here is called through the existing
`figma_execute` capability.

## Before you install: validate it

Run this before trusting it on real work, and definitely before pointing a
peer at it. All of it happens in one throwaway test file — nothing here
touches your production Figma files.

1. **Import and connect.** Confirm the status pill reads
   **"Connected — AI can work in this file"** with a green dot, same as the
   original Desktop Bridge did.
2. **Smoke-test `buildSpec` with primitives only** (no registry yet):
   ```js
   return await buildSpec({ build: {
     type: "frame", name: "Test Card", layout: "col", gap: 16, pad: 16,
     radius: 8, fill: "#eeeeee", w: 280, h: "hug",
     children: [{ type: "text", text: "Hello BetterBridge", size: 16 }]
   }});
   ```
   Check the frame actually appears, sized and styled as specified.
3. **Smoke-test registry reuse.** Pick one real component in the file, note
   its node id (right-click → Copy/Paste as → Copy link, or via
   `figma_search_components`), then:
   ```js
   return await buildSpec({
     manifest: { "YourComponent": { nodeId: "PASTE_ID_HERE" } },
     build: { type: "frame", layout: "col", gap: 8,
       children: [{ use: "YourComponent" }] }
   });
   ```
   Confirm it's a real instance of your component, not a rebuilt lookalike.
4. **Smoke-test a token name** you know exists (`gap: "your/real/spacing/token"`)
   and one that doesn't — confirm the real one binds and the fake one shows
   up in `unresolved` instead of silently failing.
5. **Smoke-test `patchSpec`** on the node from step 2 — change its text,
   change a fill, then delete it with `remove: true`.
6. **Smoke-test `manifestSummary()`** — run it, confirm the shape looks right
   for a few components you recognize.
7. **Try one component with a variant property** (a real `State=Hover`-style
   prop) and one with a slot, if your design system uses them — these are the
   two paths the mock tests can't fully cover (see caveats below).

If all seven hold up, it's ready to show your team.

## Setup per project

1. Copy `manifest.example.json` into your project folder as
   `figma.manifest.json` and fill in real components — or generate the
   `components` section by calling `manifestSummary()` and pasting the result
   in directly.
2. Copy `CLAUDE.md` into the project root so Claude reaches for `buildSpec`/
   `patchSpec`/the registry automatically instead of writing imperative code
   out of habit.
3. At session start: `return globalThis.setManifest({ ...your components })`

No manifest? It still works — falls back to matching component names on the
current page.

## Files changed vs upstream

| File | Change |
|---|---|
| `code.js` | Added the builder module (`buildSpec`, `patchSpec`, `manifestSummary`, `setManifest`) before `figma.ui.onmessage`; added `BUILD_SPEC` / `PATCH_SPEC` / `MANIFEST_SUMMARY` branches after `EXECUTE_CODE`; version marked `1.39.0-betterbridge.2` |
| `ui.html` | Added `window.buildSpec` / `patchSpec` / `manifestSummary` and matching `methodMap` entries |
| `manifest.json` | Renamed to `BetterBridge`, id `betterbridge-mcp`; dropped the unused `permissions: ["teamlibrary"]` and `enablePrivatePluginApi` declarations |
| `code.js` (upstream paths) | Fixed two `documentAccess: "dynamic-page"` violations inherited from upstream: `DEEP_GET_COMPONENT` now pre-resolves instance main components via `getMainComponentAsync()`, and the `token-misuse` lint rule pre-resolves variable names via `getLocalVariablesAsync()`. Both previously threw into a silent `catch` and dropped their output. |

Everything else is untouched. Re-syncing with upstream means re-applying
these edits — the diff is deliberately small and self-contained for exactly
that reason.

## Caveats — read before rolling out further

- **Validated by logic tests, not live Figma.** `test-builder.js` runs the
  actual builder module against a mocked Plugin API (31 assertions: create,
  registry resolution, variable binding, edit, delete, failure handling). It
  confirms the control flow and field names are correct. It **cannot**
  confirm real font availability, real auto-layout rendering, or real
  variable-mode resolution — only Figma itself can. Run the validation
  checklist above first.
- **Variant/instance-swap properties** are the least-tested path. Boolean,
  text, and standard variant properties are covered by the mock; a component
  using instance-swap slots for nested components has not been exercised
  end-to-end.
- **Mixed-font text nodes** need an explicit `font` override in `patchSpec` —
  this is handled (falls into `unresolved` as `mixedFont:…` rather than
  crashing), but confirm it once against a real mixed-style text layer if
  your files use those.
- **This is a fork you now maintain.** Upstream updates mean re-applying the
  three edits above by hand.
- **Read-side savings are a separate, usage-discipline win**, not something
  this patch enforces by itself — see `extract-compact.js` and the read-side
  rules in `CLAUDE.md`. A single careless whole-page read can cost more
  tokens than a week of `buildSpec` calls saves.

## Included

- `code.js`, `ui.html`, `manifest.json` — the plugin itself
- `_builder-module.js` — the builder module in isolation (same content
  that's spliced into `code.js`; kept separate so it can be tested or
  re-diffed against a future upstream independently)
- `test-builder.js` — the mock-Figma logic test suite; run with
  `node test-builder.js`
- `CLAUDE.md` — project rules that make Claude use all of this automatically
- `manifest.example.json` — starter component registry format
- `extract-compact.js` — the read-side token-reduction script from earlier
