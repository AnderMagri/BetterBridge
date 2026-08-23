# Slack blurb

Copy-paste ready. Short version first, longer version if you want the detail.

---

## Short (for a channel post)

> 🌉 **BetterBridge — looking for a few testers**
>
> **The problem:** when Claude builds UI in Figma, it pays tokens twice. It
> writes long imperative Figma API code for every little change, and because it
> has no cheap way to see what already exists in your file, it rebuilds
> components from scratch instead of using yours.
>
> **What it does:** Claude sends a short spec — "a column frame, `spacing/md`
> gap, `color/surface/card` fill, with a `Button/Primary` inside" — and the
> plugin does all the verbose work (font loading, variable binding, instance
> creation) locally, where it costs zero model tokens. `{ use: "Button/Primary" }`
> pulls your real component instead of a lookalike. And it can now *edit*
> existing nodes in place, which is what most real work actually is.
>
> **What it saves:** ~75–80% fewer output tokens on the create path, measured
> on one representative build. Reuse and in-place edits add more on top across a
> session of revisions. Worth saying plainly: on a fixed Claude plan this buys
> you headroom under your usage limits, not a smaller invoice — it's only a
> dollar saving under metered/API billing.
>
> **The catch:** the logic is covered by 31 tests against a mocked Figma API,
> but it hasn't been run against a wide range of real design systems yet.
> That's what I need testers for. ~10 min to install, Figma Desktop required.
>
> Install guide 👉 https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md
>
> Ping me if you hit anything weird — especially if you use variant properties
> or instance-swap slots, which are the least-tested paths.

---

## Shorter (if the channel is busy)

> 🌉 Built **BetterBridge** — a Figma plugin that cuts how many tokens Claude
> burns building UI. Instead of writing walls of Figma API code, Claude sends a
> short spec and the plugin expands it locally; it also reuses your real
> components instead of rebuilding lookalikes, and can edit existing layers in
> place. ~75–80% fewer output tokens on the create path in my testing.
>
> Logic is well tested, real-world coverage isn't — **looking for a few
> testers.** ~10 min, needs Figma Desktop:
> https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md

---

## DM version (one person, direct ask)

> Hey — got a Figma plugin I'd like a second pair of hands on. It cuts the
> tokens Claude burns building UI (sends a compact spec instead of imperative
> API code, and reuses real components instead of rebuilding them). Measured
> ~75–80% fewer output tokens on the create path.
>
> It's tested against a mocked Figma API but not against many real design
> systems yet — yours would be a genuinely useful data point, especially if you
> use variant properties or slots. About 10 minutes, needs Figma Desktop:
> https://github.com/AnderMagri/BetterBridge/blob/main/INSTALL.md
>
> Mostly I want to hear what breaks.

---

### Notes on the numbers

Keep the caveats attached when you share this. The 75–80% figure is from **one**
product-card build, spec vs. hand-written equivalent — it's a real measurement,
not a projection, but it's a sample of one. The honest framing for anyone
estimating impact is their own multiplier:

**(tokens saved per build) × (builds per week) × (your billing rate or plan headroom)**
