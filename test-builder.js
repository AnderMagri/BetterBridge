// Mock Figma Plugin API + assertions against the ACTUAL builder module source.
// Not a simulation of Figma's rendering — a check that the control flow, field
// names, and resolution order in _builder-module.js do what they claim to do.
const vm = require('vm');
const fs = require('fs');

let idCounter = 0;
function newId() { return 'mock:' + (++idCounter); }
const nodeIndex = new Map();

function baseNode(type, opts) {
  opts = opts || {};
  const n = {
    type,
    id: opts.id || newId(),
    name: opts.name || type,
    visible: true,
    x: 0, y: 0,
    width: opts.width || 100,
    height: opts.height || 100,
    parent: null,
    children: [],
    fills: [],
    strokes: [],
    strokeWeight: 0,
    cornerRadius: 0,
    boundVariables: {},
    appendChild(child) { child.parent = this; this.children.push(child); nodeIndex.set(child.id, child); },
    resize(w, h) { this.width = w; this.height = h; },
    setBoundVariable(field, variable) { this.boundVariables[field] = variable.id; this[field] = variable.mockValue; },
    findAllWithCriteria(crit) {
      const types = crit.types || [];
      const out = [];
      (function walk(node) {
        for (const c of node.children) {
          if (types.indexOf(c.type) !== -1) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
    remove() {
      if (this.parent) {
        const idx = this.parent.children.indexOf(this);
        if (idx !== -1) this.parent.children.splice(idx, 1);
      }
    }
  };
  if (['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].indexOf(type) !== -1) {
    n.layoutMode = 'NONE';
    n.itemSpacing = 0;
    n.paddingTop = n.paddingRight = n.paddingBottom = n.paddingLeft = 0;
    n.primaryAxisSizingMode = 'FIXED';
    n.counterAxisSizingMode = 'FIXED';
    n.layoutSizingHorizontal = 'FIXED';
    n.layoutSizingVertical = 'FIXED';
  }
  nodeIndex.set(n.id, n);
  return n;
}

function makeText(opts) {
  const n = baseNode('TEXT', opts);
  n.characters = '';
  n.fontSize = 12;
  n.fontName = { family: 'Inter', style: 'Regular' };
  return n;
}

function makeComponent(opts) {
  const n = baseNode('COMPONENT', opts);
  n.key = opts.key || null;
  n.componentPropertyDefinitions = opts.componentPropertyDefinitions || {};
  n.createInstance = function () {
    const inst = baseNode('INSTANCE', { name: n.name + ' Instance' });
    inst.mainComponent = n;
    inst.componentProperties = {};
    for (const k in n.componentPropertyDefinitions) {
      inst.componentProperties[k] = { value: n.componentPropertyDefinitions[k].defaultValue, type: n.componentPropertyDefinitions[k].type };
    }
    inst.setProperties = function (props) {
      for (const k in props) {
        if (inst.componentProperties[k]) inst.componentProperties[k].value = props[k];
        else throw new Error('Unknown property: ' + k);
      }
    };
    return inst;
  };
  return n;
}

const mockVariables = [
  { id: 'v1', name: 'spacing/md', mockValue: 12 },
  { id: 'v2', name: 'spacing/lg', mockValue: 16 },
  { id: 'v3', name: 'radius/lg', mockValue: 8 },
  { id: 'v4', name: 'color/surface/card', mockValue: '#ffffff' },
];

const currentPage = baseNode('PAGE', { name: 'Page 1' });
currentPage.selection = [];
const rootDoc = { children: [currentPage] };

const figmaMock = {
  createFrame: () => baseNode('FRAME', {}),
  createText: () => makeText({}),
  createRectangle: () => baseNode('RECTANGLE', {}),
  createEllipse: () => baseNode('ELLIPSE', {}),
  currentPage,
  root: rootDoc,
  mixed: Symbol('figma.mixed'),
  getNodeByIdAsync: async (id) => nodeIndex.get(id) || null,
  loadFontAsync: async () => {},
  loadAllPagesAsync: async () => {},
  importComponentByKeyAsync: async () => { throw new Error('no library in mock'); },
  variables: {
    getLocalVariablesAsync: async () => mockVariables,
    setBoundVariableForPaint: (paint, field, variable) => {
      paint.boundVariable = variable.id;
      return paint;
    }
  }
};

function hexToFigmaRGB(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substr(0, 2), 16) / 255,
    g: parseInt(h.substr(2, 2), 16) / 255,
    b: parseInt(h.substr(4, 2), 16) / 255
  };
}

const sandbox = { figma: figmaMock, hexToFigmaRGB, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./_builder-module.js', 'utf8'), sandbox, { filename: '_builder-module.js' });
const { buildSpec, patchSpec, manifestSummary } = sandbox;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  \u2705', label); }
  else { fail++; console.log('  \u274c', label); }
}

(async () => {
  console.log('--- 1: basic frame + text, numeric + hex ---');
  {
    const r = await buildSpec({
      build: {
        type: 'frame', name: 'Card', layout: 'col', gap: 12, pad: 16, radius: 8, fill: '#ffffff', w: 320, h: 'hug',
        children: [{ type: 'text', text: 'Hello', font: 'Inter/Semi Bold', size: 16 }]
      }
    });
    const node = nodeIndex.get(r.id);
    ok(node && node.name === 'Card', 'root created with correct name');
    ok(node.itemSpacing === 12, 'gap applied as raw number');
    ok(node.paddingTop === 16 && node.paddingLeft === 16, 'padding applied uniformly');
    ok(node.cornerRadius === 8, 'radius applied as raw number');
    ok(node.fills[0] && node.fills[0].color, 'hex fill applied');
    ok(node.children.length === 1 && node.children[0].characters === 'Hello', 'text child created correctly');
    ok(r.built === 2 && r.reused === 0, 'built/reused counts correct');
    ok(!r.unresolved, 'no unresolved entries for a fully-specified build');
  }

  console.log('--- 2: token-name gap/fill resolve to variables ---');
  {
    const r = await buildSpec({ build: { type: 'frame', name: 'Tokened', layout: 'row', gap: 'spacing/md', fill: 'color/surface/card' } });
    const node = nodeIndex.get(r.id);
    ok(node.boundVariables.itemSpacing === 'v1', 'gap bound to spacing/md variable');
    ok(node.fills[0].boundVariable === 'v4', 'fill bound to color/surface/card variable');
    ok(!r.unresolved, 'known tokens resolve without unresolved entries');
  }

  console.log('--- 3: unresolved token name is reported, not silently dropped ---');
  {
    const r = await buildSpec({ build: { type: 'frame', name: 'BadToken', layout: 'row', gap: 'spacing/doesnotexist' } });
    ok(r.unresolved && r.unresolved.indexOf('var:spacing/doesnotexist') !== -1, 'unknown variable name reported');
  }

  console.log('--- 4: registry reuse via manifest ---');
  {
    const btn = makeComponent({ name: 'Button/Primary', key: 'k123', componentPropertyDefinitions: { 'label#1:1': { type: 'TEXT', defaultValue: 'Click me' } } });
    currentPage.appendChild(btn);
    const r = await buildSpec({
      manifest: { 'Button/Primary': { nodeId: btn.id } },
      build: { type: 'frame', name: 'Wrap', children: [{ use: 'Button/Primary', props: { label: 'Add to cart' } }] }
    });
    const wrap = nodeIndex.get(r.id);
    const inst = wrap.children[0];
    ok(inst.type === 'INSTANCE', 'registry reference created an INSTANCE, not primitives');
    ok(inst.componentProperties['label#1:1'].value === 'Add to cart', 'instance property applied by base-name match');
    ok(r.reused === 1, 'reused count reflects the registry hit');
  }

  console.log('--- 5: unknown component name is reported, not faked ---');
  {
    let threw = false, msg = '';
    try { await buildSpec({ build: { use: 'Nonexistent/Component' } }); }
    catch (e) { threw = true; msg = e.message; }
    ok(threw && msg.indexOf('Nonexistent/Component') !== -1, 'fully-unresolved build throws rather than silently succeeding');
  }

  console.log('--- 6: patchSpec edits text in place ---');
  {
    const txt = makeText({ name: 'Label' });
    txt.characters = 'Old text';
    currentPage.appendChild(txt);
    const r = await patchSpec([{ id: txt.id, text: 'New text' }]);
    ok(txt.characters === 'New text', 'text content updated in place');
    ok(r.patched === 1, 'patch count correct');
  }

  console.log('--- 7: patchSpec edits instance props in place ---');
  {
    const btn2 = makeComponent({ name: 'Button/Secondary', componentPropertyDefinitions: { 'State#2:1': { type: 'VARIANT', defaultValue: 'Default' } } });
    currentPage.appendChild(btn2);
    const inst2 = btn2.createInstance();
    currentPage.appendChild(inst2);
    const r = await patchSpec([{ id: inst2.id, props: { State: 'Hover' } }]);
    ok(inst2.componentProperties['State#2:1'].value === 'Hover', 'instance property patched by base-name match');
    ok(r.patched === 1, 'patch count correct for prop edit');
  }

  console.log('--- 8: patchSpec reports missing node without throwing ---');
  {
    const r = await patchSpec([{ id: 'mock:doesnotexist', text: 'x' }]);
    ok(r.failed && r.failed[0].id === 'mock:doesnotexist', 'missing id reported in failed, not thrown');
    ok(r.patched === 0, 'patched count stays 0 for a fully-failed batch');
  }

  console.log('--- 9: patchSpec removes a node ---');
  {
    const parent = baseNode('FRAME', { name: 'Parent' });
    currentPage.appendChild(parent);
    const child = baseNode('RECTANGLE', { name: 'ToRemove' });
    parent.appendChild(child);
    const before = parent.children.length;
    await patchSpec([{ id: child.id, remove: true }]);
    ok(parent.children.length === before - 1, 'node removed from its parent');
  }

  console.log('--- 10: cornerRadius field-name regression check ---');
  {
    const box = baseNode('FRAME', { name: 'RadiusTest' });
    currentPage.appendChild(box);
    await patchSpec([{ id: box.id, radius: 20 }]);
    ok(box.cornerRadius === 20, 'patch sets cornerRadius (not a stray "radius" field)');
    ok(box.radius === undefined, 'no stray "radius" property was created on the node');
  }

  console.log('--- 11: manifestSummary shape ---');
  {
    const set = baseNode('COMPONENT_SET', { name: 'Badge' });
    const variant = makeComponent({ name: 'Variant=Default' });
    set.appendChild(variant);
    currentPage.appendChild(set);
    const single = makeComponent({ name: 'Icon/Star', key: 'kstar', componentPropertyDefinitions: { 'size#9:1': { type: 'TEXT' } } });
    currentPage.appendChild(single);

    const m = await manifestSummary();
    ok(m['Icon/Star'] && m['Icon/Star'].nodeId === single.id, 'standalone component present with nodeId');
    ok(m['Icon/Star'].key === 'kstar', 'component key captured when present');
    ok(Array.isArray(m['Icon/Star'].props) && m['Icon/Star'].props.indexOf('size') !== -1, 'prop base-names captured');
    ok(m['Variant=Default'] === undefined, 'variants inside a component set are excluded, not double-listed');
  }

  console.log('--- 12: patchSpec on a bad prop key degrades to unresolved, not a hard failure ---');
  {
    const btn3 = makeComponent({ name: 'Button/Tertiary', componentPropertyDefinitions: { 'label#3:1': { type: 'TEXT', defaultValue: 'x' } } });
    currentPage.appendChild(btn3);
    const inst3 = btn3.createInstance();
    currentPage.appendChild(inst3);
    const r = await patchSpec([{ id: inst3.id, props: { totallyMadeUp: 'y' } }]);
    ok(r.patched === 1, 'op still counts as patched (partial failure, not total)');
    ok(r.unresolved && r.unresolved.some(u => u.indexOf('props:') === 0), 'bad prop key surfaced in unresolved, not swallowed');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.stack || e); process.exit(1); });
