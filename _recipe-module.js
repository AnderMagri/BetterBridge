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
// Steps — foundation (tokens and styles):
//   { do: "collection", name, modes: ["Light", "Dark"],
//     variables: [{ name, type: "COLOR|FLOAT|STRING|BOOLEAN",
//                   value | values: { <mode>: v }, scopes?, description? }] }
//       a value of "{other/variable}" (or "{Collection:other/variable}") is an alias
//   { do: "textStyles", styles: [{ name, font: "Inter/Bold", size,
//                                  lineHeight?: px | "150%" | "auto",
//                                  letterSpacing?: px | "-1%" }] }
//   { do: "effectStyles", styles: [{ name, shadows: [{ x, y, blur, spread, color, inner? }] }] }
//
// Steps — pages built on top of a foundation (all drawing goes through
// buildSpec, so tokens, styles and strict mode apply exactly as they do for
// Claude's builds):
//   { do: "require", collections?, textStyles?, effectStyles?, message }
//       stops the recipe, with `message`, if anything listed is missing
//   { do: "page", name }                    find or create the page, and open it
//   { do: "section", name }                 find or create a section on that page
//   { do: "build", in: <section>, build }   a buildSpec node, placed in the section
//   { do: "component", in, build }          the same, turned into a component
//   { do: "componentSet", in, name, textProps?: { <Property>: <text layer name> },
//     variants: [{ props: { Variant: "Primary" }, build }] }
//   { do: "colorSwatches", in, name, collection, chrome }  one swatch per color variable
//   { do: "typeSpecimens", in, name, sample, chrome }      one sample per local text style
// Anything already in the section with the same name is skipped.
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

    var created = { collections: 0, modes: 0, variables: 0, textStyles: 0, effectStyles: 0, pages: 0, sections: 0, nodes: 0, components: 0 };
    var skipped = { variables: 0, textStyles: 0, effectStyles: 0, sections: 0, nodes: 0 };
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

    // ---- page steps -----------------------------------------------------------
    var targetPage = null;

    async function requireStep(step) {
      var missing = [];
      var names = {};
      var liveCols = await figma.variables.getLocalVariableCollectionsAsync();
      for (var i = 0; i < liveCols.length; i++) names['c:' + liveCols[i].name] = true;
      var texts = await figma.getLocalTextStylesAsync();
      for (var t = 0; t < texts.length; t++) names['t:' + texts[t].name] = true;
      var effects = await figma.getLocalEffectStylesAsync();
      for (var f = 0; f < effects.length; f++) names['e:' + effects[f].name] = true;
      (step.collections || []).forEach(function (n) { if (!names['c:' + n]) missing.push('collection ' + n); });
      (step.textStyles || []).forEach(function (n) { if (!names['t:' + n]) missing.push('text style ' + n); });
      (step.effectStyles || []).forEach(function (n) { if (!names['e:' + n]) missing.push('effect style ' + n); });
      if (!missing.length) return true;
      report('require:' + (step.message || 'this recipe needs things this file doesn\'t have') + ' (missing ' + missing.join(', ') + ')');
      return false;
    }

    async function pageStep(step) {
      if (!step.name) { report('step:page needs a name'); return; }
      await figma.loadAllPagesAsync();
      var page = figma.root.children.filter(function (p) { return p.name === step.name; })[0];
      if (!page) {
        page = figma.createPage();
        page.name = step.name;
        created.pages++;
      }
      // Open it: component lookups by name (e.g. a Card using the Button) scan
      // the current page, and it's where the user wants to look afterwards.
      await figma.setCurrentPageAsync(page);
      targetPage = page;
    }

    function findSection(name) {
      var page = targetPage || figma.currentPage;
      return page.children.filter(function (n) { return n.type === 'SECTION' && n.name === name; })[0] || null;
    }

    async function sectionStep(step) {
      if (!step.name) { report('step:section needs a name'); return; }
      if (findSection(step.name)) { skipped.sections++; return; }
      var page = targetPage || figma.currentPage;
      var x = 0;
      page.children.forEach(function (n) { if (n.type === 'SECTION') x = Math.max(x, n.x + n.width + 120); });
      var section = figma.createSection();
      section.name = step.name;
      page.appendChild(section);
      section.x = x;
      section.y = 0;
      section.resizeWithoutConstraints(480, 320);
      created.sections++;
    }

    // Stack a section's children top to bottom and size the section to fit.
    function fitSection(section) {
      var pad = 64, gap = 64, y = pad, width = 0;
      section.children.forEach(function (c) {
        c.x = pad;
        c.y = y;
        y += c.height + gap;
        width = Math.max(width, c.width);
      });
      section.resizeWithoutConstraints(Math.max(480, width + pad * 2), Math.max(320, y - gap + pad));
    }

    // Builds `node` (a buildSpec node) into the named section. Returns the new
    // node, or null when the section is missing, the name is taken, or the
    // build failed — all reported.
    async function buildInto(sectionName, node, label) {
      var section = findSection(sectionName);
      if (!section) { report(label + ': section "' + sectionName + '" not found (add a section step before it)'); return null; }
      if (node.name && section.children.some(function (c) { return c.name === node.name; })) { skipped.nodes++; return null; }
      var res;
      try { res = await globalThis.buildSpec({ parentId: section.id, select: false, build: node }); }
      catch (e) { report(label + ': ' + errMsg(e)); return null; }
      if (res.unresolved) res.unresolved.forEach(function (u) { report(label + ': ' + u); });
      return await figma.getNodeByIdAsync(res.id);
    }

    async function buildStep(step) {
      if (!step.build) { report('step:build needs a build node'); return; }
      var node = await buildInto(step.in, step.build, step.build.name || 'build');
      if (!node) return;
      created.nodes++;
      fitSection(node.parent);
    }

    async function componentStep(step) {
      if (!step.build || !step.build.name) { report('step:component needs a build node with a name'); return; }
      var node = await buildInto(step.in, step.build, step.build.name);
      if (!node) return;
      try {
        var component = figma.createComponentFromNode(node);
        created.components++;
        fitSection(component.parent);
      } catch (e) { report(step.build.name + ': could not become a component (' + errMsg(e) + ')'); }
    }

    async function componentSetStep(step) {
      if (!step.name || !Array.isArray(step.variants) || !step.variants.length) {
        report('step:componentSet needs a name and variants');
        return;
      }
      var section = findSection(step.in);
      if (section && section.children.some(function (c) { return c.name === step.name; })) { skipped.nodes++; return; }

      var components = [];
      for (var i = 0; i < step.variants.length; i++) {
        var v = step.variants[i];
        var variantName = Object.keys(v.props || {}).map(function (k) { return k + '=' + v.props[k]; }).join(', ');
        if (!variantName || !v.build) { report(step.name + ': variant ' + (i + 1) + ' needs props and a build node'); continue; }
        var build = {};
        for (var k in v.build) if (v.build.hasOwnProperty(k)) build[k] = v.build[k];
        build.name = variantName;
        var node = await buildInto(step.in, build, step.name + ' ' + variantName);
        if (!node) continue;
        try { components.push(figma.createComponentFromNode(node)); }
        catch (e) { report(step.name + ' ' + variantName + ': could not become a component (' + errMsg(e) + ')'); }
      }
      if (!components.length) return;

      try {
        var set = figma.combineAsVariants(components, findSection(step.in));
        set.name = step.name;
        set.layoutMode = 'VERTICAL';
        set.primaryAxisSizingMode = 'AUTO';
        set.counterAxisSizingMode = 'AUTO';
        set.itemSpacing = 16;
        set.paddingTop = set.paddingRight = set.paddingBottom = set.paddingLeft = 24;

        // Text properties: one editable label shared by every variant.
        var textProps = step.textProps || {};
        for (var prop in textProps) {
          if (!textProps.hasOwnProperty(prop)) continue;
          var layer = textProps[prop];
          var texts = components.map(function (c) {
            return c.findOne(function (n) { return n.type === 'TEXT' && n.name === layer; });
          });
          if (texts.some(function (t) { return !t; })) { report(step.name + ': text layer "' + layer + '" missing in some variants, so no ' + prop + ' property'); continue; }
          var key = set.addComponentProperty(prop, 'TEXT', texts[0].characters);
          texts.forEach(function (t) { t.componentPropertyReferences = { characters: key }; });
        }
        created.components++;
        fitSection(set.parent);
      } catch (e) {
        report(step.name + ': could not combine variants (' + errMsg(e) + ')');
      }
    }

    // One swatch per COLOR variable in a collection, grouped by the second
    // part of the name (color/surface/default -> "surface"). The swatch fill is
    // scoped to the collection so a same-named library token can't sneak in.
    async function colorSwatchesStep(step) {
      var ch = step.chrome || {};
      var collection = null;
      var liveCols = await figma.variables.getLocalVariableCollectionsAsync();
      for (var i = 0; i < liveCols.length; i++) if (liveCols[i].name === step.collection) collection = liveCols[i];
      if (!collection) { report('colorSwatches: collection "' + step.collection + '" not found'); return; }
      var vars = (await figma.variables.getLocalVariablesAsync()).filter(function (v) {
        return v.variableCollectionId === collection.id && v.resolvedType === 'COLOR';
      });
      if (!vars.length) { report('colorSwatches: "' + step.collection + '" has no color variables'); return; }

      var groups = [], byGroup = {};
      vars.forEach(function (v) {
        var parts = v.name.split('/');
        var group = parts[0] === 'color' && parts.length > 2 ? parts[1] : parts[0];
        if (!byGroup[group]) { byGroup[group] = []; groups.push(group); }
        byGroup[group].push(v);
      });

      var node = {
        type: 'frame', name: step.name || 'Color swatches', layout: 'col', gap: ch.gap, pad: ch.pad, radius: ch.radius, fill: ch.fill,
        children: groups.map(function (g) {
          return {
            type: 'frame', name: g, layout: 'col', gap: ch.innerGap, fill: ch.fill,
            children: [
              { type: 'text', name: 'Title', text: g, textStyle: ch.titleStyle, fill: ch.titleColor },
              { type: 'frame', name: 'Swatches', layout: 'row', gap: ch.innerGap, fill: ch.fill,
                children: byGroup[g].map(function (v) {
                  return {
                    type: 'frame', name: v.name, layout: 'col', gap: ch.labelGap, fill: ch.fill,
                    children: [
                      { type: 'rectangle', name: 'Swatch', w: 128, h: 56, radius: ch.swatchRadius, fill: step.collection + ':' + v.name, stroke: ch.swatchStroke },
                      { type: 'text', name: 'Token', text: v.name.replace(/^color\//, ''), textStyle: ch.labelStyle, fill: ch.labelColor }
                    ]
                  };
                }) }
            ]
          };
        })
      };
      var built = await buildInto(step.in, node, 'colorSwatches');
      if (!built) return;
      created.nodes++;
      fitSection(built.parent);
    }

    // One row per local text style: its name, then a sample set in it.
    async function typeSpecimensStep(step) {
      var ch = step.chrome || {};
      var styles = await figma.getLocalTextStylesAsync();
      if (!styles.length) { report('typeSpecimens: this file has no text styles'); return; }
      var node = {
        type: 'frame', name: step.name || 'Type specimens', layout: 'col', gap: ch.gap, pad: ch.pad, radius: ch.radius, fill: ch.fill,
        children: styles.map(function (st) {
          return {
            type: 'frame', name: st.name, layout: 'col', gap: ch.labelGap, fill: ch.fill,
            children: [
              { type: 'text', name: 'Style', text: st.name, textStyle: ch.labelStyle, fill: ch.labelColor },
              { type: 'text', name: 'Sample', text: step.sample || 'The quick brown fox jumps over the lazy dog', textStyle: st.name, fill: ch.titleColor }
            ]
          };
        })
      };
      var built = await buildInto(step.in, node, 'typeSpecimens');
      if (!built) return;
      created.nodes++;
      fitSection(built.parent);
    }

    var STEPS = {
      collection: collectionStep, textStyles: textStylesStep, effectStyles: effectStylesStep,
      require: requireStep, page: pageStep, section: sectionStep, build: buildStep,
      component: componentStep, componentSet: componentSetStep,
      colorSwatches: colorSwatchesStep, typeSpecimens: typeSpecimensStep
    };
    var stopped = false;
    for (var s = 0; s < recipe.steps.length; s++) {
      var step = recipe.steps[s] || {};
      var run = STEPS[step.do];
      if (!run) { report('step:' + step.do + ' is not a recipe step (' + Object.keys(STEPS).join(', ') + ')'); continue; }
      if ((await run(step)) === false) { stopped = true; break; }
    }

    if (typeof globalThis.__bbOnDesignSystemChange === 'function') {
      try { globalThis.__bbOnDesignSystemChange(); } catch (e) {}
    }

    var out = { ok: unresolved.length === 0, created: created, skipped: skipped };
    if (stopped) out.stopped = true;
    if (unresolved.length) out.unresolved = unresolved;
    return out;
  };

  console.log('🌉 [BetterBridge] runRecipe ready');
})();
