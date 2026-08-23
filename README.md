# BetterBridge

A Figma plugin that cuts how many tokens Claude burns building and editing UI — and makes it
reuse your real components instead of rebuilding lookalikes.

## Download

```bash
git clone https://github.com/AnderMagri/BetterBridge.git
```

**This repo is the plugin you install.** Setup takes about 10 minutes —
see **[INSTALL.md](INSTALL.md)**.

> Don't install anything else. The MCP server ships its own plugin with a nearly identical name.
> It connects fine and then silently lacks `buildSpec`, which looks like a bug in this one.

---

## The problem

When Claude builds UI in Figma, it pays for the same work twice:

1. **It writes long code for every small change.** Creating one card means dozens of lines of
   Figma API calls — every frame, every font load, every colour.
2. **It rebuilds things you already have.** Claude has no cheap way to see what's in your file,
   so it recreates your button out of frames and text instead of using your actual component.

## What BetterBridge does

Claude sends a **short description** of what it wants. The plugin does the verbose work locally,
inside Figma, where it costs no model tokens.

```js
buildSpec({ build: {
  type: "frame", name: "Product Card", layout: "col", gap: "spacing/md",
  fill: "color/surface/card", w: 320,
  children: [
    { type: "text", text: "Golf Balls — Dozen", size: 16 },
    { use: "Button/Primary", props: { label: "Add to cart" } }
  ]
}})
```

That `{ use: "Button/Primary" }` places a **real instance** of your component — linked to the
main component, not a copy.

### Three functions

| Function | What it's for |
|---|---|
| `buildSpec()` | Create something new |
| `patchSpec()` | Change something that already exists, in place |
| `manifestSummary()` | List the components in your file, to build a registry |

**`patchSpec` is the one that matters most day to day** — most real work is revising, not creating:

```js
patchSpec([
  { id: "12:345", text: "Golf Balls — Half Dozen" },
  { id: "12:349", props: { State: "Hover" } },
  { id: "12:350", remove: true }
])
```

### It tells you when something's wrong

Nothing is ever silently faked. A component name it can't find, a token that doesn't exist, a
stale node id — all come back in `unresolved` or `failed` so you can fix the real problem
instead of shipping a lookalike nobody notices.

You can also use **token names instead of hex values** — `fill: "color/brand/primary"`,
`gap: "spacing/md"` — and it binds the real Figma variable. Raw hex and numbers still work.

---

## Using it on a project

The **registry** is what makes Claude reuse your components. It's a list of what exists:

```json
{
  "components": {
    "Button/Primary": { "nodeId": "1:234", "key": null, "props": ["label", "State"] }
  }
}
```

Don't type it by hand — run `manifestSummary()` and paste the result into
`figma.manifest.json` in your project folder. Then at the start of a session:

```js
globalThis.setManifest({ /* your components */ })
```

Also copy **[CLAUDE.md](CLAUDE.md)** into your project root. That's what makes Claude reach for
these functions automatically instead of writing imperative code out of habit.

**No registry?** It still works — it falls back to matching component names on the current page.

> Two things worth knowing: `nodeId` only works in the file it came from, while `key` works
> anywhere — prefer `key` when you have it. And `buildSpec` creates **frames**, not components,
> so a new element won't appear in the registry until you promote it to a real component.

---

## The other half: reading your file

Building is only half of what costs tokens. The other half is Claude **looking** at your Figma
file — and BetterBridge does nothing about that automatically. It's a habit, not a feature, and
it's easy to spend more here than `buildSpec` saves.

**Why reading is expensive.** When Claude inspects a Figma page, it gets back every layer with
every property — including all the defaults nobody set. A busy page can be tens of thousands of
tokens in a single call. For comparison, the whole dashboard spec in the section above was about
500. One careless "have a look at this page" can cost more than a week of building.

**Three habits that cost nothing to adopt:**

1. **Select the thing first, then ask.** "Look at this page" reads everything. Select the frame
   you care about and say "look at what I've selected" — same answer, a fraction of the size.
2. **Ask for a screenshot when the question is visual.** "Does this look right?" is answered by a
   picture, not by a layer tree. A screenshot runs roughly 1,000–2,000 tokens; a full tree read of
   a real page is often far more. But screenshots aren't free either — one when you need to see
   the result, not one after every change.
3. **Don't re-read to confirm success.** `buildSpec` and `patchSpec` already return the node id,
   name, size, and counts. That's usually enough to know it worked.

