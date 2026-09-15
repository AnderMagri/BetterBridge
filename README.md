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

### Four functions

| Function | What it's for |
|---|---|
| `buildSpec()` | Create something new |
| `patchSpec()` | Change something that already exists, in place |
| `manifestSummary()` | List the components in your file, to build a registry |
| `designSystem()` | Check which design system this file is connected to |

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

That includes smaller things that used to disappear quietly: a misspelled field (`padding`
instead of `pad`), `w: "fill"` inside a frame without auto layout, content aimed at a slot that
doesn't exist. And if a build crashes halfway, the half-built frame is removed instead of left
on your canvas. Pass `atomic: true` to remove a build that has *any* unresolved entry.

---

## Using your design system

Use **token and style names instead of raw values** and BetterBridge binds the real thing:

```js
buildSpec({ build: {
  type: "frame", layout: "col", gap: "spacing/md", fill: "color/surface/card", effect: "Shadow/Card",
  children: [{ type: "text", text: "Golf Balls — Dozen", textStyle: "Heading/H3" }]
}})
```

- **Tokens** (`fill`, `stroke`, `gap`, `pad`, `radius`) come from this file's variables **or any
  library enabled for the file**. Library tokens are imported automatically.
- **Styles:** `textStyle` and `effect` take style names. `fill`/`stroke` fall back to a paint
  style when no colour token has that name.
- **Same name twice?** It's reported as `ambiguous:` instead of guessed. Prefix the collection or
  library: `"Semantic:color/primary"`. A variable in this file beats a library one with the same name.

### The plugin window

From top to bottom:

1. **Status and Actions.** Whether an AI app is connected, with **Pause** and **Actions**.
2. **▸ N connections.** Click the arrow to list each connected MCP server: its port, version,
   when it started, and when it last sent a command. The most recently used one is marked
   **in use**; one with no recent commands is usually left over from an old session. (The
   server doesn't tell the plugin which app or project started it, so that can't be shown.)
