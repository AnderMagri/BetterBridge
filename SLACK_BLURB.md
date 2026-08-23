# Slack blurb

Copy-paste ready. Long version for a channel post, short versions below.

---

## Channel post

> **Looking for a few volunteers to test two things** — a Figma bridge and a project workflow folder.
>
> **The problem.** When Claude builds UI in Figma, it pays tokens twice. It writes long, verbose Figma API code for every small change, and because it has no cheap way to see what already exists in your file, it rebuilds components from scratch instead of using the ones you've already made.
>
> **BetterBridge** is a fork of the MCP connector we already use. Instead of Claude writing walls of imperative code, it sends a short spec — "a column frame, this spacing, this fill, with a Button/Primary inside" — and the plugin does all the verbose work locally, where it costs zero model tokens. In one measured build that was **~30% fewer output tokens** on creating something new.
>
> **The bigger win is reuse.** If you point it at a **registry** — a list of the components that already exist in your file — Claude places a real *instance* of your component instead of rebuilding a lookalike out of frames and text. Same result, linked to your main component, and **~70% fewer tokens** than respecifying it. That gap grows the more mature your design system is.
>
> **The registry needs somewhere to live**, which is where the second piece comes in. Building on the idea Ed shared a couple of weeks ago, I put together a **project template folder** that holds:
>
> • the Figma component registry
> • an append-only decision log (who decided what, when, and why)
> • synthesized project context, so knowledge doesn't live only in chat history
> • reusable prompts for the recurring work — scope docs, UX audits, design exploration
>
> Point Cowork at a fresh copy and ask Claude to read the folder. It'll ask you the setup questions, and you're ready to work. When you hand the folder to someone else, they get a one-page `CONTEXT.md` — what the project is, what's decided, what's still open, and where the landmines are.
>
> **Honest status:** the logic is covered by 31 automated tests and I've run it end to end in Figma, but it hasn't been tried against a wide range of real design systems yet. **That's what I need volunteers for.** The numbers above come from a single build I measured myself — I'd much rather have yours.
>
> Most useful things to report back: anything that breaks, components with variant or instance-swap properties (the least-tested path), and whether the savings hold up on your files.
>
> ~10 minutes to set up, needs Figma Desktop 👉 https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md

---

## Short (busy channel)

> 🌉 Built **BetterBridge** — a Figma plugin that cuts the tokens Claude burns building UI. Instead of writing walls of Figma API code, Claude sends a short spec and the plugin expands it locally. Point it at a registry of your existing components and it places real instances instead of rebuilding lookalikes.
>
> Measured on one build: **~30% fewer output tokens creating, ~70% reusing.**
>
> Logic is well tested, real-world coverage isn't — **looking for a few testers.** ~10 min, needs Figma Desktop:
> https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md

---

## DM (one person, direct ask)

> Hey — got a Figma plugin I'd like a second pair of hands on. It cuts the tokens Claude burns building UI: it sends a compact spec instead of imperative API code, and places real instances of your existing components instead of rebuilding them. Measured ~30% fewer output tokens creating, ~70% reusing.
>
> It's tested against a mocked Figma API and works end to end, but not against many real design systems yet — yours would be a genuinely useful data point, especially if you use variant properties or slots. About 10 minutes, needs Figma Desktop:
> https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md
>
> Mostly I want to hear what breaks.

---

## Notes on the numbers — read before editing these

The **~30% / ~70%** figures come from **one** measured build: an 18-node dashboard, spec vs. a
hand-written imperative equivalent, character counts ÷ 4.

Two caveats to keep attached if anyone presses:

1. **The same person wrote both sides.** The imperative baseline uses helper functions — fair, but
   that choice is what sets the ratio. A sloppier baseline would "prove" a much bigger number.
2. **Spec size is not session cost.** Screenshots and round trips dominate real usage. Nobody
   should expect a 30% drop in their bill.

The reuse figure is the sturdier claim: placing an instance beats respecifying a component
structurally, however well the baseline is written.

Don't say "up to 30%" — it reads as a ceiling you rarely hit, when it's what was actually measured.
And **token savings only become money under metered/API billing**; on a fixed plan it's headroom
under usage limits.

Best framing for a rollout: ask people to measure it on their own files. Their numbers are worth
more than yours, and it turns a claim they might doubt into a task they can do.