**When you genuinely need the structure back**, use `extract-compact.js` — paste its contents as
the body of a `figma_execute` call. It walks your **current selection** and returns one short line
per layer instead of raw node objects: skips hidden layers, drops default values, swaps raw
numbers and hex for your variable names where they're bound, and — the important part — refuses to
descend into component instances, listing them as `→ instance of Button/Primary` instead of
dumping their internals.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `buildSpec is not defined` | You're running the server's bundled plugin, not BetterBridge | Run **BetterBridge** from Plugins → Development. Remove the other one so you can't pick it by mistake. |
| Your edits to `code.js` / `ui.html` do nothing | **Figma caches plugin code at the app level** | **Re-import the manifest.** Restarting the plugin isn't enough. If it still won't take, quit Figma completely — ⌘Q on macOS, close every window on Windows — and reopen. |
| Plugin shows **Connected**, Claude says **not connected** | Two MCP servers running. Both can hold "port 9223" — one on IPv4, one on IPv6 — without either reporting a conflict, so your plugin attaches to one while Claude talks to the other. | See which server has connections, then close the extra Claude session. **macOS/Linux:** `lsof -nP -i TCP:9223-9232` · **Windows:** `netstat -ano \| findstr :9223` |
| Connection drops and reconnects every ~30s | The plugin's `FILE_INFO` has a null `fileKey`, so the server never identifies it | Check `manifest.json` still has `"enablePrivatePluginApi": true` — `figma.fileKey` is a private API and doesn't work without it. Re-import after fixing. |
| Stuck on "Looking for your AI app…" | MCP server isn't running, or is on a port outside 9223–9232 | Start the server; confirm its port is in that range |
| "Something broke" in the plugin | Internal error | Close the plugin window and reopen it |
| `unresolved: ["Button/Primary"]` | Component name is wrong, or not in your registry | Fix the name — don't let Claude build a lookalike instead |
| `unresolved: ["var:spacing/md"]` | That variable doesn't exist in the file | Check your real variable names |
| `unresolved: ["font:…"]` | Font isn't available; it fell back to Inter | Install the font, or use one you have |
| `unresolved: ["mixedFont:…"]` | Text layer has mixed styling | Pass an explicit `font` in the patch to set one first |
| `failed` on a `patchSpec` op | Usually a stale or wrong node id | Re-read the current ids |

**Verify the plugin itself:** `node test-builder.js` — no dependencies, runs in a second, 31 assertions.

---

## What it actually saves

Measured on one build (an 18-node dashboard), comparing the spec against a hand-written
imperative equivalent. Character counts are exact; tokens are chars ÷ 4.

| Path | Spec | Equivalent | Saving |
|---|---|---|---|
| **Creating** something new | 2,029 ch | 2,930 ch (imperative API code) | **~30%** |
| **Reusing** a component | 325 ch | 1,116 ch (respecifying it) | **~70%** |

**Read this before quoting those numbers.** It's a single sample, and the same person wrote both
sides — the imperative baseline uses helper functions, which is fair but is also the choice that
sets the ratio. A sloppier baseline would "prove" a much bigger number. The reuse figure is the
more defensible one, because reusing a component beats respecifying it structurally, regardless
of how well the baseline was written.

Also: spec size is not session cost. Screenshots, results, and round trips dominate real usage.
Nobody should expect a 30% drop in their bill.

**Token savings only become money under metered/API billing.** On a fixed plan it's headroom
under your usage limits, not a smaller invoice.

The most useful number is your own. Measure it on your files.

---

## Status

- **Works end to end.** Verified in Figma: create, edit in place, promote a component, and build
  from the registry (`reused: 3, built: 1`).
- **Logic is covered by tests.** `test-builder.js` runs the real builder module against a mocked
  Figma API — 31 assertions across create, registry resolution, variable binding, edit, delete,
  and failure handling.
- **Not yet proven across real design systems.** The least-tested paths are **variant and
  instance-swap properties** and **mixed-font text layers**. If you use those, that's the most
  valuable thing you can report back.
- **This is a fork you now maintain.** Upstream updates mean re-applying the changes below by hand.

---

## For maintainers

### Files changed vs upstream

| File | Change |
|---|---|
| `code.js` | Added the builder module (`buildSpec`, `patchSpec`, `manifestSummary`, `setManifest`) before `figma.ui.onmessage`; added `BUILD_SPEC` / `PATCH_SPEC` / `MANIFEST_SUMMARY` branches after `EXECUTE_CODE` |
| `code.js` (upstream paths) | Fixed two `documentAccess: "dynamic-page"` violations inherited from upstream — `DEEP_GET_COMPONENT` and the `token-misuse` lint rule both used synchronous APIs that throw, inside swallowing `try`/`catch` blocks |
| `ui.html` | Added `window.buildSpec` / `patchSpec` / `manifestSummary` and matching `methodMap` entries |
| `manifest.json` | Renamed to `BetterBridge`, id `betterbridge-mcp`. **Nothing else.** |

> ⚠️ **`enablePrivatePluginApi: true` must stay in `manifest.json`.** It looks like dead config.
> It isn't — `figma.fileKey` is a private API, and without it the plugin sends a null `fileKey`,
> the server never identifies it, and the connection drops every 30 seconds. This was removed
> once as "unused cleanup" and cost hours.

### Spec reference

**buildSpec** node:
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
{ use: "Button/Primary", props: { label: "Add to cart" }, slots: { media: [ ...nodes ] } }
```

**buildSpec** top level:
```
{ at: {x, y}, parentId: "123:45", manifest: {...}, select: false, build: <node> }
```

**patchSpec** (array of ops):
```
[{ id: "123:45", remove?, name?, text?, font?, props?, fill?, stroke?, gap?, pad?, radius?, w?, h? }]
```

**manifestSummary**`(opts?)` — `{ allPages: true }` scans the whole file instead of the current
page. Returns `{ "Name": { nodeId, key, props? } }`.

### Included

- `code.js`, `ui.html`, `manifest.json` — the plugin
- `_builder-module.js` — the builder module in isolation (same content spliced into `code.js`;
  kept separate so it can be tested and re-diffed against a future upstream)
- `test-builder.js` — mock-Figma test suite; `node test-builder.js`
- `CLAUDE.md` — project rules that make Claude use this automatically
- `extract-compact.js` — read-side token reduction, paste as the body of a `figma_execute` call

---

> ⚠️ **Attribution / licensing.** BetterBridge is a fork of the Figma Desktop Bridge plugin from
> Southleft's `figma-console-mcp` project. Everything except the additions listed above is that
> project's code. Check its LICENSE before distributing this fork, and keep the attribution intact.
