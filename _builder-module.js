// ============================================================================
// BETTERBRIDGE BUILDER MODULE
// ----------------------------------------------------------------------------
// Functions on globalThis, all callable from figma_execute with NO
// MCP-server changes:
//
//   buildSpec({ build: <node> })   — create, registry-aware
//   patchSpec([{ id, ... }])       — edit EXISTING nodes by id
//   manifestSummary()              — cheap {name: {nodeId,key,props}} export
//   setManifest({...})             — set the session registry once
//   designSystem()                 — is this file connected to a design system?
//   findIcons("arrow")             — search the connected icon set by name
//   iconSummary()                  — the icons in this file (used by "Connect")
//
// WHY: verbose expansion (font loading, variable binding, instance creation,
// slot filling) happens HERE, inside the plugin, where it costs zero model
// tokens. Every return value is deliberately small — that's what crosses
// back into Claude's context.
//
// RULE: nothing is dropped silently. Anything the builder can't honour — a
// misspelled field, a size that needs auto layout, a slot that doesn't exist,
// a raw value refused by strict mode — comes back in `unresolved`.
// ============================================================================
(function () {
  var ALIGN = { center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN', start: 'MIN' };
  var CROSS = { center: 'CENTER', end: 'MAX', stretch: 'STRETCH', start: 'MIN' };
  var LAYOUT = { row: 'HORIZONTAL', col: 'VERTICAL' };

  // Every field each kind of spec understands. Anything else is reported as
  // `field:` — a typo like `padding` used to vanish without a trace.
  var FIELDS = {
    frame:     ['type', 'name', 'layout', 'gap', 'pad', 'radius', 'fill', 'stroke', 'effect', 'w', 'h', 'align', 'cross', 'children'],
    text:      ['type', 'name', 'text', 'font', 'size', 'textStyle', 'fill', 'stroke', 'effect', 'w', 'h'],
    rectangle: ['type', 'name', 'radius', 'fill', 'stroke', 'effect', 'w', 'h'],
    ellipse:   ['type', 'name', 'fill', 'stroke', 'effect', 'w', 'h'],
    instance:  ['use', 'type', 'name', 'props', 'slots', 'w', 'h'],
    icon:      ['icon', 'type', 'name', 'w', 'h']
  };
  var BUILD_TOP_FIELDS = ['build', 'manifest', 'at', 'parentId', 'select', 'strict', 'atomic'];
  var PATCH_FIELDS = ['id', 'remove', 'name', 'text', 'font', 'textStyle', 'props', 'fill', 'stroke', 'effect', 'gap', 'pad', 'radius', 'w', 'h'];

  // ---- strict mode ----------------------------------------------------------
  // On by default. When the file has a design system, raw hex colours and raw
  // spacing/radius numbers are refused instead of applied. Switched from the
  // plugin window (persisted there); a spec can turn it ON with strict: true
  // but not off. A guardrail against habits, not a security boundary.
  var strict = true;
  function notifyChange() {
    if (typeof globalThis.__bbOnDesignSystemChange === 'function') {
      try { globalThis.__bbOnDesignSystemChange(); } catch (e) {}
    }
  }
  globalThis.__bbSetStrict = function (v) { strict = !!v; notifyChange(); return strict; };
  globalThis.__bbGetStrict = function () { return strict; };

  function errMsg(e) { return e && e.message ? e.message : String(e); }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function short(s) {
    s = String(s || '');
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  }

  function checkFields(ctx, obj, allowed, where) {
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      if (allowed.indexOf(k) === -1) ctx.unresolved.push('field:' + k + ' ignored on ' + where);
    }
  }

  // ---- manifest -------------------------------------------------------------
  // Accepts the figma.manifest.json shape { components: {...}, styles: {...} }
  // or, as before, a bare { "Name": { nodeId, key } } components map.
  function normalizeManifest(m) {
    m = m || {};
    var c = m.components;
    if (c && typeof c === 'object' && !('nodeId' in c) && !('key' in c)) {
      return { components: c, styles: m.styles || {} };
    }
    return { components: m, styles: {} };
  }

  function makeCtx(opts, styleRefs) {
    opts = opts || {};
    var ctx = {
      unresolved: [],
      offSystem: [],
      strict: strict || opts.strict === true,
      styleRefs: styleRefs || globalThis.__BB_STYLES || {},
      local: null,
      styles: null,
      ds: null,
      libRetried: false
    };
    if (opts.strict === false && strict) {
      ctx.unresolved.push('ignored:strict:false (strict mode can only be switched off in the plugin window)');
    }
    return ctx;
  }

  // ---- token (variable) indexes ---------------------------------------------
  function newIndex() {
    return { byName: new Map(), count: 0, types: {}, collections: [], libraries: [], error: null };
  }

  function addCandidate(idx, cand) {
    var list = idx.byName.get(cand.name);
    if (!list) { list = []; idx.byName.set(cand.name, list); }
    list.push(cand);
    idx.count++;
    idx.types[cand.type] = (idx.types[cand.type] || 0) + 1;
  }

  // Local variables: re-read on every top-level call (cheap, and the user may
  // have just edited them).
  async function localIndex(ctx) {
    if (ctx.local) return ctx.local;
    var idx = newIndex();
    try {
      var colNames = {};
      if (figma.variables.getLocalVariableCollectionsAsync) {
        var cols = await figma.variables.getLocalVariableCollectionsAsync();
        for (var i = 0; i < cols.length; i++) {
          colNames[cols[i].id] = cols[i].name;
          idx.collections.push({ name: cols[i].name });
        }
      }
      var all = await figma.variables.getLocalVariablesAsync();
      for (var j = 0; j < all.length; j++) {
        addCandidate(idx, {
          name: all[j].name, type: all[j].resolvedType, variable: all[j],
          collection: colNames[all[j].variableCollectionId] || ''
        });
      }
    } catch (e) { idx.error = errMsg(e); }
    ctx.local = idx;
    return idx;
  }

  // Library variables: every collection in the libraries enabled for this
  // file. Slower (one request per collection), so cached across calls. The
  // plugin warms this at startup so the first build doesn't pay for it.
  var LIB_TTL_MS = 5 * 60 * 1000;
  var libCache = null;      // { at, promise }
  var importedVars = {};    // library variable key -> Variable
  var importedStyles = {};  // style key -> BaseStyle

  function libraryIndex(force) {
    if (!force && libCache && Date.now() - libCache.at < LIB_TTL_MS) return libCache.promise;
    var entry = { at: Date.now(), promise: null };
    entry.promise = (async function () {
      var idx = newIndex();
      var tl = figma.teamLibrary;
      if (!tl || !tl.getAvailableLibraryVariableCollectionsAsync) return idx;
      try {
        var cols = await tl.getAvailableLibraryVariableCollectionsAsync();
        var lists = await Promise.all(cols.map(function (c) {
          return tl.getVariablesInLibraryCollectionAsync(c.key).catch(function () { return []; });
        }));
        var seen = {};
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i];
          if (!seen[c.libraryName]) { seen[c.libraryName] = 1; idx.libraries.push(c.libraryName); }
          idx.collections.push({ name: c.name, library: c.libraryName });
          for (var j = 0; j < lists[i].length; j++) {
            var v = lists[i][j];
            addCandidate(idx, { name: v.name, type: v.resolvedType, key: v.key, collection: c.name, library: c.libraryName });
          }
        }
      } catch (e) {
        idx.error = errMsg(e);
        if (libCache === entry) libCache = null; // don't cache a failure
      }
      return idx;
    })();
    libCache = entry;
    return entry.promise;
  }

  function candLabel(c) { return c.library ? c.library + ' › ' + c.collection : c.collection; }

  // Resolve a token NAME to a Variable of the wanted type ('COLOR' | 'FLOAT').
  // Local variables win over library ones — the file's own definitions are the
  // more specific choice. Within one tier, a name matching more than one
  // variable is reported, never guessed: prefix it with its collection or
  // library, e.g. "Semantic:color/primary".
  // Returns { variable } | { error } | { missing: true }.
  async function findVar(ctx, raw, wantType) {
    var scope = null, name = raw;
    var sep = raw.indexOf(':');
    if (sep > 0) { scope = raw.slice(0, sep); name = raw.slice(sep + 1); }

    var tiers = [await localIndex(ctx), await libraryIndex(false)];
    var wrongType = null;
    for (var t = 0; t < tiers.length; t++) {
      var all = tiers[t].byName.get(name) || [];
      var inScope = all.filter(function (c) { return !scope || c.collection === scope || c.library === scope; });
      var typed = inScope.filter(function (c) { return c.type === wantType; });
      if (!typed.length) {
        if (inScope.length && !wrongType) wrongType = inScope[0].type;
        continue;
      }
      if (typed.length > 1) {
        return { error: 'ambiguous:' + raw + ' (' + typed.map(candLabel).join(', ') +
          ') — prefix one, e.g. "' + typed[0].collection + ':' + name + '"' };
      }
      var cand = typed[0];
      if (cand.variable) return { variable: cand.variable };
      try {
        if (!importedVars[cand.key]) importedVars[cand.key] = await figma.variables.importVariableByKeyAsync(cand.key);
        return { variable: importedVars[cand.key] };
      } catch (e) {
        return { error: 'import:' + raw + ' (' + errMsg(e) + ')' };
      }
    }
    if (wrongType) return { error: 'varType:' + raw + ' is ' + wrongType + ', not ' + wantType };

    // A library enabled since the cache was filled? Re-read once, then give up.
    if (!ctx.libRetried && libCache && Date.now() - libCache.at > 30000) {
      ctx.libRetried = true;
      await libraryIndex(true);
      return findVar(ctx, raw, wantType);
    }
    return { missing: true };
  }

  // ---- styles ---------------------------------------------------------------
  // Local paint/text/effect styles, plus library styles listed by key in the
  // manifest's `styles` section (the plugin API can't enumerate library styles).
  async function styleIndex(ctx) {
    if (ctx.styles) return ctx.styles;
    var idx = { PAINT: new Map(), TEXT: new Map(), EFFECT: new Map() };
    var loaders = { PAINT: 'getLocalPaintStylesAsync', TEXT: 'getLocalTextStylesAsync', EFFECT: 'getLocalEffectStylesAsync' };
    for (var type in loaders) {
      if (typeof figma[loaders[type]] !== 'function') continue;
      try {
        var list = await figma[loaders[type]]();
        for (var i = 0; i < list.length; i++) {
          if (!idx[type].has(list[i].name)) idx[type].set(list[i].name, list[i]);
        }
      } catch (e) {}
    }
    ctx.styles = idx;
    return idx;
  }

  function styleRefCount(ctx, type) {
    var n = 0;
    for (var k in ctx.styleRefs) {
      if (ctx.styleRefs.hasOwnProperty(k) && ctx.styleRefs[k] && ctx.styleRefs[k].type === type) n++;
    }
    return n;
  }

  // Returns { style } | { error } | { missing: true }.
  async function findStyle(ctx, name, type) {
    var idx = await styleIndex(ctx);
    var hit = idx[type].get(name);
    if (hit) return { style: hit };
    var ref = ctx.styleRefs[name];
    if (ref && ref.key && (!ref.type || ref.type === type)) {
      try {
        if (!importedStyles[ref.key]) importedStyles[ref.key] = await figma.importStyleByKeyAsync(ref.key);
        var s = importedStyles[ref.key];
        if (s.type !== type) return { error: 'styleType:' + name + ' is ' + s.type + ', not ' + type };
        return { style: s };
      } catch (e) {
        return { error: 'import:' + name + ' (' + errMsg(e) + ')' };
      }
    }
    return { missing: true };
  }

  // Which kinds of design-system value exist for this file. Drives strict mode
  // and `offSystem` — a file with no colour tokens isn't nagged about hex.
  async function dsFlags(ctx) {
    if (ctx.ds) return ctx.ds;
    var local = await localIndex(ctx);
    var lib = await libraryIndex(false);
    var st = await styleIndex(ctx);
    ctx.ds = {
      color: (local.types.COLOR || 0) + (lib.types.COLOR || 0) + st.PAINT.size + styleRefCount(ctx, 'PAINT') > 0,
      number: (local.types.FLOAT || 0) + (lib.types.FLOAT || 0) > 0,
      text: st.TEXT.size + styleRefCount(ctx, 'TEXT') > 0
    };
    return ctx.ds;
  }

  // ---- a numeric field that may be a token NAME or a raw number ----
  async function applyNum(ctx, node, field, value, label) {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') {
      if (value !== 0 && (await dsFlags(ctx)).number) {
        if (ctx.strict) {
          ctx.unresolved.push('strict:' + label + ' ' + value + ' refused (use a number token)');
          return;
        }
        ctx.offSystem.push(label + ':' + value);
      }
      try { node[field] = value; }
      catch (e) { ctx.unresolved.push('set:' + label + ' (' + errMsg(e) + ')'); }
      return;
    }
    if (typeof value !== 'string') {
      ctx.unresolved.push('value:' + label + ' ' + JSON.stringify(value) + ' (use a number or token name)');
      return;
    }
    var r = await findVar(ctx, value, 'FLOAT');
    if (r.variable) {
      try { node.setBoundVariable(field, r.variable); }
      catch (e) { ctx.unresolved.push('bind:' + value + ' (' + errMsg(e) + ')'); }
    } else {
      ctx.unresolved.push(r.error || ('var:' + value));
    }
  }

  async function applyPad(ctx, node, pad) {
    var p = Array.isArray(pad) ? pad : [pad, pad, pad, pad];
    await applyNum(ctx, node, 'paddingTop', p[0], 'pad');
    await applyNum(ctx, node, 'paddingRight', p[1], 'pad');
    await applyNum(ctx, node, 'paddingBottom', p[2], 'pad');
    await applyNum(ctx, node, 'paddingLeft', p[3], 'pad');
  }

  // ---- fill/stroke from "#hex", a colour token NAME, or a paint style NAME ----
  // Returns { paint } | { style } | null (and reports why).
  async function resolvePaint(ctx, value, label) {
    if (typeof value !== 'string') {
      ctx.unresolved.push('value:' + label + ' ' + JSON.stringify(value) + ' (use "#hex" or a token/style name)');
      return null;
    }
    // hex first — cheap, and avoids an unneeded variable scan
    if (value.charAt(0) === '#') {
      if ((await dsFlags(ctx)).color) {
        if (ctx.strict) {
          ctx.unresolved.push('strict:' + label + ' ' + value + ' refused (use a color token or style)');
          return null;
        }
        ctx.offSystem.push(label + ':' + value);
      }
      var rgb = hexToFigmaRGB(value); // reuses the plugin's own helper
      var hexPaint = { type: 'SOLID', color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: 1 };
      if (rgb.a !== undefined) hexPaint.opacity = rgb.a;
      return { paint: hexPaint };
    }
    var r = await findVar(ctx, value, 'COLOR');
    if (r.variable) {
      var paint = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 };
      return { paint: figma.variables.setBoundVariableForPaint(paint, 'color', r.variable) };
    }
    if (r.error) { ctx.unresolved.push(r.error); return null; }
    var s = await findStyle(ctx, value, 'PAINT');
    if (s.style) return { style: s.style };
    ctx.unresolved.push(s.error || ('color:' + value));
    return null;
  }

  async function applyPaint(ctx, node, prop, value, label) {
    if (value === null || value === undefined) return;
    if (!(prop in node)) {
      ctx.unresolved.push('field:' + label + ' ignored (' + node.type + ' has no ' + prop + ')');
      return;
    }
    var r = await resolvePaint(ctx, value, label);
    if (!r) return;
    try {
      if (r.style) {
        if (prop === 'fills') await node.setFillStyleIdAsync(r.style.id);
        else await node.setStrokeStyleIdAsync(r.style.id);
      } else {
        node[prop] = [r.paint];
      }
      if (prop === 'strokes' && !node.strokeWeight) node.strokeWeight = 1;
    } catch (e) {
      ctx.unresolved.push('bind:' + value + ' (' + errMsg(e) + ')');
    }
  }

  async function applyEffect(ctx, node, value) {
    if (value === null || value === undefined) return;
    if (!('effects' in node)) {
      ctx.unresolved.push('field:effect ignored (' + node.type + ' has no effects)');
      return;
    }
    var s = await findStyle(ctx, value, 'EFFECT');
    if (!s.style) { ctx.unresolved.push(s.error || ('effect:' + value)); return; }
    try { await node.setEffectStyleIdAsync(s.style.id); }
    catch (e) { ctx.unresolved.push('bind:' + value + ' (' + errMsg(e) + ')'); }
  }

  // Returns true when the style was applied.
  async function applyTextStyle(ctx, node, value) {
    var s = await findStyle(ctx, value, 'TEXT');
    if (!s.style) { ctx.unresolved.push(s.error || ('textStyle:' + value)); return false; }
    try {
      await figma.loadFontAsync(s.style.fontName);
      await node.setTextStyleIdAsync(s.style.id);
      return true;
    } catch (e) {
      ctx.unresolved.push('bind:' + value + ' (' + errMsg(e) + ')');
      return false;
    }
  }

  // ---- sizing ---------------------------------------------------------------
  function isAutoLayout(n) {
    return !!n && 'layoutMode' in n && !!n.layoutMode && n.layoutMode !== 'NONE';
  }

  // Figma only accepts "hug" on auto-layout frames and text, and "fill" on
  // children of an auto-layout parent. Both used to fail silently.
  function applySizing(ctx, node, w, h) {
    var where = ' on "' + short(node.name) + '"';
    if (typeof w === 'number' || typeof h === 'number') {
      try {
        node.resize(typeof w === 'number' ? w : node.width,
                    typeof h === 'number' ? h : node.height);
      } catch (e) { ctx.unresolved.push('size:resize failed' + where + ' (' + errMsg(e) + ')'); }
    }
    var axes = [['w', w, 'layoutSizingHorizontal'], ['h', h, 'layoutSizingVertical']];
    for (var i = 0; i < axes.length; i++) {
      var axis = axes[i][0], v = axes[i][1], prop = axes[i][2];
      if (v === undefined || v === null || typeof v === 'number') continue;
      if (v === 'hug') {
        if (!isAutoLayout(node) && node.type !== 'TEXT') {
          ctx.unresolved.push('size:' + axis + '=hug' + where + ' needs layout (it has none)');
          continue;
        }
      } else if (v === 'fill') {
        if (!isAutoLayout(node.parent)) {
          ctx.unresolved.push('size:' + axis + '=fill' + where + ' needs an auto-layout parent');
          continue;
        }
      } else {
        ctx.unresolved.push('size:' + axis + '=' + JSON.stringify(v) + where + ' (use a number, "hug" or "fill")');
        continue;
      }
      try { node[prop] = v === 'hug' ? 'HUG' : 'FILL'; }
      catch (e) { ctx.unresolved.push('size:' + axis + '=' + v + where + ' (' + errMsg(e) + ')'); }
    }
  }

  // ---- match provided prop keys against real ones ("label" -> "label#12:3") ----
  function applyPropsToInstance(node, props, ctx, label) {
    var keys = Object.keys(node.componentProperties || {});
    var resolved = {};
    for (var k in props) {
      if (!props.hasOwnProperty(k)) continue;
      var exact = null;
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki] === k || keys[ki].split('#')[0] === k) { exact = keys[ki]; break; }
      }
      resolved[exact || k] = props[k];
    }
    try { node.setProperties(resolved); }
    catch (e) { ctx.unresolved.push('props:' + label + ' (' + errMsg(e) + ')'); }
  }

  // ============================================================================
  // Icons — a second source next to the design system.
  //
  // An icon set is "connected" once, from the plugin window, while its library
  // file is open: iconSummary() lists that file's icon components by name and
  // key, and the plugin saves the list per user. Each file then picks which
  // saved set it uses (the plugin glue in code.js stores that choice per file
  // and passes the active set in here). { icon: "arrow-right" } places a real
  // instance — no manifest, and no icon list ever passes through Claude's
  // context (findIcons searches it locally).
  //
  // Without an active set, library icons already used on the current page are
  // still usable by name: the plugin API can't list a library's components,
  // but it can follow placed instances back to them.
  //
  // What counts as an icon: a component (for a set, its default variant) that
  // is a small square (up to 64px) made only of shapes, with at least one
  // vector and no text — that matches icon libraries whatever their naming
  // (Phosphor's "CaretLeft", Material's "Icon/home", "arrow-right"). Also:
  // anything on a page whose name contains "icon", or named "Icon/…".
  // ============================================================================
  var iconSource = null; // { name, fileKey, savedAt, icons: { name: { key, nodeId, set } } }
  var detectedIcons = {}; // name -> { key, set } for library icons placed on the current page
  globalThis.__bbSetIconSource = function (src) {
    iconSource = src && src.icons ? src : null;
    notifyChange();
    return iconSource ? Object.keys(iconSource.icons).length : 0;
  };
  globalThis.__bbGetIconSource = function () { return iconSource; };

  var ICON_PREFIX = /^icons?\s*\/\s*/i;
  function iconKey(name) { return String(name).replace(ICON_PREFIX, '').trim(); }
  // "caret-left", "Caret Left" and "CaretLeft" are the same icon.
  function iconNorm(name) { return iconKey(name).toLowerCase().replace(/[\s_-]+/g, ''); }

  var SHAPES = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1, ELLIPSE: 1, RECTANGLE: 1, GROUP: 1, FRAME: 1 };
  function looksLikeIcon(component) {
    if (!component || typeof component.width !== 'number') return false;
    if (component.width > 64 || Math.abs(component.width - component.height) > 0.5) return false;
    var hasVector = false, onlyShapes = true;
    (function walk(node) {
      var kids = node.children || [];
      for (var i = 0; i < kids.length && onlyShapes; i++) {
        if (!SHAPES[kids[i].type]) { onlyShapes = false; return; }
        if (kids[i].type === 'VECTOR' || kids[i].type === 'BOOLEAN_OPERATION') hasVector = true;
        walk(kids[i]);
      }
    })(component);
    return onlyShapes && hasVector;
  }

  function describe(node) {
    var d = node && typeof node.description === 'string' ? node.description : '';
    return d.length > 120 ? d.slice(0, 120) : d;
  }

  globalThis.iconSummary = async function () {
    await figma.loadAllPagesAsync();
    var icons = {}, count = 0;
    for (var p = 0; p < figma.root.children.length; p++) {
      var page = figma.root.children[p];
      var wholePage = /icon/i.test(page.name);
      var nodes = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue;
        var sample = n.type === 'COMPONENT_SET' ? (n.defaultVariant || n.children[0]) : n;
        if (!wholePage && !ICON_PREFIX.test(n.name) && !looksLikeIcon(sample)) continue;
        var key = iconKey(n.name);
        if (!key || icons[key]) continue;
        icons[key] = { key: n.key || null, nodeId: n.id, set: n.type === 'COMPONENT_SET' };
        var tags = describe(n) || describe(sample);
        if (tags) icons[key].tags = tags;
        count++;
      }
    }
    return { name: figma.root.name, fileKey: figma.fileKey || null, count: count, icons: icons };
  };

  // Library icons placed on the current page: instances whose main component
  // comes from a library and looks like an icon (see looksLikeIcon — judged on
  // the main component, since instances are often resized). One lookup per
  // distinct instance name, capped so a huge page stays fast.
  async function detectLibraryIcons() {
    var found = {};
    var instances = figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] });
    var seen = {}, looked = 0;
    for (var i = 0; i < instances.length && looked < 150; i++) {
      var inst = instances[i];
      if (seen[inst.name]) continue;
      seen[inst.name] = true;
      looked++;
      var main = null;
      try { main = await inst.getMainComponentAsync(); } catch (e) {}
      if (!main || !main.remote) continue;
      var holder = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : main;
      if (!ICON_PREFIX.test(holder.name) && !looksLikeIcon(main)) continue;
      var name = iconKey(holder.name);
      if (!found[name]) {
        found[name] = { key: holder.key || main.key, set: holder.type === 'COMPONENT_SET' };
        var tags = describe(holder) || describe(main);
        if (tags) found[name].tags = tags;
      }
    }
    detectedIcons = found;
    return Object.keys(found).length;
  }
  globalThis.__bbDetectedIconKeys = function () {
    return Object.keys(detectedIcons).map(function (n) { return detectedIcons[n].key; });
  };

  // Name matches first, then keyword (description) matches.
  function searchIcons(map, query, limit) {
    var q = iconNorm(query || '');
    var words = String(query || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    var max = typeof limit === 'number' ? limit : 20;
    var names = Object.keys(map), byName = [], byTag = [];
    for (var i = 0; i < names.length; i++) {
      if (!q || iconNorm(names[i]).indexOf(q) !== -1) byName.push(names[i]);
      else if (map[names[i]].tags && words.every(function (w) { return map[names[i]].tags.toLowerCase().indexOf(w) !== -1; })) byTag.push(names[i]);
    }
    return byName.concat(byTag).slice(0, max);
  }

  // Case-insensitive search of the active set (or, without one, of the library
  // icons used on this page). Small results only.
  globalThis.findIcons = async function (query, limit) {
    if (iconSource) {
      return { connected: true, set: iconSource.name, total: Object.keys(iconSource.icons).length, icons: searchIcons(iconSource.icons, query, limit) };
    }
    await detectLibraryIcons();
    return { connected: false, source: 'used on this page', total: Object.keys(detectedIcons).length, icons: searchIcons(detectedIcons, query, limit) };
  };

  function lookupIn(map, name) {
    if (!map) return null;
    var want = iconKey(name);
    if (map[want]) return map[want];
    var norm = iconNorm(want);
    for (var k in map) {
      if (map.hasOwnProperty(k) && iconNorm(k) === norm) return map[k];
    }
    return null;
  }

  // Returns { component } | { error }.
  async function resolveIcon(name) {
    var ref = lookupIn(iconSource && iconSource.icons, name);
    if (!ref && !iconSource) {
      if (!Object.keys(detectedIcons).length) await detectLibraryIcons();
      var used = lookupIn(detectedIcons, name);
      if (used) {
        try {
          if (used.set) {
            var usedSet = await figma.importComponentSetByKeyAsync(used.key);
            return { component: usedSet.defaultVariant || usedSet.children[0] };
          }
          return { component: await figma.importComponentByKeyAsync(used.key) };
        } catch (e) {
          return { error: 'icon:' + name + ' is used on this page but could not be imported (' + errMsg(e) + ')' };
        }
      }
    }
    if (ref) {
      if (ref.key) {
        try {
          if (ref.set) {
            var set = await figma.importComponentSetByKeyAsync(ref.key);
            return { component: set.defaultVariant || set.children[0] };
          }
          return { component: await figma.importComponentByKeyAsync(ref.key) };
        } catch (e) { /* unpublished, or no access — try the node id below */ }
      }
      if (ref.nodeId && (!iconSource.fileKey || iconSource.fileKey === figma.fileKey)) {
        var node = await figma.getNodeByIdAsync(ref.nodeId);
        if (node && node.type === 'COMPONENT') return { component: node };
        if (node && node.type === 'COMPONENT_SET') return { component: node.defaultVariant || node.children[0] };
      }
      return { error: 'icon:' + name + ' could not be imported from "' + iconSource.name + '" (is that library published, and do you have access?)' };
    }
    // Not connected (or not in the set): icon components on the current page.
    var local = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    var want = iconNorm(name);
    for (var i = 0; i < local.length; i++) {
      if (iconNorm(local[i].name) !== want) continue;
      var sampleLocal = local[i].type === 'COMPONENT_SET' ? (local[i].defaultVariant || local[i].children[0]) : local[i];
      if (!ICON_PREFIX.test(local[i].name) && !looksLikeIcon(sampleLocal)) continue;
      return { component: local[i].type === 'COMPONENT_SET' ? (local[i].defaultVariant || local[i].children[0]) : local[i] };
    }
    if (!iconSource) return { error: 'icon:' + name + ' (no icon set for this file — pick one next to Icons in the plugin window, or open the icon library and connect it)' };
    return { error: 'icon:' + name + ' is not in "' + iconSource.name + '" — search with findIcons("' + short(iconKey(name)) + '")' };
  }

  // ============================================================================
  // setManifest — set the session-wide registry once. Pass the whole
  // figma.manifest.json ({ components, styles }) or a bare components map.
  // ============================================================================
  globalThis.setManifest = function (m) {
    var norm = normalizeManifest(m);
    globalThis.__BB_MANIFEST = norm.components;
    globalThis.__BB_STYLES = norm.styles;
    var n = Object.keys(norm.components).length;
    var s = Object.keys(norm.styles).length;
    console.log('🌉 [BetterBridge] Manifest set: ' + n + ' components, ' + s + ' styles');
    notifyChange();
    return { ok: true, components: n, styles: s };
  };

  // ============================================================================
  // manifestSummary — cheap component list for building/refreshing
  // figma.manifest.json. Current page only unless { allPages: true }.
  // Returns { "Name": { nodeId, key, props? } } — write straight into the
  // manifest's "components" object.
  // ============================================================================
  globalThis.manifestSummary = async function (opts) {
    opts = opts || {};
    var nodes = [];
    if (opts.allPages) {
      await figma.loadAllPagesAsync();
      for (var p = 0; p < figma.root.children.length; p++) {
        nodes = nodes.concat(
          figma.root.children[p].findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
        );
      }
    } else {
      nodes = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    }

    var out = {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      // skip individual variants — their parent COMPONENT_SET already represents them
      if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue;
      var entry = { nodeId: n.id, key: n.key || null };
      if (n.componentPropertyDefinitions) {
        var propNames = [];
        for (var pk in n.componentPropertyDefinitions) propNames.push(pk.split('#')[0]);
        if (propNames.length) entry.props = propNames;
      }
      out[n.name] = entry;
    }
    return out;
  };

  // ============================================================================
  // designSystem — is this file connected to a design system, and what's in it?
  //
  //   designSystem()                  → counts + library names (small)
  //   designSystem({ list: true })    → also every token name and style name
  //   designSystem({ refresh: true }) → re-read enabled libraries first
  //
  // `source`: "library" (tokens from an enabled library), "local" (this file's
  // own tokens/styles), or "none". Libraries that publish only styles or
  // components can't be detected by the plugin API — list those in the
  // manifest's `styles` / `components`.
  // ============================================================================
  globalThis.designSystem = async function (opts) {
    opts = opts || {};
    var ctx = makeCtx({}, null);
    var lib = await libraryIndex(!!opts.refresh);
    var local = await localIndex(ctx);
    var st = await styleIndex(ctx);

    var styles = {
      paint: st.PAINT.size + styleRefCount(ctx, 'PAINT'),
      text: st.TEXT.size + styleRefCount(ctx, 'TEXT'),
      effect: st.EFFECT.size + styleRefCount(ctx, 'EFFECT')
    };
    var source = lib.count ? 'library'
      : (local.count || styles.paint || styles.text || styles.effect) ? 'local'
      : 'none';

    var out = {
      connected: source !== 'none',
      source: source,
      libraries: lib.libraries,
      tokens: { local: local.count, library: lib.count },
      styles: styles,
      registry: Object.keys(globalThis.__BB_MANIFEST || {}).length,
      strict: strict,
      icons: iconSource
        ? { connected: true, name: iconSource.name, count: Object.keys(iconSource.icons).length }
        : { connected: false, count: 0, usedOnPage: await detectLibraryIcons() }
    };
    if (lib.error) out.libraryError = lib.error;
    if (local.error) out.localError = local.error;

    if (opts.list) {
      var tokens = {};
      var addTokens = function (idx) {
        idx.byName.forEach(function (list) {
          for (var i = 0; i < list.length; i++) {
            var group = list[i].library ? list[i].collection + ' (' + list[i].library + ')' : list[i].collection;
            (tokens[group] = tokens[group] || []).push(list[i].name);
          }
        });
      };
      addTokens(local);
      addTokens(lib);
      var styleList = {};
      ['PAINT', 'TEXT', 'EFFECT'].forEach(function (type) {
        st[type].forEach(function (s, name) { styleList[name] = { type: type, key: s.key || null }; });
      });
      for (var name in ctx.styleRefs) {
        if (ctx.styleRefs.hasOwnProperty(name) && !styleList[name]) styleList[name] = ctx.styleRefs[name];
      }
      out.list = { tokens: tokens, styles: styleList };
    }
    return out;
  };

  // ============================================================================
  // buildSpec — registry-aware declarative CREATE
  // ============================================================================
  globalThis.buildSpec = async function (spec) {
    if (!spec || !spec.build) throw new Error('buildSpec requires { build: <node> }');

    var m = spec.manifest ? normalizeManifest(spec.manifest) : null;
    var components = m ? m.components : (globalThis.__BB_MANIFEST || {});
    var ctx = makeCtx(spec, m && Object.keys(m.styles).length ? m.styles : null);
    checkFields(ctx, spec, BUILD_TOP_FIELDS, 'buildSpec');
    var reused = 0, made = 0;
    var rootRef = null; // first node created — removed again if the build throws

    function track(node) { if (!rootRef) rootRef = node; }

    var compScan = null;
    async function resolveComponent(name) {
      var ref = components[name];
      if (ref) {
        if (ref.key) {
          // A key can name a component or a whole component set (manifestSummary
          // lists sets). Try both before falling back to the local node id.
          try { return await figma.importComponentByKeyAsync(ref.key); } catch (e) {}
          if (figma.importComponentSetByKeyAsync) {
            try {
              var set = await figma.importComponentSetByKeyAsync(ref.key);
              if (set) return set.defaultVariant || set.children[0];
            } catch (e) {}
          }
        }
        if (ref.nodeId) {
          var n = await figma.getNodeByIdAsync(ref.nodeId);
          if (n && n.type === 'COMPONENT') return n;
          if (n && n.type === 'COMPONENT_SET') return n.defaultVariant || n.children[0];
        }
      }
      if (!compScan) {
        compScan = new Map();
        var found = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
        for (var j = 0; j < found.length; j++) {
          if (!compScan.has(found[j].name)) compScan.set(found[j].name, found[j]);
        }
      }
      var hit = compScan.get(name);
      if (!hit) return null;
      return hit.type === 'COMPONENT_SET' ? (hit.defaultVariant || hit.children[0]) : hit;
    }

    async function fillSlots(node, s) {
      var slots = node.findAllWithCriteria ? node.findAllWithCriteria({ types: ['SLOT'] }) : [];
      for (var slotName in s.slots) {
        if (!s.slots.hasOwnProperty(slotName)) continue;
        var slot = null;
        for (var si = 0; si < slots.length; si++) {
          if (slots[si].name === slotName) { slot = slots[si]; break; }
        }
        // No "first slot" fallback — content in the wrong slot is worse than a
        // visible miss.
        if (!slot) {
          ctx.unresolved.push('slot:' + slotName + ' on "' + s.use + '" (' +
            (slots.length ? 'slots: ' + slots.map(function (x) { return x.name; }).join(', ') : 'it has no slots') + ')');
          continue;
        }
        var items = Array.isArray(s.slots[slotName]) ? s.slots[slotName] : [s.slots[slotName]];
        // Built straight into the slot so "fill" sizing sees its real parent.
        for (var ii = 0; ii < items.length; ii++) await build(items[ii], slot);
      }
    }

    async function build(s, parent) {
      if (!s || typeof s !== 'object') {
        ctx.unresolved.push('node:' + JSON.stringify(s) + ' is not a node spec');
        return null;
      }
      var node;

      // ----- icon from the connected icon set -----
      if (s.icon) {
        checkFields(ctx, s, FIELDS.icon, 'icon "' + s.icon + '"');
        var ic = await resolveIcon(s.icon);
        if (!ic.component) { ctx.unresolved.push(ic.error); return null; }
        node = ic.component.createInstance();
        track(node);
        reused++;
        if (parent) parent.appendChild(node);
        if (s.name) node.name = s.name;
        applySizing(ctx, node, s.w, s.h);
        return node;
      }

      // ----- registry instance -----
      if (s.use) {
        checkFields(ctx, s, FIELDS.instance, 'instance "' + s.use + '"');
        var comp = await resolveComponent(s.use);
        if (!comp) { ctx.unresolved.push(s.use); return null; }
        node = comp.createInstance();
        track(node);
        reused++;
        if (parent) parent.appendChild(node);
        if (s.name) node.name = s.name;
        if (s.props) applyPropsToInstance(node, s.props, ctx, s.use);
        if (s.slots) await fillSlots(node, s);
        applySizing(ctx, node, s.w, s.h);
        return node;
      }

      // ----- primitive -----
      var t = String(s.type || 'frame').toLowerCase();
      if (!FIELDS[t] || t === 'instance') {
        ctx.unresolved.push('nodeType:' + s.type + ' (use frame, text, rectangle, ellipse, or `use` for a component)');
        return null;
      }
      checkFields(ctx, s, FIELDS[t], t + ' "' + short(s.name || s.text || '') + '"');

      if (t === 'text') {
        node = figma.createText();
        track(node);
        var styled = false;
        if (s.textStyle !== undefined) {
          styled = await applyTextStyle(ctx, node, s.textStyle);
          if (styled && (s.font !== undefined || s.size !== undefined)) {
            ctx.unresolved.push('ignored:font/size on text "' + short(s.text) + '" (textStyle wins)');
          }
        } else if ((await dsFlags(ctx)).text) {
          var noStyle = 'text "' + short(s.text) + '" has no textStyle';
          if (ctx.strict) ctx.unresolved.push('strict:' + noStyle);
          else ctx.offSystem.push(noStyle);
        }
        if (!styled) {
          var fam = 'Inter', sty = 'Regular';
          if (s.font) {
            var parts = s.font.split('/');
            fam = parts[0]; sty = parts[1] || 'Regular';
          }
          try {
            await figma.loadFontAsync({ family: fam, style: sty });
            node.fontName = { family: fam, style: sty };
          } catch (e) {
            ctx.unresolved.push('font:' + fam + '/' + sty);
            await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
            node.fontName = { family: 'Inter', style: 'Regular' };
          }
        }
        node.characters = s.text || '';
        if (!styled && typeof s.size === 'number') node.fontSize = s.size;
      } else if (t === 'rectangle') {
        node = figma.createRectangle();
        track(node);
      } else if (t === 'ellipse') {
        node = figma.createEllipse();
        track(node);
      } else {
        node = figma.createFrame();
        track(node);
      }
      made++;
      if (s.name) node.name = s.name;
      if (parent) parent.appendChild(node);

      if (s.layout !== undefined && s.layout !== null) {
        if (!LAYOUT[s.layout]) {
          ctx.unresolved.push('layout:' + s.layout + ' (use row or col)');
        } else {
          node.layoutMode = LAYOUT[s.layout];
          node.primaryAxisSizingMode = 'AUTO';
          node.counterAxisSizingMode = 'AUTO';
        }
      }
      if (t === 'frame') {
        var hasLayout = isAutoLayout(node);
        var noLayout = ' ignored on "' + short(node.name) + '" (needs layout: row or col)';
        if (s.align !== undefined && s.align !== null) {
          if (!hasLayout) ctx.unresolved.push('field:align' + noLayout);
          else if (!ALIGN[s.align]) ctx.unresolved.push('align:' + s.align + ' (use start, center, end, between)');
          else node.primaryAxisAlignItems = ALIGN[s.align];
        }
        if (s.cross !== undefined && s.cross !== null) {
          if (!hasLayout) ctx.unresolved.push('field:cross' + noLayout);
          else if (!CROSS[s.cross]) ctx.unresolved.push('cross:' + s.cross + ' (use start, center, end, stretch)');
          else node.counterAxisAlignItems = CROSS[s.cross];
        }
        if (s.gap !== undefined && s.gap !== null) {
          if (!hasLayout) ctx.unresolved.push('field:gap' + noLayout);
          else await applyNum(ctx, node, 'itemSpacing', s.gap, 'gap');
        }
        if (s.pad !== undefined && s.pad !== null) {
          if (!hasLayout) ctx.unresolved.push('field:pad' + noLayout);
          else await applyPad(ctx, node, s.pad);
        }
      }

      if (s.radius !== undefined && s.radius !== null && 'cornerRadius' in node) {
        await applyNum(ctx, node, 'cornerRadius', s.radius, 'radius');
      }
      await applyPaint(ctx, node, 'fills', s.fill, 'fill');
      await applyPaint(ctx, node, 'strokes', s.stroke, 'stroke');
      await applyEffect(ctx, node, s.effect);

      applySizing(ctx, node, s.w, s.h);

      if (t === 'frame' && s.children !== undefined) {
        if (!Array.isArray(s.children)) {
          ctx.unresolved.push('field:children on "' + short(node.name) + '" must be an array');
        } else {
          for (var ci = 0; ci < s.children.length; ci++) {
            await build(s.children[ci], node);
          }
        }
      }
      return node;
    }

    var parentNode = null;
    if (spec.parentId) {
      parentNode = await figma.getNodeByIdAsync(spec.parentId);
      if (!parentNode) ctx.unresolved.push('parent:' + spec.parentId);
      else if (!('appendChild' in parentNode)) { ctx.unresolved.push('parent:' + spec.parentId + ' (' + parentNode.type + ' can\'t have children)'); parentNode = null; }
    }

    var root;
    try {
      root = await build(spec.build, parentNode);
    } catch (e) {
      // Don't leave a half-built tree on the canvas.
      if (rootRef) { try { rootRef.remove(); } catch (e2) {} }
      throw new Error('Build failed and was rolled back: ' + errMsg(e) +
        (ctx.unresolved.length ? ' | unresolved: ' + dedupe(ctx.unresolved).join(', ') : ''));
    }
    if (!root) throw new Error('Nothing built. Unresolved: ' + dedupe(ctx.unresolved).join(', '));

    // atomic: all or nothing — any real miss removes the whole build. `ignored:`
    // notes (an instruction that was overridden, not missed) don't count.
    var misses = ctx.unresolved.filter(function (u) { return u.indexOf('ignored:') !== 0; });
    if (spec.atomic && misses.length) {
      try { root.remove(); } catch (e) {}
      return { removed: true, reused: 0, built: 0, unresolved: dedupe(ctx.unresolved) };
    }

    if (!root.parent) figma.currentPage.appendChild(root);
    if (spec.at) { root.x = spec.at.x || 0; root.y = spec.at.y || 0; }
    if (spec.select !== false && figma.currentPage.selection !== undefined) {
      figma.currentPage.selection = [root];
    }

    // Deliberately small — this is what enters Claude's context. w/h included
    // so a follow-up "did it come out the right size" call is often unnecessary.
    var out = {
      id: root.id,
      name: root.name,
      w: Math.round(root.width || 0),
      h: Math.round(root.height || 0),
      reused: reused,
      built: made
    };
    if (ctx.unresolved.length) out.unresolved = dedupe(ctx.unresolved);
    if (ctx.offSystem.length) out.offSystem = dedupe(ctx.offSystem);
    return out;
  };

  // ---- text edits (patchSpec) ----
  async function patchText(ctx, node, op) {
    var styled = false;
    if (op.textStyle !== undefined) {
      styled = await applyTextStyle(ctx, node, op.textStyle);
      if (styled && op.font) ctx.unresolved.push('ignored:font on ' + node.id + ' (textStyle wins)');
    }
    if (!styled && op.font) {
      var fp = op.font.split('/');
      var target = { family: fp[0], style: fp[1] || 'Regular' };
      try { await figma.loadFontAsync(target); node.fontName = target; }
      catch (e) { ctx.unresolved.push('font:' + target.family + '/' + target.style); }
    }
    if (op.text === undefined) return;
    if (node.fontName === figma.mixed) {
      // Mixed fonts: load every font in the layer so the edit can go through,
      // and say plainly that the mixed styling may not survive it.
      var fonts = node.getRangeAllFontNames(0, node.characters.length);
      for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
      ctx.unresolved.push('mixedFont:' + node.id + ' (text changed, but its mixed styling may be lost — pass font or textStyle to choose one)');
    } else {
      await figma.loadFontAsync(node.fontName);
    }
    node.characters = op.text;
  }

  // ============================================================================
  // patchSpec — modify EXISTING nodes by id. The missing "edit" half of
  // buildSpec: change a few fields on something already on the canvas
  // without resending or rebuilding the whole tree.
  //
  //   await patchSpec([
  //     { id: "12:345", text: "Golf Balls — Half Dozen" },
  //     { id: "12:349", props: { State: "Hover" } },
  //     { id: "12:350", fill: "color/surface/highlight" },
  //     { id: "12:351", remove: true }
  //   ])
  //
  // Fields: remove, name, text (+ optional font), textStyle, props (INSTANCE
  // only), fill, stroke, effect, gap, pad, radius, w, h.
  // Optional second argument: { strict: true }.
  // ============================================================================
  globalThis.patchSpec = async function (patch, opts) {
    var ops = Array.isArray(patch) ? patch : [patch];
    var ctx = makeCtx(opts, null);
    var patched = 0;
    var failed = [];

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      if (!op.id) { failed.push({ id: null, error: 'missing id' }); continue; }
      checkFields(ctx, op, PATCH_FIELDS, 'patch ' + op.id);
      var node = await figma.getNodeByIdAsync(op.id);
      if (!node) { failed.push({ id: op.id, error: 'not found' }); continue; }

      try {
        if (op.remove) { node.remove(); patched++; continue; }
        var isA = ' ignored on ' + op.id + ' (it is a ' + node.type + ')';
        if (op.name !== undefined) node.name = op.name;

        if (op.text !== undefined || op.font !== undefined || op.textStyle !== undefined) {
          if (node.type !== 'TEXT') ctx.unresolved.push('field:text/font/textStyle' + isA);
          else await patchText(ctx, node, op);
        }

        if (op.props !== undefined) {
          if (node.type !== 'INSTANCE') ctx.unresolved.push('field:props' + isA);
          else applyPropsToInstance(node, op.props, ctx, op.id);
        }

        await applyPaint(ctx, node, 'fills', op.fill, 'fill');
        await applyPaint(ctx, node, 'strokes', op.stroke, 'stroke');
        await applyEffect(ctx, node, op.effect);

        if (op.gap !== undefined) {
          if (!isAutoLayout(node)) ctx.unresolved.push('field:gap' + isA + ' without auto layout');
          else await applyNum(ctx, node, 'itemSpacing', op.gap, 'gap');
        }
        if (op.pad !== undefined) {
          if (!isAutoLayout(node)) ctx.unresolved.push('field:pad' + isA + ' without auto layout');
          else await applyPad(ctx, node, op.pad);
        }
        if (op.radius !== undefined) {
          if (!('cornerRadius' in node)) ctx.unresolved.push('field:radius' + isA);
          else await applyNum(ctx, node, 'cornerRadius', op.radius, 'radius');
        }
        if (op.w !== undefined || op.h !== undefined) applySizing(ctx, node, op.w, op.h);

        patched++;
      } catch (e) {
        failed.push({ id: op.id, error: errMsg(e) });
      }
    }

    var out = { patched: patched };
    if (failed.length) out.failed = failed;
    if (ctx.unresolved.length) out.unresolved = dedupe(ctx.unresolved);
    if (ctx.offSystem.length) out.offSystem = dedupe(ctx.offSystem);
    return out;
  };

  console.log('🌉 [BetterBridge] buildSpec / patchSpec / manifestSummary / designSystem / findIcons ready — call via figma_execute');
})();
