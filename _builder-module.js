// ============================================================================
// BETTERBRIDGE BUILDER MODULE
// ----------------------------------------------------------------------------
// Three functions on globalThis, all callable from figma_execute with NO
// MCP-server changes:
//
//   buildSpec({ build: <node> })   — create, registry-aware
//   patchSpec([{ id, ... }])       — edit EXISTING nodes by id
//   manifestSummary()              — cheap {name: {nodeId,key,props}} export
//   setManifest({...})             — set the session registry once
//
// WHY: verbose expansion (font loading, variable binding, instance creation,
// slot filling) happens HERE, inside the plugin, where it costs zero model
// tokens. Every return value is deliberately small — that's what crosses
// back into Claude's context.
// ============================================================================
(function () {
  var ALIGN = { center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN', start: 'MIN' };
  var CROSS = { center: 'CENTER', end: 'MAX', stretch: 'STRETCH', start: 'MIN' };

  function makeCtx() { return { varMap: null, unresolved: [] }; }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  // ---- variable resolution (one scan per top-level call, cached in ctx) ----
  async function resolveVar(ctx, name) {
    if (typeof name !== 'string') return null;
    if (!ctx.varMap) {
      ctx.varMap = new Map();
      var all = await figma.variables.getLocalVariablesAsync();
      for (var i = 0; i < all.length; i++) ctx.varMap.set(all[i].name, all[i]);
    }
    return ctx.varMap.get(name) || null;
  }

  // ---- a numeric field that may be a token NAME or a raw number ----
  async function applyNum(ctx, node, field, value) {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') { try { node[field] = value; } catch (e) {} return; }
    var v = await resolveVar(ctx, value);
    if (v) { try { node.setBoundVariable(field, v); } catch (e) { ctx.unresolved.push('bind:' + value); } }
    else ctx.unresolved.push('var:' + value);
  }

  // ---- a SOLID paint from a token NAME or a "#hex" string ----
  async function paintFrom(ctx, value) {
    if (value === null || value === undefined) return null;
    // check hex first — cheap, and avoids an unneeded variable scan
    if (typeof value === 'string' && value.charAt(0) === '#') {
      var rgb = hexToFigmaRGB(value); // reuses the plugin's own helper
      var hexPaint = { type: 'SOLID', color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: 1 };
      if (rgb.a !== undefined) hexPaint.opacity = rgb.a;
      return hexPaint;
    }
    var v = await resolveVar(ctx, value);
    if (v) {
      var paint = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 };
      return figma.variables.setBoundVariableForPaint(paint, 'color', v);
    }
    ctx.unresolved.push('color:' + value);
    return null;
  }

  function applySizing(node, w, h) {
    if (typeof w === 'number' || typeof h === 'number') {
      try {
        node.resize(typeof w === 'number' ? w : node.width,
                    typeof h === 'number' ? h : node.height);
      } catch (e) {}
    }
    var map = { hug: 'HUG', fill: 'FILL' };
    if (map[w]) { try { node.layoutSizingHorizontal = map[w]; } catch (e) {} }
    if (map[h]) { try { node.layoutSizingVertical = map[h]; } catch (e) {} }
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
    catch (e) { ctx.unresolved.push('props:' + label + ' (' + (e && e.message ? e.message : e) + ')'); }
  }

  // ============================================================================
  // setManifest — set the session-wide component registry once
  // ============================================================================
  globalThis.setManifest = function (m) {
    globalThis.__BB_MANIFEST = m || {};
    var n = Object.keys(globalThis.__BB_MANIFEST).length;
    console.log('🌉 [BetterBridge] Manifest set: ' + n + ' components');
    return { ok: true, components: n };
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
  // buildSpec — registry-aware declarative CREATE
  // ============================================================================
  globalThis.buildSpec = async function (spec) {
    if (!spec || !spec.build) throw new Error('buildSpec requires { build: <node> }');

    var manifest = spec.manifest || globalThis.__BB_MANIFEST || {};
    var ctx = makeCtx();
    var reused = 0, made = 0;

    var compScan = null;
    async function resolveComponent(name) {
      var ref = manifest[name];
      if (ref) {
        if (ref.key) {
          try { return await figma.importComponentByKeyAsync(ref.key); } catch (e) {}
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

    async function build(node_spec, parent) {
      var node;

      // ----- registry instance -----
      if (node_spec.use) {
        var comp = await resolveComponent(node_spec.use);
        if (!comp) { ctx.unresolved.push(node_spec.use); return null; }
        node = comp.createInstance();
        reused++;
        if (parent) parent.appendChild(node);
        if (node_spec.props) applyPropsToInstance(node, node_spec.props, ctx, node_spec.use);

        if (node_spec.slots && node.findAllWithCriteria) {
          var slots = node.findAllWithCriteria({ types: ['SLOT'] });
          for (var slotName in node_spec.slots) {
            if (!node_spec.slots.hasOwnProperty(slotName)) continue;
            var slot = null;
            for (var si = 0; si < slots.length; si++) {
              if (slots[si].name === slotName) { slot = slots[si]; break; }
            }
            if (!slot) slot = slots[0];
            if (!slot) { ctx.unresolved.push('slot:' + slotName); continue; }
            var items = node_spec.slots[slotName];
            for (var ii = 0; ii < items.length; ii++) {
              var child = await build(items[ii], null);
              if (child) slot.appendChild(child);
            }
          }
        }
        applySizing(node, node_spec.w, node_spec.h);
        return node;
      }

      // ----- primitive -----
      var t = (node_spec.type || 'frame').toLowerCase();
      if (t === 'text') {
        node = figma.createText();
        var fam = 'Inter', sty = 'Regular';
        if (node_spec.font) {
          var parts = node_spec.font.split('/');
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
        node.characters = node_spec.text || '';
        if (typeof node_spec.size === 'number') node.fontSize = node_spec.size;
      } else if (t === 'rectangle') {
        node = figma.createRectangle();
      } else if (t === 'ellipse') {
        node = figma.createEllipse();
      } else {
        node = figma.createFrame();
      }
      made++;
      if (node_spec.name) node.name = node_spec.name;
      if (parent) parent.appendChild(node);

      if (node_spec.layout && 'layoutMode' in node) {
        node.layoutMode = node_spec.layout === 'row' ? 'HORIZONTAL' : 'VERTICAL';
        node.primaryAxisSizingMode = 'AUTO';
        node.counterAxisSizingMode = 'AUTO';
        if (node_spec.align && ALIGN[node_spec.align]) node.primaryAxisAlignItems = ALIGN[node_spec.align];
        if (node_spec.cross && CROSS[node_spec.cross]) node.counterAxisAlignItems = CROSS[node_spec.cross];
        await applyNum(ctx, node, 'itemSpacing', node_spec.gap);
        if (node_spec.pad !== null && node_spec.pad !== undefined) {
          var p = Array.isArray(node_spec.pad)
            ? node_spec.pad
            : [node_spec.pad, node_spec.pad, node_spec.pad, node_spec.pad];
          await applyNum(ctx, node, 'paddingTop', p[0]);
          await applyNum(ctx, node, 'paddingRight', p[1]);
          await applyNum(ctx, node, 'paddingBottom', p[2]);
          await applyNum(ctx, node, 'paddingLeft', p[3]);
        }
      }

      if (node_spec.radius !== null && node_spec.radius !== undefined && 'cornerRadius' in node) {
        await applyNum(ctx, node, 'cornerRadius', node_spec.radius);
      }
      if ('fills' in node && node_spec.fill !== undefined) {
        var fp = await paintFrom(ctx, node_spec.fill);
        if (fp) node.fills = [fp];
      }
      if ('strokes' in node && node_spec.stroke !== undefined) {
        var sp = await paintFrom(ctx, node_spec.stroke);
        if (sp) { node.strokes = [sp]; if (!node.strokeWeight) node.strokeWeight = 1; }
      }

      applySizing(node, node_spec.w, node_spec.h);

      if (node_spec.children && 'appendChild' in node) {
        for (var ci = 0; ci < node_spec.children.length; ci++) {
          await build(node_spec.children[ci], node);
        }
      }
      return node;
    }

    var parentNode = null;
    if (spec.parentId) {
      parentNode = await figma.getNodeByIdAsync(spec.parentId);
      if (!parentNode) ctx.unresolved.push('parent:' + spec.parentId);
    }

    var root = await build(spec.build, parentNode && 'appendChild' in parentNode ? parentNode : null);
    if (!root) throw new Error('Nothing built. Unresolved: ' + ctx.unresolved.join(', '));

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
    return out;
  };

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
  // Fields: remove, name, text (+ optional font for mixed-style text),
  // props (INSTANCE only), fill, stroke, gap, pad, radius, w, h.
  // ============================================================================
  globalThis.patchSpec = async function (patch) {
    var ops = Array.isArray(patch) ? patch : [patch];
    var ctx = makeCtx();
    var patched = 0;
    var failed = [];

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      if (!op.id) { failed.push({ id: null, error: 'missing id' }); continue; }
      var node = await figma.getNodeByIdAsync(op.id);
      if (!node) { failed.push({ id: op.id, error: 'not found' }); continue; }

      try {
        if (op.remove) { node.remove(); patched++; continue; }
        if (op.name !== undefined) node.name = op.name;

        if (op.text !== undefined && node.type === 'TEXT') {
          // A text node with mixed fonts across its characters can't just take
          // new characters — Figma requires a uniform font first. Use the
          // node's own font when uniform; require an explicit `font` override
          // ("Family/Style") when it's mixed.
          var targetFont = null;
          if (op.font) {
            var fp2 = op.font.split('/');
            targetFont = { family: fp2[0], style: fp2[1] || 'Regular' };
          } else if (node.fontName && node.fontName !== figma.mixed) {
            targetFont = node.fontName;
          }
          if (targetFont) {
            try { await figma.loadFontAsync(targetFont); node.fontName = targetFont; }
            catch (e) { ctx.unresolved.push('font:' + targetFont.family + '/' + targetFont.style); }
          } else {
            ctx.unresolved.push('mixedFont:' + op.id + ' (pass `font` to override)');
          }
          node.characters = op.text;
        }

        if (op.props !== undefined && node.type === 'INSTANCE') {
          applyPropsToInstance(node, op.props, ctx, op.id);
        }

        if (op.fill !== undefined && 'fills' in node) {
          var fp = await paintFrom(ctx, op.fill);
          if (fp) node.fills = [fp];
        }
        if (op.stroke !== undefined && 'strokes' in node) {
          var sp = await paintFrom(ctx, op.stroke);
          if (sp) { node.strokes = [sp]; if (!node.strokeWeight) node.strokeWeight = 1; }
        }
        if (op.gap !== undefined && 'itemSpacing' in node) {
          await applyNum(ctx, node, 'itemSpacing', op.gap);
        }
        if (op.pad !== undefined && 'paddingTop' in node) {
          var p = Array.isArray(op.pad) ? op.pad : [op.pad, op.pad, op.pad, op.pad];
          await applyNum(ctx, node, 'paddingTop', p[0]);
          await applyNum(ctx, node, 'paddingRight', p[1]);
          await applyNum(ctx, node, 'paddingBottom', p[2]);
          await applyNum(ctx, node, 'paddingLeft', p[3]);
        }
        if (op.radius !== undefined && 'cornerRadius' in node) {
          await applyNum(ctx, node, 'cornerRadius', op.radius);
        }
        if (op.w !== undefined || op.h !== undefined) applySizing(node, op.w, op.h);

        patched++;
      } catch (e) {
        failed.push({ id: op.id, error: e && e.message ? e.message : String(e) });
      }
    }

    var out = { patched: patched };
    if (failed.length) out.failed = failed;
    if (ctx.unresolved.length) out.unresolved = dedupe(ctx.unresolved);
    return out;
  };

  console.log('🌉 [BetterBridge] buildSpec / patchSpec / manifestSummary ready — call via figma_execute');
})();
