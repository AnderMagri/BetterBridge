# Installing BetterBridge

**We're looking for testers.** BetterBridge works and its logic is covered by
tests, but it has not yet been exercised against a wide range of real design
systems. If you install it, please read [What to report back](#what-to-report-back)
at the bottom — that's the part we actually need from you.

Takes about 10 minutes. You need **Figma Desktop** (browser Figma cannot load
development plugins) and whatever machine you already run Claude Code on.

**Windows, macOS, and Linux all work.** The plugin runs inside Figma and the server is Node, so
neither is platform-specific. Only a couple of commands differ, and both versions are given where
they come up. Everything below was tested on macOS — if something reads as Mac-only on Windows,
that's a docs bug worth reporting.

---

## What you're installing

BetterBridge is the **Figma plugin half** of an AI-assisted Figma workflow. It
adds three functions Claude can call — `buildSpec`, `patchSpec`, and
`manifestSummary` — so Claude sends a small description of what it wants
instead of a wall of imperative Figma API code, and reuses your real
components instead of rebuilding lookalikes.

There are two pieces, and you need both:

| Piece | What it is | Where it comes from |
|---|---|---|
| **MCP server** | Runs on your machine, connects Claude to Figma | The `figma-console-mcp` npm package (Step 1) |
| **BetterBridge plugin** | Runs inside Figma Desktop | **This repo** — https://github.com/AnderMagri/BetterBridge |

> ⚠️ **Install the plugin from this repo, and nothing else.** The server ships
> its own bundled plugin with a nearly identical name. If you run that one it
> will connect happily and then `buildSpec` won't exist — which reads as a bug
> in BetterBridge when it's really the wrong plugin. Don't install both.

---

## Step 1 — Get the MCP server running

Register it with Claude Code:

```bash
claude mcp add figma-console-mcp -- npx -y figma-console-mcp@latest
```

You're done with this step when Claude Code can see the Figma tools (a
`figma_execute` tool, among others).

Already running it? Skip this — BetterBridge needs **no server changes**,
you're only swapping the plugin.

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

It appears in your plugin list as **BetterBridge**. If you previously imported
the server's bundled plugin, remove it — keeping both is the single most
common way to end up debugging the wrong one.

## Step 4 — Run it and confirm the connection

Open any Figma file → **Plugins → Development → BetterBridge**.

A small strip appears. You want:

> 🟢 **Connected — AI can work in this file**

If it's stuck on **"Looking for your AI app…"**, the plugin can't find the MCP
server — see [Troubleshooting](#troubleshooting).

## Step 5 — Check it works

Open a **scratch Figma file** — not real work — and ask Claude in plain English:

> Using BetterBridge, build me a test card in Figma: a grey rounded box with
> "Hello BetterBridge" inside it.

A card should appear on your canvas. Then:

> Now change that text to "It works" — edit it in place, don't rebuild it.

The text should change without the card being recreated. That's the install verified.

**You never type code for any of this.** `buildSpec` and `patchSpec` are what Claude calls under
the hood — you just describe what you want. If Claude reports `buildSpec is not defined`, it's
running the wrong plugin; see [Troubleshooting](#troubleshooting).

## Step 6 — Point it at a project

**Copy `CLAUDE.md` into your project folder.** That single file is what makes Claude reach for
BetterBridge automatically instead of hand-writing Figma code out of habit. Without it, you'd have
to remember to ask every time.

Then, once your Figma file has components worth reusing, ask:

> Scan this Figma file and set up the component registry.

Claude builds the registry file for you and loads it at the start of each session. From then on it
places real instances of your components instead of rebuilding lookalikes.

**No components yet?** Nothing to do. It falls back to matching component names on the current
page, so it works from day one and gets better as your system grows.

> Using the project template folder? The registry already has a home there
> (`artefacts/design-system/figma.manifest.json`) and its setup prompt handles this step for you.

*Curious what the registry file actually looks like, or want to write one by hand? Format and
details are in [Using it on a project](README.md#using-it-on-a-project).*

---

## Troubleshooting

Full table — install problems and usage errors both — is in the
**[README troubleshooting section](README.md#troubleshooting)**. Kept in one place so the two
docs can't drift apart.

The three that catch almost everyone:

- **`buildSpec is not defined`** → you're running the server's bundled plugin, not BetterBridge.
- **Your edits do nothing** → Figma caches plugin code. Re-import the manifest; if that fails,
  quit Figma completely (⌘Q on macOS, close every window on Windows) and reopen.
- **Reconnects every ~30s** → `manifest.json` is missing `"enablePrivatePluginApi": true`.

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
- **Measured savings: ~30% on creating, ~70% on reusing a component** — one 18-node build,
  spec vs. hand-written imperative equivalent, character counts ÷ 4. Single sample, and the same
  person wrote both sides. See [What it actually saves](README.md#what-it-actually-saves) for the
  caveats that matter. Your own numbers on your own files are worth more than mine.
- **Token savings only become dollar savings under metered/API billing.** On a
  fixed Claude plan, this shows up as more headroom under your usage limits,
  not a smaller bill.
- **This is a fork, maintained by us.** Upstream updates mean re-applying our
  changes by hand. The diff is deliberately small — see
  [Files changed vs upstream](README.md#files-changed-vs-upstream).
- **Read-side discipline is separate.** One careless whole-page read can cost
  more tokens than a week of `buildSpec` calls saves. See `extract-compact.js`
  and the read-side rules in `CLAUDE.md`.
