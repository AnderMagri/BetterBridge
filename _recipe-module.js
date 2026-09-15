// ============================================================================
// BETTERBRIDGE RECIPE MODULE
// ----------------------------------------------------------------------------
//   runRecipe(recipe) — apply a saved recipe (actions/recipes/*.json)
//
// Recipes are DATA, not code. Only the step types below exist, so a recipe
// loaded from GitHub can create collections, variables and styles — it can't
// run arbitrary code in anyone's Figma.
//
// Re-running is safe: collections are matched by name and reused; variables
// and styles that already exist (by name) are left untouched and counted as
// skipped, so nobody's edits get overwritten. An existing collection is never
// given new modes — a mismatch is reported instead.
//
// Steps:
//   { do: "collection", name, modes: ["Light", "Dark"],
//     variables: [{ name, type: "COLOR|FLOAT|STRING|BOOLEAN",
//                   value | values: { <mode>: v }, scopes?, description? }] }
//       a value of "{other/variable}" (or "{Collection:other/variable}") is an alias
//   { do: "textStyles", styles: [{ name, font: "Inter/Bold", size,
//                                  lineHeight?: px | "150%" | "auto",
//                                  letterSpacing?: px | "-1%" }] }
//   { do: "effectStyles", styles: [{ name, shadows: [{ x, y, blur, spread, color, inner? }] }] }
// ============================================================================
(function () {
  var TYPES = ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'];
  var SCOPES = [
    'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'ALL_FILLS',
    'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'STROKE_FLOAT', 'EFFECT_FLOAT',
    'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY', 'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE',
    'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'
  ];

  function errMsg(e) { return e && e.message ? e.message : String(e); }

  function toColor(hex) {
    var c = hexToFigmaRGB(hex); // the plugin's own helper; throws on bad hex
    return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a };
  }

  // "150%" -> {PERCENT 150}, "auto" -> {AUTO}, 24 -> {PIXELS 24}
  function toLength(v, label, report) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return { unit: 'PIXELS', value: v };
    if (v === 'auto') return { unit: 'AUTO' };
    if (typeof v === 'string' && /^-?\d+(\.\d+)?%$/.test(v)) return { unit: 'PERCENT', value: parseFloat(v) };
    report('value:' + label + ' ' + JSON.stringify(v) + ' (use a number, "120%" or "auto")');
    return null;
  }

  globalThis.runRecipe = async function (recipe) {
    if (!recipe || !Array.isArray(recipe.steps)) throw new Error('runRecipe requires { steps: [...] }');

    var created = { collections: 0, modes: 0, variables: 0, textStyles: 0, effectStyles: 0 };
    var skipped = { variables: 0, textStyles: 0, effectStyles: 0 };
    var unresolved = [];
    function report(msg) { unresolved.push(msg); }

    // Every local variable by name, kept current as the recipe creates more,
    // so aliases can point at variables from earlier steps or earlier runs.
    var collectionsById = {};
    var byName = new Map(); // name -> [{ variable, collection }]
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (var ci = 0; ci < cols.length; ci++) collectionsById[cols[ci].id] = cols[ci];
    var existing = await figma.variables.getLocalVariablesAsync();
    for (var ei = 0; ei < existing.length; ei++) index(existing[ei], collectionsById[existing[ei].variableCollectionId]);

    function index(variable, collection) {
      var list = byName.get(variable.name);
      if (!list) { list = []; byName.set(variable.name, list); }
      list.push({ variable: variable, collection: collection ? collection.name : '' });
    }

    function findAlias(ref, forName) {
      var scope = null, name = ref;
      var sep = ref.indexOf(':');
      if (sep > 0) { scope = ref.slice(0, sep); name = ref.slice(sep + 1); }
      var hits = (byName.get(name) || []).filter(function (h) { return !scope || h.collection === scope; });
      if (hits.length === 1) return hits[0].variable;
      if (!hits.length) report('alias:' + forName + ' → {' + ref + '} not found');
      else report('ambiguous:' + forName + ' → {' + ref + '} (' + hits.map(function (h) { return h.collection; }).join(', ') + ')');
      return null;
    }

    function toValue(v, type, forName) {
      if (typeof v === 'string' && v.charAt(0) === '{' && v.charAt(v.length - 1) === '}') {
        var target = findAlias(v.slice(1, -1), forName);
        return target ? figma.variables.createVariableAlias(target) : undefined;
      }
      try {
        if (type === 'COLOR') return toColor(v);
        if (type === 'FLOAT' && typeof v === 'number') return v;
        if (type === 'STRING' && typeof v === 'string') return v;
        if (type === 'BOOLEAN' && typeof v === 'boolean') return v;
      } catch (e) {
        report('value:' + forName + ' (' + errMsg(e) + ')');
        return undefined;
      }
      report('value:' + forName + ' ' + JSON.stringify(v) + ' is not a ' + type);
      return undefined;
    }

    async function collectionStep(step) {
      if (!step.name || !Array.isArray(step.modes) || !step.modes.length) {
        report('step:collection needs a name and at least one mode');
        return;
      }
      var collection = null;
      for (var id in collectionsById) {
        if (collectionsById[id].name === step.name) { collection = collectionsById[id]; break; }
      }
      var isNew = !collection;
      if (isNew) {
        collection = figma.variables.createVariableCollection(step.name);
        collectionsById[collection.id] = collection;
        collection.renameMode(collection.modes[0].modeId, step.modes[0]);
        created.collections++;
      }

      var modeIds = {};
      for (var mi = 0; mi < step.modes.length; mi++) {
        var modeName = step.modes[mi];
        var found = collection.modes.filter(function (m) { return m.name === modeName; })[0];
        if (found) { modeIds[modeName] = found.modeId; continue; }
        // Never reshape a collection someone already has — report it instead.
        if (!isNew) {
          report('mode:' + step.name + ' already exists without mode "' + modeName + '" (left unchanged; rename that collection or add the mode, then run again)');
          continue;
        }
        try {
          modeIds[modeName] = collection.addMode(modeName);
          created.modes++;
        } catch (e) {
          // Figma's free plan caps modes per collection.
          report('mode:' + step.name + '/' + modeName + ' (' + errMsg(e) + ')');
        }
      }

      var inCollection = {};
      byName.forEach(function (list, name) {
        for (var i = 0; i < list.length; i++) if (list[i].collection === step.name) inCollection[name] = true;
      });

      // Pass 1: create, so aliases can point at variables later in the list.
      var fresh = [];
      var vars = step.variables || [];
      for (var vi = 0; vi < vars.length; vi++) {
        var spec = vars[vi];
        if (!spec || !spec.name || TYPES.indexOf(spec.type) === -1) {
          report('variable:' + (spec && spec.name) + ' needs a name and a type (' + TYPES.join(', ') + ')');
          continue;
        }
        if (inCollection[spec.name]) { skipped.variables++; continue; }
        try {
          var variable = figma.variables.createVariable(spec.name, collection, spec.type);
          if (spec.description) variable.description = spec.description;
          if (spec.scopes) {
            var bad = spec.scopes.filter(function (s) { return SCOPES.indexOf(s) === -1; });
            if (bad.length) report('scopes:' + spec.name + ' unknown ' + bad.join(', '));
            variable.scopes = spec.scopes.filter(function (s) { return SCOPES.indexOf(s) !== -1; });
          }
          index(variable, collection);
          inCollection[spec.name] = true;
          fresh.push({ spec: spec, variable: variable });
          created.variables++;
        } catch (e) {
          report('variable:' + spec.name + ' (' + errMsg(e) + ')');
        }
      }

      // Pass 2: values for every mode.
      for (var fi = 0; fi < fresh.length; fi++) {
        var f = fresh[fi];
        for (var mode in modeIds) {
          var raw = f.spec.values ? f.spec.values[mode] : f.spec.value;
          if (raw === undefined) { report('value:' + f.spec.name + ' has none for mode ' + mode); continue; }
          var value = toValue(raw, f.spec.type, f.spec.name);
          if (value === undefined) continue;
          try { f.variable.setValueForMode(modeIds[mode], value); }
          catch (e) { report('value:' + f.spec.name + ' / ' + mode + ' (' + errMsg(e) + ')'); }
        }
      }
    }

    async function textStylesStep(step) {
      var have = {};
      var local = await figma.getLocalTextStylesAsync();
      for (var i = 0; i < local.length; i++) have[local[i].name] = true;
      var styles = step.styles || [];
      for (var si = 0; si < styles.length; si++) {
        var s = styles[si];
        if (!s || !s.name || typeof s.size !== 'number') { report('textStyle:' + (s && s.name) + ' needs a name and a size'); continue; }
        if (have[s.name]) { skipped.textStyles++; continue; }
        var parts = String(s.font || 'Inter/Regular').split('/');
        var font = { family: parts[0], style: parts[1] || 'Regular' };
        try { await figma.loadFontAsync(font); }
        catch (e) { report('font:' + font.family + '/' + font.style + ' for ' + s.name); continue; }
        try {
          var style = figma.createTextStyle();
          style.name = s.name;
          style.fontName = font;
          style.fontSize = s.size;
          var lh = toLength(s.lineHeight, s.name + ' lineHeight', report);
          if (lh) style.lineHeight = lh;
          var ls = toLength(s.letterSpacing, s.name + ' letterSpacing', report);
          if (ls && ls.unit !== 'AUTO') style.letterSpacing = ls;
          if (s.description) style.description = s.description;
          have[s.name] = true;
          created.textStyles++;
        } catch (e) {
          report('textStyle:' + s.name + ' (' + errMsg(e) + ')');
        }
      }
    }

    async function effectStylesStep(step) {
      var have = {};
      var local = await figma.getLocalEffectStylesAsync();
      for (var i = 0; i < local.length; i++) have[local[i].name] = true;
      var styles = step.styles || [];
      for (var si = 0; si < styles.length; si++) {
        var s = styles[si];
        if (!s || !s.name || !Array.isArray(s.shadows)) { report('effectStyle:' + (s && s.name) + ' needs a name and shadows'); continue; }
        if (have[s.name]) { skipped.effectStyles++; continue; }
        try {
          var effects = s.shadows.map(function (sh) {
            return {
              type: sh.inner ? 'INNER_SHADOW' : 'DROP_SHADOW',
              color: toColor(sh.color || '#00000026'),
              offset: { x: sh.x || 0, y: sh.y || 0 },
              radius: sh.blur || 0,
              spread: sh.spread || 0,
              visible: true,
              blendMode: 'NORMAL'
            };
          });
          var style = figma.createEffectStyle();
          style.name = s.name;
          style.effects = effects;
          if (s.description) style.description = s.description;
          have[s.name] = true;
          created.effectStyles++;
        } catch (e) {
          report('effectStyle:' + s.name + ' (' + errMsg(e) + ')');
        }
      }
    }

    var STEPS = { collection: collectionStep, textStyles: textStylesStep, effectStyles: effectStylesStep };
    for (var s = 0; s < recipe.steps.length; s++) {
      var step = recipe.steps[s] || {};
      var run = STEPS[step.do];
      if (!run) { report('step:' + step.do + ' is not a recipe step (' + Object.keys(STEPS).join(', ') + ')'); continue; }
      await run(step);
    }

    if (typeof globalThis.__bbOnDesignSystemChange === 'function') {
      try { globalThis.__bbOnDesignSystemChange(); } catch (e) {}
    }

    var out = { ok: unresolved.length === 0, created: created, skipped: skipped };
    if (unresolved.length) out.unresolved = unresolved;
    return out;
  };

  console.log('🌉 [BetterBridge] runRecipe ready');
})();