3. **Sources**, below a divider — what the bridge builds from:
   - **Design system.** **■ DS: Acme Design System** (tokens from an enabled library),
     **□ DS: this file** (this file's own tokens and styles), or **No design system**. Counts
     underneath; click the name to re-check. The **DS only** toggle is described below.
   - **Icons.** Open your icon library file and click **Connect**. The plugin saves that
     file's icon components for you, and from then on Claude can place them in **any** file
     with `{ icon: "arrow-right" }`. Icons are components on a page whose name contains
     "icon", or components named `Icon/…`. The library must be published for other files to
     import them. **Disconnect** forgets the set.

### Saved actions

**Actions** opens a bottom sheet of saved actions, read live from the
[`actions/`](actions/) folder on GitHub. Each row is the action's name, then:

- **Run** — a recipe the plugin applies itself. **Claude isn't involved, so it uses no tokens.**
  For example, **Create DS foundation** sets up Primitives, Semantic (Light/Dark) and
  Dimensions tokens, 10 text styles and 5 shadows in one click.
- **Copy** — a saved prompt. Paste it into Claude. For example, **Build the DS page** builds
  specimens and core components on top of the foundation.
- **×** — removes it from your list (just for you).

**Load**, at the bottom, fetches the list from GitHub again and brings back anything you
removed. **Activity** opens the log. Hover a name for its description. To add your own actions,
see [actions/README.md](actions/README.md).

> Cloud pairing is hidden in BetterBridge, and a stored pairing no longer
> reconnects in the background. Claude and Figma on the same machine don't need it.

> The plugin API can't see libraries that publish **only styles or components** (no tokens).
> List those in `figma.manifest.json` — see [Using it on a project](#using-it-on-a-project).

### "DS only" (strict mode)

When a design system is found, the **DS only** toggle appears, and it's **on by default**. While
it's on, raw hex colours and raw spacing/radius numbers are **refused, not applied**, and come
back as `strict:` entries so Claude swaps in a token. Text without a `textStyle` is flagged too.
`0` is always allowed.

Turn it off in the plugin window when you need raw values (say your system has no radius tokens).
Raw values then apply but are listed in `offSystem`, so you can still see what's off-system.
A spec can switch strict mode **on** (`strict: true`) but never off. Only the toggle can do that.

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

**Library styles** need a `styles` section, because the plugin API can't list them. Open the
library file itself, run `designSystem({ list: true })`, and copy the style entries you want:

```json
{
  "components": { "...": "..." },
  "styles": {
    "Heading/H1": { "type": "TEXT", "key": "4f1c…" },
    "Shadow/Card": { "type": "EFFECT", "key": "9ab2…" }
  }
}
```

Pass the whole file to `setManifest` — it accepts `{ components, styles }` or, as before, a bare
components map.

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
| `unresolved: ["var:spacing/md"]` | No variable with that name in the file or its enabled libraries | Check real names with `designSystem({ list: true })` |
| `unresolved: ["ambiguous:…"]` | Two collections or libraries share that token name | Prefix one: `"Semantic:color/primary"` |
| `unresolved: ["varType:…"]` | Right name, wrong kind (a number token used as a colour) | Use a token of the right type |
| `unresolved: ["strict:…"]` | "DS only" is on and a raw value was refused | Use a token or style — or switch "DS only" off in the plugin window |
| `unresolved: ["field:…"]` | A field is misspelled, or doesn't apply to that node | Fix the field name, or add the layout it needs |
| `unresolved: ["size:…"]` | `hug` without auto layout, or `fill` without an auto-layout parent | Add `layout`, or use a number |
| `unresolved: ["slot:…"]` | That slot name doesn't exist (the real ones are listed) | Use one of the listed names |
| `unresolved: ["font:…"]` | Font isn't available; it fell back to Inter | Install the font, or use one you have |
| `unresolved: ["mixedFont:…"]` | Text had mixed styling; it was changed, but that styling may be lost | Pass `font` or `textStyle` to choose one on purpose |
| Actions menu: **Couldn't load saved actions: HTTP 404** | The branch in `BB_ACTIONS_BASE` (ui.html) hasn't been pushed, or was merged and deleted | Push the branch, or point `BB_ACTIONS_BASE` at `main` and re-import |
| Actions menu: **Failed to fetch** | The plugin was imported before r4, so GitHub isn't in its allowed network domains | Re-import `manifest.json` |
| Actions menu: an edit you pushed doesn't show up | GitHub serves raw files from a cache for a few minutes | Wait, then click **Load** |
| Icons: **No icons found in this file** | Icons aren't on a page named "…icon…", and aren't named `Icon/…` | Rename the page or the components, then Connect again |
| `unresolved: ["icon:… could not be imported"]` | The icon library isn't published, or you don't have access to it | Publish the library, or build in the library file itself |
| Design-system line says **No design system found** but a library is enabled | The library publishes only styles/components, or it was enabled after the check | Click the line to re-check; list style-only libraries in the manifest |
| `failed` on a `patchSpec` op | Usually a stale or wrong node id | Re-read the current ids |

**Verify the plugin itself:** `node test-builder.js` — no dependencies, runs in a second, 118 assertions.

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
  Figma API — 118 assertions across create, registry resolution, variable binding, library tokens,
  styles, icon sources, strict mode, edit, delete, failure handling, and saved-action recipes (including the
  real recipes in `actions/`). It also checks that `code.js` ships the exact modules the tests ran.
- **Not yet proven across real design systems.** The least-tested paths are **variant and
  instance-swap properties**, **mixed-font text layers**, and **everything new in r3 and r4** —
  library tokens, styles, strict mode, the Sources section (design system and icons), and saved actions are tested
  against a mock only and have not yet been run in real Figma. If you use those, that's the most
  valuable thing you can report back.
- **This is a fork you now maintain.** Upstream updates mean re-applying the changes below by hand.

---

## For maintainers

### Files changed vs upstream

| File | Change |
|---|---|
| `code.js` | Added the builder module (`buildSpec`, `patchSpec`, `manifestSummary`, `setManifest`, `designSystem`) before `figma.ui.onmessage`; added the design-system status glue right after it (`BB_DS_STATUS`, strict mode in `clientStorage` under `bbStrict`); added `BUILD_SPEC` / `PATCH_SPEC` / `MANIFEST_SUMMARY` / `DESIGN_SYSTEM` / `BB_DS_REFRESH` / `BB_SET_STRICT` branches after `EXECUTE_CODE`; one line in the `documentchange` listener re-checks the design system on style changes |
| `code.js` (upstream paths) | Fixed two `documentAccess: "dynamic-page"` violations inherited from upstream — `DEEP_GET_COMPONENT` and the `token-misuse` lint rule both used synchronous APIs that throw, inside swallowing `try`/`catch` blocks |
| `code.js` (r4) | Added the recipe module (`runRecipe`) after the builder module, and a `BB_RUN_RECIPE` branch |
| `ui.html` | Added `window.buildSpec` / `patchSpec` / `manifestSummary` / `designSystem`, matching `methodMap` entries, their `*_RESULT` cases (without them a direct command never resolved), and the design-system line with its "DS only" toggle |
| `ui.html` (r4) | Layout: everything but the sheet sits in `#bb-main`; more spacing (body padding, `.wrap` gap). Cloud icon and pairing rows hidden (`.bb-hidden`), and `CLOUD_CONFIG_RESTORED` no longer auto-dials (`BB_CLOUD_PAIRING = false`). `renderStatusMeta` now renders a collapsible connections list; `attachWsHandlers` records `lastCommandAt` per connection. Sources section (design system, icons). The `+` button became **Actions**, and the upstream `sub-toolbar` row is now a bottom sheet (name · Run/Copy · remove, Load and Activity at the bottom). `BB_ACTIONS_BASE` sets the GitHub branch actions are read from |
| `code.js` (r4, icons) | Per-user `clientStorage` keys `bbIconSource` and `bbHiddenActions`; `BB_ICONS_CONNECT` / `BB_ICONS_DISCONNECT` / `BB_SET_HIDDEN_ACTIONS` branches |
| `manifest.json` | Renamed to `BetterBridge`, id `betterbridge-mcp`. r4 adds `https://raw.githubusercontent.com` to both network domain lists, for saved actions |

> ⚠️ **`PLUGIN_VERSION` in `code.js` must stay a plain `X.Y.Z`.** The server parses it with a
> naive `split('.')` that returns `null` on anything longer, then falls back to string inequality
> — so a fork suffix like `1.39.0-betterbridge.2` pins the "Plugin update available" banner
> permanently on. Our fork revision lives in `BETTERBRIDGE_VERSION` instead. Bump `PLUGIN_VERSION`
> only when re-syncing with a newer upstream plugin; that keeps the banner meaningful as a signal
> that upstream's plugin files have moved on.

> ⚠️ **`enablePrivatePluginApi: true` must stay in `manifest.json`.** It looks like dead config.
> It isn't — `figma.fileKey` is a private API, and without it the plugin sends a null `fileKey`,
> the server never identifies it, and the connection drops every 30 seconds. This was removed
> once as "unused cleanup" and cost hours.

### Spec reference

**buildSpec** node:
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

**buildSpec** registry instance:
```
{ use: "Button/Primary", props: { label: "Add to cart" }, slots: { media: [ ...nodes ] } }
```

**buildSpec** top level:
```
{ at: {x, y}, parentId: "123:45", manifest: {...}, select: false,
  strict: true,    // force strict on for this build (can't force it off)
  atomic: true,    // any unresolved entry removes the whole build
  build: <node> }
```
Returns `{ id, name, w, h, reused, built, unresolved?, offSystem? }`, or
`{ removed: true, unresolved }` for an atomic build that missed.

**patchSpec** (array of ops, optional `{ strict: true }` second argument):
```
[{ id: "123:45", remove?, name?, text?, font?, textStyle?, props?, fill?, stroke?, effect?,
   gap?, pad?, radius?, w?, h? }]
```

**buildSpec** icon node: `{ icon: "arrow-right", name?, w?, h? }` — an instance from the connected icon set.

**findIcons**`(query, limit = 20)` — `{ connected, set, total, icons: [names] }`. Searches the connected
set without returning all of it.

**designSystem**`(opts?)` — `{ connected, source: "library|local|none", libraries, tokens: {local, library},
styles: {paint, text, effect}, registry, strict, icons: {connected, name, count} }`. `{ list: true }` adds every token name (grouped by
collection) and style name with its key. `{ refresh: true }` re-reads enabled libraries first
(they're otherwise cached for 5 minutes).

**manifestSummary**`(opts?)` — `{ allPages: true }` scans the whole file instead of the current
page. Returns `{ "Name": { nodeId, key, props? } }`.

### Included

- `code.js`, `ui.html`, `manifest.json` — the plugin
- `_builder-module.js` — the builder module in isolation (same content spliced into `code.js`;
  kept separate so it can be tested and re-diffed against a future upstream)
- `_recipe-module.js` — the recipe runner, same arrangement
- `actions/` — saved actions the plugin menu reads from GitHub
- `test-builder.js` — mock-Figma test suite; `node test-builder.js`
- `CLAUDE.md` — project rules that make Claude use this automatically
- `extract-compact.js` — read-side token reduction, paste as the body of a `figma_execute` call

---

> ⚠️ **Attribution / licensing.** BetterBridge is a fork of the Figma Desktop Bridge plugin from
> Southleft's `figma-console-mcp` project. Everything except the additions listed above is that
> project's code. Check its LICENSE before distributing this fork, and keep the attribution intact.
