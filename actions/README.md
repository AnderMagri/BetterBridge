# Saved actions

Everything in this folder shows up under **Actions** in the BetterBridge plugin
window. The plugin reads it **live from GitHub**, so a change pushed here reaches
everyone the next time they open the sheet or click **Load**. No re-import is needed.
GitHub can take a few minutes to serve a new version.

There are two kinds of action.

| Kind | Lives in | What the sheet does | Uses Claude tokens? |
|---|---|---|---|
| **Recipe** | `recipes/*.json` | **Run** — the plugin applies it directly | **No** |
| **Prompt** | `prompts/*.md` | **Copy** — you paste it into Claude | Yes, but you don't have to rewrite the instructions |

Use a **recipe** for work that's the same every time, like creating tokens or
styles. Use a **prompt** for work that needs judgment, like building
components or reviewing a screen.

## Adding an action

1. Add the file to `recipes/` or `prompts/`. File names may only use letters,
   numbers, `.`, `_` and `-`.
2. List it in `index.json`:
   ```json
   { "id": "my-action", "kind": "recipe", "title": "Short name",
     "description": "One or two sentences shown in the menu.",
     "file": "recipes/my-action.json" }
   ```
3. Run `node test-builder.js`. It fails if an entry points at a missing file,
   and it runs every recipe in this folder against a mock Figma.
4. Push to the branch the plugin reads from (see below).

## Recipe format

Recipes are **data, not code**. The plugin only understands the three step
types below, so a recipe can't do anything else in someone's Figma file.

```json
{
  "id": "my-action",
  "title": "Short name",
  "steps": [
    { "do": "collection", "name": "Semantic", "modes": ["Light", "Dark"],
      "variables": [
        { "name": "color/text/primary", "type": "COLOR",
          "values": { "Light": "{color/gray/900}", "Dark": "{color/gray/50}" },
          "scopes": ["TEXT_FILL"], "description": "Headings and body text" }
      ] },
    { "do": "textStyles", "styles": [
        { "name": "Heading/H1", "font": "Inter/Bold", "size": 36, "lineHeight": 44, "letterSpacing": "-1%" }
      ] },
    { "do": "effectStyles", "styles": [
        { "name": "Shadow/Level-1", "shadows": [{ "x": 0, "y": 1, "blur": 2, "spread": 0, "color": "#0000000D" }] }
      ] }
  ]
}
```

- `"{name}"` makes the variable an alias of another variable. Use
  `"{Collection:name}"` if two collections share the name.
- `"value"` sets the same value in every mode; `"values"` sets one per mode.
- `"scopes": []` hides a variable from Figma's pickers. That's the right choice
  for primitives, so designers pick semantic tokens instead.
- **Running a recipe again is safe.** Anything that already exists (matched by
  name) is skipped, never overwritten. An existing collection is never given
  new modes. If its modes don't match, the menu reports it.

## Prompt format

Plain Markdown. The front matter (between the `---` lines) is for the menu and
isn't copied; everything after it is.

```markdown
---
id: my-prompt
title: Short name
description: One sentence.
---

The instructions for Claude…
```

## Which branch the plugin reads

`BB_ACTIONS_BASE` in `ui.html` sets the branch. It's `betterbridge-r4` while
this branch is being tested; change it to `main` when the branch merges.
