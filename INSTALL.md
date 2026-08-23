# Installing BetterBridge

**We're looking for testers.** BetterBridge works and has been run end to end, but it hasn't been
tried against a wide range of real design systems yet. That's what you'd be helping with — if
anything breaks or looks wrong, message me on Slack.

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

## Step 5 — Try it in a scratch file first

Open a **new, empty Figma file** — not real work — and ask Claude for something simple:

> Using BetterBridge, build me a test card in Figma.

If a card appears on your canvas, you're installed. Keep using a scratch file until you're
comfortable with it.

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

## Honest status

- **Works end to end.** Verified in Figma: create, edit in place, promote a component, and build
  from the registry. `test-builder.js` covers the logic separately — 31 assertions against a
  mocked Figma API, runnable with `node test-builder.js` (no dependencies).
- **You are among the first to install it from these instructions.** The plugin has been run
  properly; the written install path has not been walked start to finish by anyone else. If a
  step is wrong or missing, that's worth knowing.
- **Least-tested paths, if you want to point it somewhere useful:** components with **variant or
  instance-swap properties**, and **mixed-font text layers**. Today's testing used primitives and
  one promoted component in an empty file — your real design system is the interesting case.
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

---

**Something broken, confusing, or just weird? Send me a message on Slack.** Paste the exact
`unresolved` / `failed` output if there is any — it's written to be diagnostic.
