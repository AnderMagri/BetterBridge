---
id: create-ds
title: Build the design system page
description: After "Create DS foundation" has run, Claude builds a Design System page with color and type specimens plus core components (Button, Input, Card), then writes the registry.
---

Build the design system for this Figma file with BetterBridge, following the
project's CLAUDE.md rules (buildSpec / patchSpec, registry first, tokens and
styles instead of raw values).

## 1. Check the foundation — don't recreate it

Call `designSystem()`.

- If `connected` is false, or it has no semantic color tokens or text styles,
  **stop** and tell me to run **Actions → Create DS foundation** in the
  BetterBridge plugin window first. That recipe creates every token and style
  without using any tokens on your side. Don't create variables or styles
  yourself.
- Otherwise call `designSystem({ list: true })` once and keep the names for the
  rest of this task.

## 2. Page and sections

Use or create a page named `Design System` (check that it exists before
creating it). Create these sections on it, in this order and left to right:
`Colours`, `Typography`, `Buttons`, `Inputs`, `Cards`.

## 3. Foundation specimens

In one `figma_execute` call:

- **Colours:** one swatch per semantic color token (not primitives). Each
  swatch is a 160×hug column with a 160×64 rectangle filled with the token and a
  `Caption/XS/Regular` label with the token name. Group by `surface`, `text`,
  `border`, `action`, `feedback`.
- **Typography:** one row per text style showing the style name in
  `Caption/XS/Regular` and a sample sentence in that style.

## 4. Core components

Build each inside its section with `buildSpec`, then promote it to a real
component and combine variants into a component set.

- **Button** — variants `Variant=Primary|Secondary`, `State=Default|Hover|Disabled`.
  Row layout, pad `spacing/sm` / `spacing/md`, radius `radius/md`, label
  `Body/MD/SemiBold`. Primary fills `color/action/primary/default` (hover:
  `…/hover`) with `color/text/on-action` text. Secondary is
  `color/surface/default` with a `color/border/default` stroke.
- **Input** — `State=Default|Focus|Error|Disabled`. Label, field, helper text.
  Field: pad `spacing/sm`, radius `radius/md`, stroke `color/border/default`
  (error: `color/feedback/danger/default`).
- **Card** — column, pad `spacing/lg`, gap `spacing/md`, radius `radius/lg`,
  fill `color/surface/default`, effect `Shadow/Level-1`, title
  `Heading/H4`, body `Body/SM/Regular`, and a Button instance.

Name every layer. Use only tokens and styles. If one is missing, tell me which
instead of using a raw value.

## 5. Registry

Run `manifestSummary()` on the Design System page and write the result to
`figma.manifest.json` under `components`.

## 6. Report back

Keep the report short: what was created, one screenshot of the page, and
anything that came back in `unresolved`.
