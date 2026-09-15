# Saved actions

Everything in this folder shows up under **Actions** in the BetterBridge plugin
window. The plugin reads it **live from GitHub**, so a change pushed here reaches
everyone the next time they open the sheet or click **Load**. No re-import is needed.
GitHub can take a few minutes to serve a new version.

Every action is a **recipe**: a JSON file in `recipes/` that the plugin applies
itself when you click **Run**. Claude isn't involved, so **no tokens are used**.
That makes recipes right for work that's the same every time: tokens, styles,
specimen pages, standard components. Work that needs judgment, like designing a
screen, is a conversation with Claude, not a saved action.

## Adding an action

1. Add the file to `recipes/`. File names may only use letters, numbers, `.`,
   `_` and `-`.
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

Recipes are **data, not code**. The plugin only understands the step types
below, so a recipe can't do anything else in someone's Figma file.

### Foundation steps: tokens and styles

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

### Page steps: building on a foundation

Everything these steps draw goes through `buildSpec`, so it uses token and style
names and follows "DS only" exactly like Claude's builds. See
[`recipes/create-ds-page.json`](recipes/create-ds-page.json) for a full example.

| Step | What it does |
|---|---|
| `{ "do": "require", "collections": [...], "textStyles": [...], "effectStyles": [...], "message": "..." }` | Stops the recipe with `message` if anything listed is missing. Put it first. |
| `{ "do": "page", "name": "Design System" }` | Finds or creates the page, and opens it |
| `{ "do": "section", "name": "Buttons" }` | Finds or creates a section; new ones are placed left to right |
| `{ "do": "build", "in": "Buttons", "build": { …buildSpec node… } }` | Builds a node into the section |
| `{ "do": "component", "in": "Cards", "build": { "name": "Card", … } }` | The same, turned into a component |
| `{ "do": "componentSet", "in": "Buttons", "name": "Button", "textProps": { "Label": "Label" }, "variants": [{ "props": { "Variant": "Primary", "State": "Default" }, "build": { … } }] }` | One component per variant, combined into a set. `textProps` maps a text property to the text layer it edits in every variant |
| `{ "do": "colorSwatches", "in": "Colors", "collection": "Semantic", "chrome": { … } }` | One swatch per color variable in the collection, grouped by name |
| `{ "do": "typeSpecimens", "in": "Typography", "sample": "…", "chrome": { … } }` | One sample per local text style |

`chrome` holds the token and style names used for the specimen frames and labels
(`fill`, `gap`, `pad`, `radius`, `innerGap`, `labelGap`, `swatchRadius`,
`swatchStroke`, `titleStyle`, `titleColor`, `labelStyle`, `labelColor`).

**Running it again is safe.** Anything already in a section with the same name is skipped.

## Which branch the plugin reads

`BB_ACTIONS_BASE` in `ui.html` sets the branch. It's `betterbridge-r4` while
this branch is being tested; change it to `main` when the branch merges.
