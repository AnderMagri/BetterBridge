# Installing BetterBridge

**We're looking for testers.** BetterBridge works and its logic is covered by
tests, but it has not yet been exercised against a wide range of real design
systems. If you install it, please read [What to report back](#what-to-report-back)
at the bottom — that's the part we actually need from you.

Takes about 10 minutes. You need **Figma Desktop** (browser Figma cannot load
development plugins) and whatever machine you already run Claude Code on.

---

## What you're installing

BetterBridge is the **Figma plugin half** of an AI-assisted Figma workflow. It
is a fork of Southleft's [Figma Desktop Bridge](https://github.com/southleft/figma-console-mcp)
that adds three functions Claude can call — `buildSpec`, `patchSpec`, and
`manifestSummary` — so Claude sends a small description of what it wants
instead of a wall of imperative Figma API code, and reuses your real
components instead of rebuilding lookalikes.

There are two pieces, and you need both:

| Piece | What it is | Where it comes from |
|---|---|---|
| **MCP server** | Runs on your machine, connects Claude to Figma | Upstream — [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp) |
| **BetterBridge plugin** | Runs inside Figma Desktop | This repo |

BetterBridge needs **no server changes**. If you already run the upstream
Desktop Bridge, you already have the server half — you're only swapping the
plugin.

---

## Step 1 — Get the MCP server running

Follow the setup instructions in
[southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp).
We deliberately don't duplicate them here, because they're upstream's to
change.

You're done with this step when Claude Code can see the Figma tools (a
`figma_execute` tool, among others).

## Step 2 — Get this repo

```bash
git clone https://github.com/AnderMagri/BetterBridge.git
```

Put it somewhere permanent. Figma loads the plugin from this folder every
time, so if you move or delete it, the plugin breaks.

## Step 3 — Import the plugin into Figma

1. Open **Figma Desktop** (not the browser — development plugins don't exist there)
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` from the folder you just cloned

It appears in your plugin list as **BetterBridge**, separate from the original
Desktop Bridge. Both can be installed at once, which is the easy way to
A/B them.

## Step 4 — Run it and confirm the connection

Open any Figma file → **Plugins → Development → BetterBridge**.

A small strip appears. You want:

> 🟢 **Connected — AI can work in this file**

If it's stuck on **"Looking for your AI app…"**, the plugin can't find the MCP
server — see [Troubleshooting](#troubleshooting).

## Step 5 — Prove it actually works

**Do this in a throwaway file, not production work.** Ask Claude Code to run
each of these. The full seven-step version is in the
[README validation checklist](README.md#before-you-install-validate-it);
this is the two-minute version.

**Create something:**

```js
return await buildSpec({ build: {
  type: "frame", name: "Test Card", layout: "col", gap: 16, pad: 16,
  radius: 8, fill: "#eeeeee", w: 280, h: "hug",
  children: [{ type: "text", text: "Hello BetterBridge", size: 16 }]
}});
```

A grey rounded card should appear on canvas. The result gives you back its
node id.

**Edit what you just made** (use the id from above):

```js
return await patchSpec([
  { id: "PASTE_ID_HERE", text: "Edited in place" }
]);
```

The text should change without the frame being rebuilt.

**Snapshot your components:**

```js
return await manifestSummary();
```

You should get back a compact `{ "Name": { nodeId, key, props } }` object for
components on the current page.

If all three work, you're installed.

## Step 6 — Set it up for a real project

Two files make Claude use this automatically instead of only when you
remember to ask:

1. **Copy `CLAUDE.md` into your project root.** This is the part that changes
   Claude's default behaviour — without it, Claude will keep hand-writing
   imperative Figma code out of habit.
2. **Create `figma.manifest.json` in your project** — the component registry
   that makes `{ use: "Button/Primary" }` resolve to your real component.
   Don't hand-write it: run `manifestSummary()` and paste the result into
   `components`.

   ```json
   {
     "components": {
       "Button/Primary": {
         "nodeId": "1:234",
         "key": null,
         "props": ["label", "State"]
       }
     }
   }
   ```

   `nodeId` works for local components in the current file; `key` is for
   library-published components and survives across files. Only add a
   component once it's stable — otherwise you re-map it every iteration.

Then at the start of a session, have Claude call:

```js
return globalThis.setManifest({ /* your components */ })
```

No registry? It still works — it falls back to matching component names on the
current page.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Stuck on "Looking for your AI app…" | MCP server isn't running, or is on a port outside 9223–9232 | Start the server; confirm its port is in that range |
| "Something broke" | Plugin hit an internal error | Close the plugin window and reopen it |
| Your `code.js` / `ui.html` edits do nothing | **Figma caches plugin code at the application level** | **Re-import the manifest.** Restarting the plugin is not enough. This one catches everybody. |
| `unresolved: ["Button/Primary"]` | Component name is wrong or not in your registry | Fix the name — don't let Claude build a lookalike instead |
| `unresolved: ["var:spacing/md"]` | That variable name doesn't exist in the file | Check your real variable names |
| `unresolved: ["font:…"]` | Font isn't available; it fell back to Inter | Install the font, or specify one you have |
| `failed` on a `patchSpec` op | Usually a stale or wrong node id | Re-read the current ids |

Nothing is ever silently faked — if it can't resolve something, it tells you.
That's the design. Report the `unresolved` list rather than working around it.

---

## What to report back

This is why we're asking you to install it. Ranked by how much it helps:

1. **Anything that broke, with the exact `unresolved` / `failed` output.** That
   output is designed to be diagnostic — paste it verbatim.
2. **Components with variant or instance-swap properties.** This is the
   least-tested path. If your design system uses `State=Hover`-style variants
   or slots for nested components, tell us whether `props` and `slots`
   actually applied.
3. **Mixed-font text layers.** `patchSpec` should surface these as
   `mixedFont:…` and ask for an explicit `font` rather than crashing. Confirm
   it does.
4. **Whether the savings are real for you.** The measured figure below comes
   from one representative build. Your design system is not that build. If
   your numbers are worse, that's the most useful thing you can tell us.

Open an issue at
[github.com/AnderMagri/BetterBridge/issues](https://github.com/AnderMagri/BetterBridge/issues)
or just message me directly.

---

## Honest status

- **Validated by logic tests, not by live Figma.** `test-builder.js` runs the
  real builder module against a mocked Figma Plugin API — 31 assertions
  covering creation, registry resolution, variable binding, editing, deletion,
  and failure handling. Run it yourself with `node test-builder.js` (no
  dependencies, no install). What it *cannot* check is real font availability,
  real auto-layout rendering, or real variable-mode resolution. Only Figma can.
  That's exactly the gap testers close.
- **Measured savings: roughly 75–80% fewer output tokens on the create path**,
  on one product-card build, spec vs. hand-written equivalent. Registry reuse
  and the edit path add more on top across a session of revisions.
- **Token savings only become dollar savings under metered/API billing.** On a
  fixed Claude plan, this shows up as more headroom under your usage limits,
  not a smaller bill.
- **This is a fork, maintained by us.** Upstream updates mean re-applying our
  changes by hand. The diff is deliberately small — see
  [Files changed vs upstream](README.md#files-changed-vs-upstream).
- **Read-side discipline is separate.** One careless whole-page read can cost
  more tokens than a week of `buildSpec` calls saves. See `extract-compact.js`
  and the read-side rules in `CLAUDE.md`.
