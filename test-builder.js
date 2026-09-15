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
    appendChild(child) {
      if (child.parent) { const i = child.parent.children.indexOf(child); if (i !== -1) child.parent.children.splice(i, 1); }
      child.parent = this; this.children.push(child); nodeIndex.set(child.id, child);
    },
    findOne(fn) {
      for (const c of this.children) {
        if (fn(c)) return c;
        const deep = c.findOne ? c.findOne(fn) : null;
        if (deep) return deep;
      }
      return null;
    },
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
    effects: [],
    async setFillStyleIdAsync(id) { this.fillStyleId = id; },
    async setStrokeStyleIdAsync(id) { this.strokeStyleId = id; if (!this.strokeWeight) this.strokeWeight = 1; },
    async setEffectStyleIdAsync(id) { this.effectStyleId = id; },
    remove() {
      this.removed = true;
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
  n.setTextStyleIdAsync = async function (id) { n.textStyleId = id; n.fontName = { family: 'Mock', style: 'Styled' }; };
  n.getRangeAllFontNames = function () { return n.mockRangeFonts || [n.fontName]; };
  return n;
}

function makeComponent(opts) {
  return addComponentBehavior(baseNode('COMPONENT', opts), opts);
}

function addComponentBehavior(n, opts) {
  opts = opts || {};
  n.type = 'COMPONENT';
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
  { id: 'v1', name: 'spacing/md', mockValue: 12, resolvedType: 'FLOAT', variableCollectionId: 'c1' },
  { id: 'v2', name: 'spacing/lg', mockValue: 16, resolvedType: 'FLOAT', variableCollectionId: 'c1' },
  { id: 'v3', name: 'radius/lg', mockValue: 8, resolvedType: 'FLOAT', variableCollectionId: 'c1' },
  { id: 'v4', name: 'color/surface/card', mockValue: '#ffffff', resolvedType: 'COLOR', variableCollectionId: 'c2' },
];
const mockCollections = [{ id: 'c1', name: 'Spacing' }, { id: 'c2', name: 'Semantic' }];

// Library side: what figma.teamLibrary reports for enabled libraries.
const mockLibrary = { collections: [], variables: {} };
const importedKeys = [];

// Local styles (mutable per test).
const mockStyles = { PAINT: [], TEXT: [], EFFECT: [] };
const libraryStyles = {}; // key -> style, for importStyleByKeyAsync
const libraryComponentSets = {}; // key -> component set
const mockFontFailures = { all: false };

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
  loadFontAsync: async () => { if (mockFontFailures.all) throw new Error('font unavailable'); },
  loadAllPagesAsync: async () => {},
  importComponentByKeyAsync: async () => { throw new Error('no library in mock'); },
  importComponentSetByKeyAsync: async (key) => { if (libraryComponentSets[key]) return libraryComponentSets[key]; throw new Error('no set'); },
  importStyleByKeyAsync: async (key) => { if (libraryStyles[key]) return libraryStyles[key]; throw new Error('style key not found'); },
  getLocalPaintStylesAsync: async () => mockStyles.PAINT,
  getLocalTextStylesAsync: async () => mockStyles.TEXT,
  getLocalEffectStylesAsync: async () => mockStyles.EFFECT,
  teamLibrary: {
    getAvailableLibraryVariableCollectionsAsync: async () => mockLibrary.collections,
    getVariablesInLibraryCollectionAsync: async (key) => mockLibrary.variables[key] || []
  },
  variables: {
    getLocalVariablesAsync: async () => mockVariables,
    getLocalVariableCollectionsAsync: async () => mockCollections,
    importVariableByKeyAsync: async (key) => {
      importedKeys.push(key);
      return { id: 'imported:' + key, name: key, mockValue: 'lib' };
    },
    setBoundVariableForPaint: (paint, field, variable) => {
      paint.boundVariable = variable.id;
      return paint;
    }
  }
};

function hexToFigmaRGB(hex) {
  const h = hex.replace('#', '');
  if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(h)) throw new Error('Invalid hex color: ' + hex);
  const out = {
    r: parseInt(h.substr(0, 2), 16) / 255,
    g: parseInt(h.substr(2, 2), 16) / 255,
    b: parseInt(h.substr(4, 2), 16) / 255
  };
  if (h.length === 8) out.a = parseInt(h.substr(6, 2), 16) / 255;
  return out;
}

const sandbox = { figma: figmaMock, hexToFigmaRGB, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./_builder-module.js', 'utf8'), sandbox, { filename: '_builder-module.js' });
vm.runInContext(fs.readFileSync('./_recipe-module.js', 'utf8'), sandbox, { filename: '_recipe-module.js' });
const { buildSpec, patchSpec, manifestSummary, designSystem, setManifest } = sandbox;
// Legacy sections 1-12 predate strict mode; they run with it off, and the
// strict sections below switch it back on.
sandbox.__bbSetStrict(false);
const has = (r, prefix) => !!(r.unresolved && r.unresolved.some(u => u.indexOf(prefix) === 0));

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

  // ==========================================================================
  // r3: nothing silent
  // ==========================================================================
  console.log('--- 13: misspelled / misplaced fields are reported ---');
  {
    const r = await buildSpec({ build: { type: 'frame', name: 'Typo', padding: 16, children: [{ type: 'text', text: 'Hi', layout: 'row' }] } });
    ok(has(r, 'field:padding'), 'unknown field "padding" reported');
    ok(has(r, 'field:layout ignored on text'), 'layout on a text node reported');
    const r2 = await buildSpec({ build: { type: 'frame', name: 'NoLayout', gap: 8, align: 'center' } });
    ok(has(r2, 'field:gap') && has(r2, 'field:align'), 'gap/align without layout reported, not silently skipped');
    const r3 = await buildSpec({ build: { type: 'frame', name: 'BadAlign', layout: 'row', align: 'middle' } });
    ok(has(r3, 'align:middle'), 'invalid align value reported');
    let msg = '';
    try { await buildSpec({ build: { type: 'button', name: 'Nope' } }); } catch (e) { msg = e.message; }
    ok(msg.indexOf('nodeType:button') !== -1, 'unknown node type is not silently built as a frame');
  }

  console.log('--- 14: sizing that Figma would reject is reported ---');
  {
    const r = await buildSpec({ build: { type: 'frame', name: 'HugNoLayout', w: 'hug' } });
    ok(has(r, 'size:w=hug'), 'hug on a frame without layout reported');
    const r2 = await buildSpec({ build: { type: 'frame', name: 'Outer', children: [{ type: 'frame', name: 'Inner', w: 'fill' }] } });
    ok(has(r2, 'size:w=fill'), 'fill inside a non-auto-layout parent reported');
    const r3 = await buildSpec({ build: { type: 'frame', name: 'Row', layout: 'row', children: [{ type: 'frame', name: 'Cell', w: 'fill' }] } });
    const cell = nodeIndex.get(r3.id).children[0];
    ok(!r3.unresolved && cell.layoutSizingHorizontal === 'FILL', 'fill inside an auto-layout parent applies cleanly');
    const r4 = await buildSpec({ build: { type: 'frame', name: 'Wide', w: 'wide' } });
    ok(has(r4, 'size:w="wide"'), 'nonsense sizing value reported');
  }

  console.log('--- 15: slots — no silent fallback into the first slot ---');
  {
    const card = makeComponent({ name: 'Card/Slotted' });
    const slotA = baseNode('SLOT', { name: 'header' });
    slotA.layoutMode = 'VERTICAL';
    const origCreate = card.createInstance;
    card.createInstance = function () {
      const inst = origCreate();
      const s = baseNode('SLOT', { name: 'header' });
      s.layoutMode = 'VERTICAL';
      inst.appendChild(s);
      return inst;
    };
    currentPage.appendChild(card);
    const r = await buildSpec({ build: { use: 'Card/Slotted', slots: { media: [{ type: 'text', text: 'x' }] } } });
    const inst = nodeIndex.get(r.id);
    ok(has(r, 'slot:media') && r.unresolved.join().indexOf('slots: header') !== -1, 'missing slot reported with the real slot names');
    ok(inst.children[0].children.length === 0, 'content was NOT dropped into the first slot');
    const r2 = await buildSpec({ build: { use: 'Card/Slotted', slots: { header: [{ type: 'frame', name: 'Hero', w: 'fill' }] } } });
    const inst2 = nodeIndex.get(r2.id);
    ok(inst2.children[0].children.length === 1 && !r2.unresolved, 'named slot filled; "fill" sees the slot as its parent');
  }

  console.log('--- 16: a build that throws is rolled back ---');
  {
    mockFontFailures.all = true;
    let msg = '';
    const before = idCounter;
    try { await buildSpec({ build: { type: 'frame', name: 'WillFail', layout: 'col', children: [{ type: 'text', text: 'boom' }] } }); }
    catch (e) { msg = e.message; }
    mockFontFailures.all = false;
    const root = nodeIndex.get('mock:' + (before + 1));
    ok(msg.indexOf('rolled back') !== -1, 'error says the build was rolled back');
    ok(root && root.name === 'WillFail' && root.removed === true, 'the half-built root was removed');
  }

  console.log('--- 17: atomic builds are all-or-nothing ---');
  {
    const r = await buildSpec({ atomic: true, build: { type: 'frame', name: 'Atomic', layout: 'row', gap: 'spacing/nope' } });
    ok(r.removed === true && !r.id && has(r, 'var:spacing/nope'), 'unresolved entry removes the whole build and says why');
  }

  console.log('--- 18: patchSpec reports fields that do not apply ---');
  {
    const frame = baseNode('FRAME', { name: 'PlainFrame' });
    currentPage.appendChild(frame);
    const r = await patchSpec([{ id: frame.id, text: 'nope', props: { State: 'Hover' }, gap: 8, colour: '#fff' }]);
    ok(has(r, 'field:text/font/textStyle'), 'text on a frame reported');
    ok(has(r, 'field:props'), 'props on a non-instance reported');
    ok(has(r, 'field:gap'), 'gap on a frame without auto layout reported');
    ok(has(r, 'field:colour'), 'unknown patch field reported');
  }

  console.log('--- 19: patchSpec edits mixed-font text instead of failing ---');
  {
    const txt = makeText({ name: 'Mixed' });
    txt.characters = 'Bold and regular';
    txt.fontName = figmaMock.mixed;
    txt.mockRangeFonts = [{ family: 'Inter', style: 'Bold' }, { family: 'Inter', style: 'Regular' }];
    currentPage.appendChild(txt);
    const r = await patchSpec([{ id: txt.id, text: 'Changed' }]);
    ok(txt.characters === 'Changed' && r.patched === 1, 'mixed-font text edited');
    ok(has(r, 'mixedFont:'), 'possible loss of mixed styling is reported');
  }

  // ==========================================================================
  // r3: design system — library tokens, styles, strict mode
  // ==========================================================================
  console.log('--- 20: library tokens resolve and import by key ---');
  {
    mockLibrary.collections = [{ key: 'lc1', name: 'Brand', libraryName: 'Acme DS' }];
    mockLibrary.variables = { lc1: [
      { key: 'lk-primary', name: 'color/brand/primary', resolvedType: 'COLOR' },
      { key: 'lk-space', name: 'spacing/xl', resolvedType: 'FLOAT' },
      { key: 'lk-card', name: 'color/surface/card', resolvedType: 'COLOR' }
    ] };
    await designSystem({ refresh: true });
    const r = await buildSpec({ build: { type: 'frame', name: 'LibTok', layout: 'row', gap: 'spacing/xl', fill: 'color/brand/primary' } });
    const node = nodeIndex.get(r.id);
    ok(!r.unresolved, 'library token names resolve');
    ok(node.boundVariables.itemSpacing === 'imported:lk-space', 'gap bound to the imported library variable');
    ok(node.fills[0].boundVariable === 'imported:lk-primary', 'fill bound to the imported library variable');
  }

  console.log('--- 21: local beats library; wrong type and ambiguity are reported ---');
  {
    const r = await buildSpec({ build: { type: 'frame', name: 'LocalWins', fill: 'color/surface/card' } });
    ok(nodeIndex.get(r.id).fills[0].boundVariable === 'v4', 'local variable wins over a same-named library one');
    const r2 = await buildSpec({ build: { type: 'frame', name: 'WrongType', fill: 'spacing/md' } });
    ok(has(r2, 'varType:spacing/md is FLOAT'), 'number token used as a colour reported as a type mismatch');
    mockLibrary.collections.push({ key: 'lc2', name: 'Legacy', libraryName: 'Old DS' });
    mockLibrary.variables.lc2 = [{ key: 'lk-old-primary', name: 'color/brand/primary', resolvedType: 'COLOR' }];
    await designSystem({ refresh: true });
    const r3 = await buildSpec({ build: { type: 'frame', name: 'Ambiguous', fill: 'color/brand/primary' } });
    ok(has(r3, 'ambiguous:color/brand/primary'), 'same name in two libraries is reported, not guessed');
    const r4 = await buildSpec({ build: { type: 'frame', name: 'Scoped', fill: 'Legacy:color/brand/primary' } });
    ok(!r4.unresolved && nodeIndex.get(r4.id).fills[0].boundVariable === 'imported:lk-old-primary', 'collection prefix picks one');
  }

  console.log('--- 22: styles — paint, text, effect, and library styles by key ---');
  {
    mockStyles.PAINT.push({ id: 'S:paint1', name: 'Brand/Accent', type: 'PAINT', key: 'pk1' });
    mockStyles.TEXT.push({ id: 'S:text1', name: 'Heading/H1', type: 'TEXT', key: 'tk1', fontName: { family: 'Mock', style: 'Styled' } });
    mockStyles.EFFECT.push({ id: 'S:fx1', name: 'Shadow/Card', type: 'EFFECT', key: 'ek1' });
    const r = await buildSpec({ build: {
      type: 'frame', name: 'Styled', layout: 'col', fill: 'Brand/Accent', effect: 'Shadow/Card',
      children: [{ type: 'text', text: 'Title', textStyle: 'Heading/H1', size: 40 }]
    } });
    const node = nodeIndex.get(r.id);
    ok(node.fillStyleId === 'S:paint1', 'fill name falls back to a paint style');
    ok(node.effectStyleId === 'S:fx1', 'effect style applied');
    ok(node.children[0].textStyleId === 'S:text1', 'text style applied');
    ok(node.children[0].fontSize !== 40 && has(r, 'ignored:font/size'), 'raw size ignored when a textStyle is set, and said so');

    libraryStyles['remote-h2'] = { id: 'S:remote-h2', name: 'Heading/H2', type: 'TEXT', key: 'remote-h2', fontName: { family: 'Mock', style: 'Styled' } };
    setManifest({ components: {}, styles: { 'Heading/H2': { type: 'TEXT', key: 'remote-h2' } } });
    const r2 = await buildSpec({ build: { type: 'text', text: 'Sub', textStyle: 'Heading/H2' } });
    ok(nodeIndex.get(r2.id).textStyleId === 'S:remote-h2' && !r2.unresolved, 'library text style imported by key from the manifest');
    const r3 = await buildSpec({ build: { type: 'text', text: 'x', textStyle: 'Heading/Nope' } });
    ok(has(r3, 'textStyle:Heading/Nope'), 'unknown text style reported');
    setManifest({});
  }

  console.log('--- 23: strict mode refuses raw values when a design system exists ---');
  {
    sandbox.__bbSetStrict(true);
    const r = await buildSpec({ build: {
      type: 'frame', name: 'Strict', layout: 'row', gap: 12, pad: 0, fill: '#ff0000', radius: 'radius/lg',
      children: [{ type: 'text', text: 'Unstyled' }]
    } });
    const node = nodeIndex.get(r.id);
    ok(has(r, 'strict:gap 12') && node.itemSpacing === 0, 'raw gap refused');
    ok(has(r, 'strict:fill #ff0000') && node.fills.length === 0, 'raw hex refused');
    ok(!has(r, 'strict:pad'), 'zero is allowed');
    ok(node.boundVariables.cornerRadius === 'v3', 'tokens still apply');
    ok(has(r, 'strict:text "Unstyled" has no textStyle'), 'text without a text style flagged');

    const r2 = await buildSpec({ strict: false, build: { type: 'frame', name: 'TryOff', layout: 'row', gap: 12 } });
    ok(has(r2, 'ignored:strict:false') && has(r2, 'strict:gap'), 'a spec cannot switch strict mode off');

    const inst = baseNode('FRAME', { name: 'PatchStrict' });
    currentPage.appendChild(inst);
    const r3 = await patchSpec([{ id: inst.id, fill: '#00ff00' }]);
    ok(has(r3, 'strict:fill') && inst.fills.length === 0, 'patchSpec honours strict mode too');

    sandbox.__bbSetStrict(false);
    const r4 = await buildSpec({ build: { type: 'frame', name: 'Loose', layout: 'row', gap: 12, fill: '#ff0000' } });
    ok(!r4.unresolved && r4.offSystem && r4.offSystem.indexOf('gap:12') !== -1 && r4.offSystem.indexOf('fill:#ff0000') !== -1,
      'strict off: raw values apply but are listed in offSystem');
  }

  console.log('--- 24: designSystem() status ---');
  {
    const ds = await designSystem();
    ok(ds.connected === true && ds.source === 'library', 'connected to a library design system');
    ok(ds.libraries.indexOf('Acme DS') !== -1 && ds.tokens.library === 4 && ds.tokens.local === 4, 'library names and token counts');
    ok(ds.styles.text === 1 && ds.styles.paint === 1 && ds.styles.effect === 1, 'style counts');
    ok(ds.list === undefined, 'names are not listed unless asked (keeps it small)');
    const full = await designSystem({ list: true });
    ok(full.list.tokens['Brand (Acme DS)'].indexOf('color/brand/primary') !== -1, 'list groups tokens by collection and library');
    ok(full.list.styles['Heading/H1'].type === 'TEXT', 'list includes styles with their type');
  }

  console.log('--- 25: a component-set key imports the set ---');
  {
    const set = baseNode('COMPONENT_SET', { name: 'Chip' });
    const def = makeComponent({ name: 'State=Default' });
    set.appendChild(def);
    set.defaultVariant = def;
    libraryComponentSets['set-key'] = set;
    const r = await buildSpec({ manifest: { 'Chip': { key: 'set-key' } }, build: { use: 'Chip' } });
    ok(nodeIndex.get(r.id).type === 'INSTANCE' && r.reused === 1, 'set key resolves to its default variant');
  }

  console.log('--- 26: code.js ships the same module the tests run ---');
  {
    const code = fs.readFileSync('./code.js', 'utf8');
    const mod = fs.readFileSync('./_builder-module.js', 'utf8');
    ok(code.indexOf(mod.trim()) !== -1, 'code.js contains _builder-module.js verbatim');
  }

  // ==========================================================================
  // r4: icon sources
  // ==========================================================================
  console.log('--- 26b: icons — connect, search, build, and honest misses ---');
  {
    const { iconSummary, findIcons } = sandbox;
    let r0 = await buildSpec({ build: { icon: 'arrow-right' } }).catch(e => ({ error: e.message }));
    ok(r0.error && r0.error.indexOf('no icon set for this file') !== -1, 'without a connected set, the miss says how to pick or connect one');

    // An icon library file: an "Icons" page plus an Icon/ component elsewhere.
    const iconsPage = baseNode('PAGE', { name: '🔣 Icons' });
    const arrow = makeComponent({ name: 'arrow-right', key: 'ik-arrow' });
    iconsPage.appendChild(arrow);
    const chevSet = baseNode('COMPONENT_SET', { name: 'Chevron' });
    chevSet.key = 'ik-chevron';
    const chevDefault = makeComponent({ name: 'Size=24' });
    chevSet.appendChild(chevDefault);
    chevSet.defaultVariant = chevDefault;
    iconsPage.appendChild(chevSet);
    const star = makeComponent({ name: 'Icon/Star', key: null });
    currentPage.appendChild(star);
    rootDoc.children.push(iconsPage);
    rootDoc.name = 'Acme Icons';
    figmaMock.fileKey = 'icons-file';

    const summary = await iconSummary();
    ok(summary.name === 'Acme Icons' && summary.count === 3, 'iconSummary finds icons by page name and by "Icon/" prefix');
    ok(summary.icons['arrow-right'].key === 'ik-arrow' && summary.icons['Chevron'].set === true, 'keys and component sets captured');
    ok(summary.icons['Star'] && !summary.icons['Button/Primary'], '"Icon/" prefix stripped; ordinary components ignored');

    sandbox.__bbSetIconSource(summary);
    const found = await findIcons('chev');
    ok(found.connected && found.icons.length === 1 && found.icons[0] === 'Chevron' && found.total === 3, 'findIcons searches without returning the whole set');

    libraryComponentSets['ik-chevron'] = chevSet;
    figmaMock.importComponentByKeyAsync = async (key) => { if (key === 'ik-arrow') return arrow; throw new Error('not published'); };
    const r = await buildSpec({ build: { type: 'frame', name: 'IconRow', layout: 'row', children: [
      { icon: 'arrow-right' }, { icon: 'chevron', name: 'Next' }, { icon: 'Icon/Star' }
    ] } });
    const row = nodeIndex.get(r.id);
    ok(!r.unresolved && row.children.length === 3 && row.children.every(c => c.type === 'INSTANCE'), 'icons placed as real instances (key, set key, case-insensitive, prefixed name)');
    ok(row.children[1].name === 'Next', 'icon instance can be named');

    const r2 = await buildSpec({ build: { type: 'frame', name: 'Missing', layout: 'row', children: [{ icon: 'rocket' }] } });
    ok(has(r2, 'icon:rocket is not in "Acme Icons"') && r2.unresolved[0].indexOf('findIcons') !== -1, 'unknown icon reported with a search hint');

    figmaMock.fileKey = 'another-file';
    const r3 = await buildSpec({ build: { type: 'frame', name: 'OtherFile', layout: 'row', children: [{ icon: 'Star' }] } });
    ok(has(r3, 'icon:Star could not be imported'), 'unpublished icon from another file reported, not faked');

    const ds = await designSystem();
    ok(ds.icons.connected && ds.icons.name === 'Acme Icons' && ds.icons.count === 3, 'designSystem() reports the icon source');
    sandbox.__bbSetIconSource(null);
    ok((await designSystem()).icons.connected === false && (await findIcons('x')).connected === false, 'disconnecting clears it');
    figmaMock.importComponentByKeyAsync = async () => { throw new Error('no library in mock'); };
    figmaMock.fileKey = undefined;
  }

  console.log('--- 26c: library icons already used on the page work without connecting ---');
  {
    const { findIcons } = sandbox;
    const libSet = baseNode('COMPONENT_SET', { name: 'Icon/Home' });
    const libVariant = makeComponent({ name: 'Size=24' });
    libSet.appendChild(libVariant);
    libSet.defaultVariant = libVariant;
    libraryComponentSets['k-home-set'] = libSet;

    const placed = baseNode('INSTANCE', { name: 'Icon/Home', width: 24, height: 24 });
    placed.getMainComponentAsync = async () => ({ remote: true, name: 'Size=24', key: 'k-home-24', parent: { type: 'COMPONENT_SET', name: 'Icon/Home', key: 'k-home-set' } });
    const avatar = baseNode('INSTANCE', { name: 'Avatar', width: 32, height: 32 });
    avatar.getMainComponentAsync = async () => ({ remote: true, name: 'Avatar', key: 'k-avatar', parent: null });
    const localIcon = baseNode('INSTANCE', { name: 'Icon/Local', width: 24, height: 24 });
    localIcon.getMainComponentAsync = async () => ({ remote: false, name: 'Icon/Local', key: 'k-local', parent: null });
    currentPage.appendChild(placed); currentPage.appendChild(avatar); currentPage.appendChild(localIcon);

    const ds = await designSystem();
    ok(ds.icons.connected === false && ds.icons.usedOnPage === 1, 'one library icon detected (avatar and local icon ignored)');
    ok(sandbox.__bbDetectedIconKeys().indexOf('k-home-set') !== -1, 'detected keys exposed for auto-picking a saved set');
    const found = await findIcons('ho');
    ok(found.connected === false && found.icons[0] === 'Home', 'findIcons falls back to icons used on the page');
    const r = await buildSpec({ build: { type: 'frame', name: 'UsesDetected', layout: 'row', children: [{ icon: 'home' }] } });
    ok(!r.unresolved && nodeIndex.get(r.id).children[0].type === 'INSTANCE', 'a detected library icon can be placed by name');
    [placed, avatar, localIcon].forEach(n => n.remove());
    await designSystem();
  }

  // ==========================================================================
  // r4: saved actions — recipes and the actions/ folder
  // ==========================================================================
  // Variable/style creation for the recipe runner. Added last so the builder
  // sections above keep their fixed fixtures.
  let collCounter = 0, varCounter = 0, styleCounter = 0;
  figmaMock.variables.createVariableCollection = (name) => {
    const c = { id: 'rc' + (++collCounter), name, modes: [{ modeId: 'm' + collCounter + '-0', name: 'Mode 1' }] };
    c.renameMode = (id, n) => { c.modes.find(m => m.modeId === id).name = n; };
    c.addMode = (n) => { const id = c.id + '-m' + c.modes.length; c.modes.push({ modeId: id, name: n }); return id; };
    mockCollections.push(c);
    return c;
  };
  figmaMock.variables.createVariable = (name, collection, type) => {
    const v = { id: 'rv' + (++varCounter), name, resolvedType: type, variableCollectionId: collection.id, valuesByMode: {}, scopes: ['ALL_SCOPES'] };
    v.setValueForMode = (modeId, value) => { v.valuesByMode[modeId] = value; };
    mockVariables.push(v);
    return v;
  };
  figmaMock.variables.createVariableAlias = (v) => ({ type: 'VARIABLE_ALIAS', id: v.id });
  figmaMock.createTextStyle = () => { const st = { id: 'rts' + (++styleCounter), type: 'TEXT', name: '' }; mockStyles.TEXT.push(st); return st; };
  figmaMock.createEffectStyle = () => { const st = { id: 'res' + (++styleCounter), type: 'EFFECT', name: '' }; mockStyles.EFFECT.push(st); return st; };
  const { runRecipe } = sandbox;
  // A fresh, empty file for the recipe sections.
  mockVariables.length = 0;
  mockCollections.length = 0;
  mockStyles.PAINT.length = 0; mockStyles.TEXT.length = 0; mockStyles.EFFECT.length = 0;
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

  console.log('--- 27: the published DS foundation recipe runs cleanly ---');
  {
    const recipe = readJson('./actions/recipes/create-ds-foundation.json');
    const r = await runRecipe(recipe);
    ok(r.ok === true && !r.unresolved, 'no unresolved entries' + (r.unresolved ? ': ' + r.unresolved.slice(0, 3).join(' | ') : ''));
    ok(r.created.collections === 3, 'three collections created (Primitives, Semantic, Dimensions)');
    ok(r.created.variables === 117, '117 variables created');
    ok(r.created.textStyles === 10 && r.created.effectStyles === 5, '10 text styles and 5 effect styles created');
    const semantic = mockCollections.find(c => c.name === 'Semantic');
    ok(semantic.modes.map(m => m.name).join() === 'Light,Dark', 'Semantic collection has Light and Dark modes');
    const textPrimary = mockVariables.find(v => v.name === 'color/text/primary');
    const gray900 = mockVariables.find(v => v.name === 'color/gray/900');
    ok(textPrimary.valuesByMode[semantic.modes[0].modeId].id === gray900.id, 'semantic token aliases its primitive');
    ok(mockVariables.find(v => v.name === 'color/gray/50').scopes.length === 0, 'primitives are hidden from pickers (no scopes)');
    ok(mockVariables.find(v => v.name === 'spacing/md').scopes.join() === 'GAP', 'spacing tokens scoped to gap/padding');
    const shadow = mockStyles.EFFECT.find(st => st.name === 'Shadow/Level-1');
    ok(shadow && Math.abs(shadow.effects[0].color.a - 0.05) < 0.01, 'shadow colour keeps its alpha');
  }

  console.log('--- 28: running a recipe again changes nothing ---');
  {
    const before = mockVariables.length;
    const r = await runRecipe(readJson('./actions/recipes/create-ds-foundation.json'));
    ok(mockVariables.length === before && r.created.variables === 0 && r.skipped.variables === 117, 'existing variables skipped, not duplicated');
    ok(r.created.collections === 0 && r.skipped.textStyles === 10 && r.skipped.effectStyles === 5, 'collections and styles reused');
  }

  console.log('--- 28b: an existing collection is never given new modes ---');
  {
    const theirs = figmaMock.variables.createVariableCollection('Brand');
    const r = await runRecipe({ steps: [{ do: 'collection', name: 'Brand', modes: ['Light', 'Dark'], variables: [
      { name: 'brand/primary', type: 'COLOR', values: { Light: '#2563EB', Dark: '#3B82F6' } }
    ] }] });
    ok(theirs.modes.length === 1, 'their collection keeps its own modes');
    ok(r.unresolved && r.unresolved.some(u => u.indexOf('mode:Brand already exists without mode "Light"') === 0), 'the mismatch is reported');
  }

  console.log('--- 29: recipes report what they cannot do ---');
  {
    const r = await runRecipe({ steps: [
      { do: 'deleteEverything' },
      { do: 'collection', name: 'Broken', modes: ['Value'], variables: [
        { name: 'a/missing-alias', type: 'COLOR', value: '{color/nope}' },
        { name: 'a/bad-hex', type: 'COLOR', value: '#zzzzzz' },
        { name: 'a/no-type', value: 1 },
        { name: 'a/bad-scope', type: 'FLOAT', value: 4, scopes: ['GAP', 'EVERYWHERE'] }
      ] }
    ] });
    const has29 = (p) => r.unresolved.some(u => u.indexOf(p) === 0);
    ok(r.ok === false, 'result is not ok');
    ok(has29('step:deleteEverything'), 'unknown step type refused (recipes are data, not code)');
    ok(has29('alias:a/missing-alias'), 'missing alias target reported');
    ok(has29('value:a/bad-hex'), 'bad hex reported');
    ok(has29('variable:a/no-type'), 'variable without a type reported');
    ok(has29('scopes:a/bad-scope'), 'unknown scope reported');
  }

  console.log('--- 30: builder resolves the recipe\'s tokens and styles ---');
  {
    sandbox.__bbSetStrict(true);
    mockLibrary.collections = []; mockLibrary.variables = {};
    await designSystem({ refresh: true });
    const r = await buildSpec({ build: {
      type: 'frame', name: 'FromRecipe', layout: 'col', gap: 'spacing/md', pad: 'spacing/lg', radius: 'radius/lg',
      fill: 'color/surface/default', effect: 'Shadow/Level-1',
      children: [{ type: 'text', text: 'Hello', textStyle: 'Heading/H3', fill: 'color/text/primary' }]
    } });
    ok(!r.unresolved, 'a strict build using only recipe names has nothing unresolved' + (r.unresolved ? ': ' + r.unresolved.join(' | ') : ''));
    sandbox.__bbSetStrict(false);
  }

  console.log('--- 30b: the DS page recipe builds pages, specimens and components ---');
  {
    let pageCount = 0, propCounter = 0;
    figmaMock.createPage = () => { const pg = baseNode('PAGE', { name: 'Page ' + (++pageCount + 1) }); pg.selection = []; rootDoc.children.push(pg); return pg; };
    figmaMock.setCurrentPageAsync = async (pg) => { figmaMock.currentPage = pg; };
    figmaMock.createSection = () => {
      const sec = baseNode('SECTION', {});
      sec.resizeWithoutConstraints = function (w, h) { this.width = w; this.height = h; };
      figmaMock.currentPage.appendChild(sec);
      return sec;
    };
    figmaMock.createComponentFromNode = (n) => addComponentBehavior(n, {});
    figmaMock.combineAsVariants = (nodes, parentNode) => {
      const set = baseNode('COMPONENT_SET', {});
      set.componentPropertyDefinitions = {};
      nodes.forEach(n => set.appendChild(n));
      parentNode.appendChild(set);
      set.defaultVariant = nodes[0];
      set.addComponentProperty = (name, type, def) => { const key = name + '#9:' + (++propCounter); set.componentPropertyDefinitions[key] = { type, defaultValue: def }; return key; };
      return set;
    };
    const pageRecipe = readJson('./actions/recipes/create-ds-page.json');

    // Without the foundation, the recipe stops instead of drawing half a page.
    const savedCollections = mockCollections.splice(0, mockCollections.length);
    const stopped = await runRecipe(pageRecipe);
    mockCollections.push(...savedCollections);
    ok(stopped.stopped === true && stopped.created.pages === 0 && stopped.unresolved[0].indexOf('Create DS foundation') !== -1, 'stops with "run the foundation first" when it is missing');

    sandbox.__bbSetStrict(true);
    const r = await runRecipe(pageRecipe);
    ok(r.ok === true && !r.unresolved, 'runs cleanly in strict mode' + (r.unresolved ? ': ' + r.unresolved.slice(0, 4).join(' | ') : ''));
    ok(r.created.pages === 1 && r.created.sections === 5, 'Design System page with 5 sections');
    ok(r.created.components === 3 && r.created.nodes === 2, 'Button and Input sets, Card component, swatches and specimens');
    const dsPage = rootDoc.children.find(pg => pg.name === 'Design System');
    ok(figmaMock.currentPage === dsPage, 'the page is opened');
    const section = (name) => dsPage.children.find(c => c.type === 'SECTION' && c.name === name);
    const button = section('Buttons').children.find(c => c.name === 'Button');
    ok(button && button.type === 'COMPONENT_SET' && button.children.length === 6, 'Button set has 6 variants');
    ok(button.children[0].name === 'Variant=Primary, State=Default', 'variants named Property=Value');
    const labelKey = Object.keys(button.componentPropertyDefinitions).find(k => k.indexOf('Label#') === 0);
    ok(labelKey && button.children.every(v => v.findOne(n => n.name === 'Label').componentPropertyReferences.characters === labelKey), 'every variant label is bound to one Label property');
    const card = section('Cards').children.find(c => c.name === 'Card');
    ok(card && card.type === 'COMPONENT' && card.findOne(n => n.type === 'INSTANCE'), 'Card is a component containing a Button instance');
    const swatches = section('Colors').children[0];
    const swatchCount = []; (function walk(n) { n.children.forEach(ch => { if (ch.name === 'Swatch') swatchCount.push(ch); walk(ch); }); })(swatches);
    ok(swatchCount.length === 19 && swatchCount.every(sw => sw.fills[0] && sw.fills[0].boundVariable), 'one bound swatch per Semantic color token');
    // The mock doesn't run auto layout, so only the minimum size is checkable here.
    ok(section('Colors').width >= 480 && section('Colors').children[0].x === 64 && section('Buttons').x > section('Typography').x, 'section contents padded and sections laid out left to right');

    const again = await runRecipe(pageRecipe);
    const createdAgain = Object.values(again.created).reduce((a, b) => a + b, 0);
    ok(createdAgain === 0 && again.skipped.sections === 5 && again.skipped.nodes === 5, 'running it again creates nothing');
    sandbox.__bbSetStrict(false);
  }

  console.log('--- 31: actions/index.json points at real recipes ---');
  {
    const index = readJson('./actions/index.json');
    const FILE = /^recipes\/[A-Za-z0-9._-]+\.json$/;
    ok(Array.isArray(index.actions) && index.actions.length > 0, 'index lists actions');
    for (const a of index.actions) {
      const exists = FILE.test(a.file) && fs.existsSync('./actions/' + a.file);
      ok(a.id && a.title && a.description && a.kind === 'recipe' && exists, 'action "' + a.id + '" is a complete recipe entry and its file exists');
      ok(Array.isArray(readJson('./actions/' + a.file).steps), 'recipe "' + a.id + '" parses');
    }
    ok(!fs.existsSync('./actions/prompts'), 'no prompt actions left');
    const ui = fs.readFileSync('./ui.html', 'utf8');
    ok(ui.indexOf('var BB_ACTION_FILE = /^recipes\\/[A-Za-z0-9._-]+\\.json$/;') !== -1, 'ui.html uses the same file-name rule');
  }

  console.log('--- 32: code.js ships the recipe module the tests ran ---');
  {
    const code = fs.readFileSync('./code.js', 'utf8');
    ok(code.indexOf(fs.readFileSync('./_recipe-module.js', 'utf8').trim()) !== -1, 'code.js contains _recipe-module.js verbatim');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.stack || e); process.exit(1); });
