// renderer.js — MLP Paint, a small MS Paint style drawing app.
(() => {
  'use strict';

  const BACKGROUND = '#ffffff';
  const ZOOM_LEVELS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
  const MIN_ZOOM = ZOOM_LEVELS[0];
  const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  const MIN_CANVAS = { w: 320, h: 240 };
  const MAX_CANVAS_SIDE = 8000;
  const WORKSPACE_MARGIN = 20; // keep in sync with .stage padding in index.css
  const MAX_HISTORY_ENTRIES = 100;
  const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
  const TEXT_LINE_HEIGHT = 1.25;
  const SHAPES = ['line', 'rectangle', 'ellipse', 'triangle'];
  const TOOL_KEYS = { p: 'pen', e: 'eraser', t: 'text', l: 'line', r: 'rectangle', o: 'ellipse' };

  const state = {
    tool: 'pen',
    color: '#000000',
    brushSize: 3,
    eraserSize: 20,
    fillShapes: false,
    font: { family: 'sans-serif', size: 24, bold: false, italic: false },
    zoom: 1,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const isShape = (tool) => SHAPES.includes(tool);

  let canvas, ctx, overlay, octx, backup, bctx;
  let workspace, wrap, editor, shapeBox, brushCursor, sizeTip, ghost;

  let drag = null;    // pointer interaction in progress on the canvas
  let textPos = null; // canvas position of the open text box, null when no box is open
  let unsaved = false;

  // ---------------------------------------------------------------------------
  // Setup

  function init() {
    canvas = $('#canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    overlay = $('#overlay');
    octx = overlay.getContext('2d');
    // Mirror of the last committed drawing; undo entries are cut from it.
    backup = document.createElement('canvas');
    bctx = backup.getContext('2d', { willReadFrequently: true });

    workspace = $('#workspace');
    wrap = $('#canvas-wrap');
    editor = $('#text-editor');
    shapeBox = $('#shape-box');
    brushCursor = $('#brush-cursor');
    sizeTip = $('#size-tip');
    ghost = $('#resize-ghost');

    for (const btn of $$('[data-color]')) btn.style.backgroundColor = btn.dataset.color;
    for (const btn of $$('[data-size]')) btn.style.setProperty('--size', `${Math.min(btn.dataset.size, 12)}px`);
    state.font.family = $('#font-family').value;
    state.font.size = Number($('#font-size').value);

    bindEvents();
    const fit = windowCanvasSize();
    setCanvasSize(Math.max(fit.w, MIN_CANVAS.w), Math.max(fit.h, MIN_CANVAS.h));
    syncUI();
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    // Keep the text box focused while its color/style is changed from the ribbon.
    document.addEventListener('mousedown', (e) => {
      if (textPos && e.target.closest('button')) e.preventDefault();
    });

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);
    overlay.addEventListener('lostpointercapture', onPointerUp);
    overlay.addEventListener('pointerleave', () => {
      if (drag) return;
      brushCursor.hidden = true;
      $('#status-pos').textContent = '';
    });

    workspace.addEventListener('pointerdown', (e) => {
      if (e.target === workspace || e.target.classList.contains('stage')) commitText();
    });
    workspace.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const speed = e.deltaMode === 1 ? 0.05 : 0.002;
      setZoom(state.zoom * Math.exp(-e.deltaY * speed), e);
    }, { passive: false });

    editor.addEventListener('input', layoutEditor);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        commitText();
      }
    });

    $('#size-range').addEventListener('input', (e) => setSize(e.target.value));
    $('#custom-color').addEventListener('input', (e) => setColor(e.target.value));
    $('#font-family').addEventListener('change', (e) => setFont({ family: e.target.value }));
    $('#font-size').addEventListener('change', (e) => setFont({ size: Number(e.target.value) }));
    $('#zoom-slider').addEventListener('input', (e) => setZoom(2 ** Number(e.target.value)));
    $('#canvas-size-form').addEventListener('submit', (e) => {
      e.preventDefault();
      resizeCanvas(Number($('#canvas-w').value), Number($('#canvas-h').value));
    });

    for (const handle of $$('.resize-handle')) handle.addEventListener('pointerdown', startCanvasResize);

    document.addEventListener('fullscreenchange', () => {
      $('[data-action="fullscreen"]').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
    });
    window.addEventListener('beforeunload', (e) => {
      if (!unsaved) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  const actions = {
    'undo': () => undo(),
    'redo': () => redo(),
    'clear': () => clearCanvas(),
    'save': () => saveDrawing(),
    'toggle-fill': () => { state.fillShapes = !state.fillShapes; syncUI(); },
    'toggle-bold': () => setFont({ bold: !state.font.bold }),
    'toggle-italic': () => setFont({ italic: !state.font.italic }),
    'zoom-in': () => zoomStep(1),
    'zoom-out': () => zoomStep(-1),
    'zoom-reset': () => setZoom(1),
    'zoom-fit': () => zoomToFit(),
    'toggle-grid': (btn) => btn.setAttribute('aria-pressed', String(document.body.classList.toggle('show-grid'))),
    'toggle-status': (btn) => btn.setAttribute('aria-pressed', String(!document.body.classList.toggle('hide-status'))),
    'fullscreen': () => toggleFullscreen(),
    'canvas-fill': () => {
      const fit = windowCanvasSize();
      resizeCanvas(fit.w, fit.h);
    },
  };

  function onClick(e) {
    const el = e.target.closest('[data-tab], [data-tool], [data-size], [data-color], [data-action]');
    if (!el || el.disabled) return;
    const { tab, tool, size, color, action } = el.dataset;
    if (tab) switchTab(tab);
    else if (tool) selectTool(tool);
    else if (size) setSize(size);
    else if (color) setColor(color);
    else if (actions[action]) actions[action](el);
  }

  // Inputs where plain keys must keep their normal meaning.
  function isTypingTarget(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['range', 'color', 'checkbox', 'radio', 'button'].includes(el.type);
  }

  function onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      saveDrawing();
      return;
    }
    if (isTypingTarget(e.target)) return;

    if (mod && !e.altKey) {
      let handled = true;
      if (key === 'z' && !e.shiftKey) undo();
      else if (key === 'y' || key === 'z') redo();
      else if (key === '=' || key === '+') zoomStep(1);
      else if (key === '-') zoomStep(-1);
      else if (key === '0') setZoom(1);
      else handled = false;
      if (handled) e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (key === 'escape' && drag) {
      endDrag(false);
      return;
    }
    if (TOOL_KEYS[key] && !e.repeat) selectTool(TOOL_KEYS[key]);
  }

  // ---------------------------------------------------------------------------
  // Tool state

  function selectTool(tool) {
    if (drag) endDrag(true);
    if (tool !== 'text') commitText();
    state.tool = tool;
    brushCursor.hidden = true;
    syncUI();
  }

  function setColor(color) {
    state.color = color.toLowerCase();
    syncUI();
    refocusEditor();
  }

  function sizeKey() {
    return state.tool === 'eraser' ? 'eraserSize' : 'brushSize';
  }

  function setSize(size) {
    state[sizeKey()] = clamp(Math.round(Number(size)) || 1, 1, 100);
    syncUI();
  }

  function setFont(changes) {
    Object.assign(state.font, changes);
    syncUI();
    refocusEditor();
  }

  function syncUI() {
    const pressed = (el, on) => el.setAttribute('aria-pressed', String(on));

    for (const btn of $$('[data-tool]')) pressed(btn, btn.dataset.tool === state.tool);

    const size = state[sizeKey()];
    for (const btn of $$('[data-size]')) pressed(btn, Number(btn.dataset.size) === size);
    $('#size-range').value = size;
    $('#size-value').textContent = `${size} px`;
    $('#size-title').textContent = state.tool === 'eraser' ? 'Eraser size' : 'Size';

    for (const btn of $$('[data-color]')) pressed(btn, btn.dataset.color.toLowerCase() === state.color);
    $('#current-color').style.backgroundColor = state.color;
    $('#custom-color').value = state.color;

    pressed($('[data-action="toggle-fill"]'), state.fillShapes);
    pressed($('[data-action="toggle-bold"]'), state.font.bold);
    pressed($('[data-action="toggle-italic"]'), state.font.italic);
    $('#font-family').value = state.font.family;
    $('#font-size').value = String(state.font.size);

    const textMode = state.tool === 'text';
    $('#group-size').hidden = textMode;
    $('#group-text').hidden = !textMode;
    wrap.dataset.activeTool = state.tool;

    layoutEditor();
    updateHint();
    updateHistoryButtons();
  }

  function updateHint() {
    let hint = '';
    if (textPos) hint = 'Type your text · Ctrl+Enter, Esc or click outside the box to place it';
    else if (state.tool === 'text') hint = 'Click on the canvas where the text should go';
    else if (state.tool === 'line') hint = 'Drag to draw · hold Shift to snap to 45°';
    else if (isShape(state.tool)) hint = 'Drag to draw · hold Shift for equal width and height · Esc cancels';
    $('#status-hint').textContent = hint;
  }

  function switchTab(name) {
    for (const tab of $$('[data-tab]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
    }
  }

  function toggleFullscreen() {
    const request = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    request?.catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Pointer input

  function toCanvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * canvas.width / rect.width,
      y: (e.clientY - rect.top) * canvas.height / rect.height,
    };
  }

  function onPointerDown(e) {
    if (e.button !== 0 || drag) return;
    e.preventDefault(); // keeps focus where we put it (the text box)
    const p = toCanvasPoint(e);

    if (state.tool === 'text') {
      // Like Paint: a click outside an open box places it, the next click starts a new one.
      if (textPos) commitText();
      else openEditor(p);
      return;
    }

    overlay.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, tool: state.tool, start: p, end: p, constrain: e.shiftKey };
    if (isShape(drag.tool)) {
      drag.size = state.brushSize;
      drag.color = state.color;
      drag.fill = state.fillShapes;
      previewShape();
    } else {
      beginStroke(p);
    }
  }

  function onPointerMove(e) {
    const p = toCanvasPoint(e);
    showPointer(p);
    if (!drag || e.pointerId !== drag.id) return;
    if (isShape(drag.tool)) {
      drag.end = p;
      drag.constrain = e.shiftKey;
      previewShape();
    } else {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      extendStroke((events.length ? events : [e]).map(toCanvasPoint));
    }
  }

  function onPointerUp(e) {
    if (drag && e.pointerId === drag.id) endDrag(true);
  }

  // Finish (keep = true) or cancel the drag in progress.
  function endDrag(keep) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (overlay.hasPointerCapture(d.id)) overlay.releasePointerCapture(d.id);
    octx.clearRect(0, 0, overlay.width, overlay.height);

    if (isShape(d.tool)) {
      shapeBox.hidden = true;
      sizeTip.hidden = true;
      $('#status-sel').textContent = '';
      const g = shapeGeometry(d);
      if (keep && (g.x0 !== g.x1 || g.y0 !== g.y1)) {
        paintShape(ctx, d, g);
        const pad = d.size + 2;
        commitRect(Math.min(g.x0, g.x1) - pad, Math.min(g.y0, g.y1) - pad,
          Math.abs(g.x1 - g.x0) + 2 * pad, Math.abs(g.y1 - g.y0) + 2 * pad);
      }
    } else if (keep) {
      paintStroke(ctx, d);
      const b = d.bounds;
      const pad = d.size / 2 + 2;
      commitRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
    }
  }

  // Status bar position plus the round brush/eraser outline under the pointer.
  function showPointer(p) {
    $('#status-pos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)} px`;
    const tool = drag ? drag.tool : state.tool;
    const diameter = (tool === 'eraser' ? state.eraserSize : state.brushSize) * state.zoom;
    const show = (tool === 'eraser' && diameter >= 3) || (tool === 'pen' && diameter >= 8);
    brushCursor.hidden = !show;
    if (!show) return;
    Object.assign(brushCursor.style, {
      left: `${p.x * state.zoom}px`,
      top: `${p.y * state.zoom}px`,
      width: `${diameter}px`,
      height: `${diameter}px`,
    });
  }

  // ---------------------------------------------------------------------------
  // Pen and eraser

  // The stroke in progress lives on the overlay as one path, so segment joins
  // don't pile up into dots; it is painted onto the canvas when released.
  function beginStroke(p) {
    drag.size = drag.tool === 'eraser' ? state.eraserSize : state.brushSize;
    drag.color = drag.tool === 'eraser' ? BACKGROUND : state.color;
    drag.bounds = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    drag.points = [p];
    octx.clearRect(0, 0, overlay.width, overlay.height);
    paintStroke(octx, drag);
  }

  function extendStroke(points) {
    const b = drag.bounds;
    for (const p of points) {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) continue;
      drag.points.push(p);
      b.x0 = Math.min(b.x0, p.x);
      b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x);
      b.y1 = Math.max(b.y1, p.y);
    }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    paintStroke(octx, drag);
  }

  function paintStroke(c, d) {
    const pts = d.points;
    c.save();
    c.fillStyle = d.color;
    c.strokeStyle = d.color;
    c.lineWidth = d.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (pts.length === 1) {
      // A dot, so a single click leaves a mark.
      c.arc(pts[0].x, pts[0].y, d.size / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      // Curving through the midpoints smooths out mouse jitter.
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
      }
      c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      c.stroke();
    }
    c.restore();
  }

  // ---------------------------------------------------------------------------
  // Shapes

  function shapeGeometry(d) {
    let { x: x0, y: y0 } = d.start;
    let { x: x1, y: y1 } = d.end;
    if (d.constrain) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      if (d.tool === 'line') {
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const length = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(angle) * length;
        y1 = y0 + Math.sin(angle) * length;
      } else {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = x0 + Math.sign(dx || 1) * side;
        y1 = y0 + Math.sign(dy || 1) * side;
      }
    }
    // Odd line widths sit on half pixels, so snapping there keeps edges crisp.
    const offset = d.size % 2 ? 0.5 : 0;
    const snap = (v) => Math.round(v - offset) + offset;
    return { x0: snap(x0), y0: snap(y0), x1: snap(x1), y1: snap(y1) };
  }

  function paintShape(c, d, g) {
    const left = Math.min(g.x0, g.x1);
    const top = Math.min(g.y0, g.y1);
    const w = Math.abs(g.x1 - g.x0);
    const h = Math.abs(g.y1 - g.y0);

    c.save();
    c.lineWidth = d.size;
    c.strokeStyle = d.color;
    c.fillStyle = d.color;
    c.lineCap = 'round';
    c.lineJoin = d.tool === 'rectangle' ? 'miter' : 'round';
    c.beginPath();
    switch (d.tool) {
      case 'line':
        c.moveTo(g.x0, g.y0);
        c.lineTo(g.x1, g.y1);
        break;
      case 'rectangle':
        c.rect(left, top, w, h);
        break;
      case 'ellipse':
        c.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        break;
      case 'triangle':
        // The apex sits on the edge where the drag started, so dragging up draws it upside down.
        c.moveTo((g.x0 + g.x1) / 2, g.y0);
        c.lineTo(g.x1, g.y1);
        c.lineTo(g.x0, g.y1);
        c.closePath();
        break;
    }
    if (d.fill && d.tool !== 'line') c.fill();
    c.stroke();
    c.restore();
  }

  // Live preview on the overlay, with a dashed bounding box and a size label.
  function previewShape() {
    const d = drag;
    const g = shapeGeometry(d);
    const z = state.zoom;
    const w = Math.round(Math.abs(g.x1 - g.x0));
    const h = Math.round(Math.abs(g.y1 - g.y0));

    octx.clearRect(0, 0, overlay.width, overlay.height);
    paintShape(octx, d, g);

    // Box sits just outside the outline so it doesn't hide the preview.
    const pad = (d.size / 2) * z + 4;
    shapeBox.hidden = d.tool === 'line';
    Object.assign(shapeBox.style, {
      left: `${Math.min(g.x0, g.x1) * z - pad}px`,
      top: `${Math.min(g.y0, g.y1) * z - pad}px`,
      width: `${w * z + 2 * pad}px`,
      height: `${h * z + 2 * pad}px`,
    });

    const label = d.tool === 'line'
      ? `${Math.round(Math.hypot(w, h))} px`
      : `${w} × ${h} px`;
    sizeTip.textContent = label;
    sizeTip.hidden = false;
    sizeTip.style.left = `${g.x1 * z + 14}px`;
    sizeTip.style.top = `${g.y1 * z + 14}px`;
    $('#status-sel').textContent = `${w} × ${h} px`;
  }

  // ---------------------------------------------------------------------------
  // Text

  function fontCss(px) {
    const f = state.font;
    return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${px}px ${f.family}`;
  }

  function openEditor(p) {
    textPos = { x: Math.round(p.x), y: Math.round(p.y) };
    editor.value = '';
    editor.hidden = false;
    layoutEditor();
    editor.focus({ preventScroll: true });
    updateHint();
  }

  function refocusEditor() {
    if (textPos) editor.focus({ preventScroll: true });
  }

  // Match the text box to the font, color and zoom, and grow it with its content.
  function layoutEditor() {
    if (!textPos) return;
    const z = state.zoom;
    const px = state.font.size * z;
    const s = editor.style;
    s.left = `${textPos.x * z}px`;
    s.top = `${textPos.y * z}px`;
    s.font = fontCss(px);
    s.lineHeight = String(TEXT_LINE_HEIGHT);
    s.color = state.color;
    s.width = '0';
    s.height = '0';
    s.width = `${Math.max(editor.scrollWidth, px) + px / 2}px`;
    s.height = `${editor.scrollHeight}px`;
  }

  function commitText() {
    if (!textPos) return;
    const { x, y } = textPos;
    const text = editor.value.replace(/\s+$/, '');
    textPos = null;
    if (document.activeElement === editor) editor.blur();
    editor.hidden = true;
    editor.value = '';
    updateHint();
    if (!text) return;

    const size = state.font.size;
    const lineHeight = size * TEXT_LINE_HEIGHT;
    const lines = text.split('\n');
    ctx.save();
    ctx.font = fontCss(size);
    ctx.fillStyle = state.color;
    ctx.textBaseline = 'alphabetic';
    // Put the baseline where CSS puts it in each line box, so the result matches the text box.
    const metrics = ctx.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent ?? size * 0.9;
    const descent = metrics.fontBoundingBoxDescent ?? size * 0.25;
    const baseline = (lineHeight - ascent - descent) / 2 + ascent;
    let width = 0;
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y + i * lineHeight + baseline);
      width = Math.max(width, ctx.measureText(line).width);
    });
    ctx.restore();
    commitRect(x - size, y - size, width + 2 * size, lines.length * lineHeight + 2 * size);
  }

  // ---------------------------------------------------------------------------
  // History: each entry keeps only the changed rectangle, before and after.

  const undoStack = [];
  const redoStack = [];
  let historyBytes = 0;

  const entryBytes = (entry) => entry.before.data.length + entry.after.data.length;

  // Clamp a rectangle to the canvas and round it out to whole pixels.
  function pixelRect(x, y, w, h) {
    const x0 = clamp(Math.floor(x), 0, canvas.width);
    const y0 = clamp(Math.floor(y), 0, canvas.height);
    const x1 = clamp(Math.ceil(x + w), 0, canvas.width);
    const y1 = clamp(Math.ceil(y + h), 0, canvas.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  // Record what changed inside the rectangle since the last commit.
  function commitRect(x, y, w, h) {
    const r = pixelRect(x, y, w, h);
    if (!r) return;
    const before = bctx.getImageData(r.x, r.y, r.w, r.h);
    const after = ctx.getImageData(r.x, r.y, r.w, r.h);
    bctx.putImageData(after, r.x, r.y);
    pushHistory({ x: r.x, y: r.y, before, after, resize: false });
  }

  function pushHistory(entry) {
    for (const old of redoStack) historyBytes -= entryBytes(old);
    redoStack.length = 0;
    undoStack.push(entry);
    historyBytes += entryBytes(entry);
    while (undoStack.length > 1 && (undoStack.length > MAX_HISTORY_ENTRIES || historyBytes > MAX_HISTORY_BYTES)) {
      historyBytes -= entryBytes(undoStack.shift());
    }
    unsaved = true;
    updateHistoryButtons();
  }

  function applyEntry(entry, image) {
    if (entry.resize) setCanvasSize(image.width, image.height);
    ctx.putImageData(image, entry.x, entry.y);
    bctx.putImageData(image, entry.x, entry.y);
  }

  function undo() {
    finishInteraction();
    const entry = undoStack.pop();
    if (!entry) return;
    applyEntry(entry, entry.before);
    redoStack.push(entry);
    unsaved = true;
    updateHistoryButtons();
  }

  function redo() {
    finishInteraction();
    const entry = redoStack.pop();
    if (!entry) return;
    applyEntry(entry, entry.after);
    undoStack.push(entry);
    unsaved = true;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    for (const btn of $$('[data-action="undo"]')) btn.disabled = undoStack.length === 0;
    for (const btn of $$('[data-action="redo"]')) btn.disabled = redoStack.length === 0;
  }

  function finishInteraction() {
    if (drag) endDrag(true);
    commitText();
  }

  // ---------------------------------------------------------------------------
  // Canvas operations

  function clearCanvas() {
    finishInteraction();
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    commitRect(0, 0, canvas.width, canvas.height);
  }

  // Resize all canvases to a blank w × h. Callers restore the content.
  function setCanvasSize(w, h) {
    for (const c of [canvas, backup, overlay]) {
      c.width = w;
      c.height = h;
    }
    for (const c of [ctx, bctx]) {
      c.fillStyle = BACKGROUND;
      c.fillRect(0, 0, w, h);
    }
    $('#canvas-w').value = w;
    $('#canvas-h').value = h;
    $('#status-canvas').textContent = `${w} × ${h} px`;
    applyZoom();
  }

  // Undoable resize that keeps the drawing anchored top-left; new space is white.
  function resizeCanvas(w, h) {
    finishInteraction();
    w = clamp(Math.round(w) || 1, 1, MAX_CANVAS_SIDE);
    h = clamp(Math.round(h) || 1, 1, MAX_CANVAS_SIDE);
    if (w === canvas.width && h === canvas.height) {
      setCanvasSizeInputs();
      return;
    }
    const before = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setCanvasSize(w, h);
    ctx.putImageData(before, 0, 0);
    const after = ctx.getImageData(0, 0, w, h);
    bctx.putImageData(after, 0, 0);
    pushHistory({ x: 0, y: 0, before, after, resize: true });
  }

  function setCanvasSizeInputs() {
    $('#canvas-w').value = canvas.width;
    $('#canvas-h').value = canvas.height;
  }

  // Largest canvas that fits the visible workspace at the current zoom.
  function windowCanvasSize() {
    return {
      w: clamp(Math.floor((workspace.clientWidth - 2 * WORKSPACE_MARGIN) / state.zoom), 1, MAX_CANVAS_SIDE),
      h: clamp(Math.floor((workspace.clientHeight - 2 * WORKSPACE_MARGIN) / state.zoom), 1, MAX_CANVAS_SIDE),
    };
  }

  function startCanvasResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finishInteraction();

    const handle = e.currentTarget;
    const dir = handle.dataset.dir;
    const origin = { x: e.clientX, y: e.clientY, w: canvas.width, h: canvas.height };
    let size = { w: origin.w, h: origin.h };
    handle.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dw = dir.includes('e') ? (ev.clientX - origin.x) / state.zoom : 0;
      const dh = dir.includes('s') ? (ev.clientY - origin.y) / state.zoom : 0;
      size = {
        w: clamp(Math.round(origin.w + dw), 1, MAX_CANVAS_SIDE),
        h: clamp(Math.round(origin.h + dh), 1, MAX_CANVAS_SIDE),
      };
      ghost.hidden = false;
      ghost.style.width = `${size.w * state.zoom}px`;
      ghost.style.height = `${size.h * state.zoom}px`;
      sizeTip.hidden = false;
      sizeTip.textContent = `${size.w} × ${size.h} px`;
      sizeTip.style.left = `${size.w * state.zoom + 14}px`;
      sizeTip.style.top = `${size.h * state.zoom + 14}px`;
      $('#status-sel').textContent = `${size.w} × ${size.h} px`;
    };
    const finish = (ev) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      ghost.hidden = true;
      sizeTip.hidden = true;
      $('#status-sel').textContent = '';
      if (ev.type === 'pointerup') resizeCanvas(size.w, size.h);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function saveDrawing() {
    finishInteraction();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      link.download = `mlp-paint-${stamp}.png`;
      link.href = url;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      unsaved = false;
    }, 'image/png');
  }

  // ---------------------------------------------------------------------------
  // Zoom

  function applyZoom() {
    const z = state.zoom;
    wrap.style.width = `${canvas.width * z}px`;
    wrap.style.height = `${canvas.height * z}px`;
    wrap.classList.toggle('pixelated', z >= 2);
    const gridStep = [1, 2, 5, 10, 20, 50, 100, 200].find((step) => step * z >= 12) ?? 400;
    wrap.style.setProperty('--grid', `${gridStep * z}px`);
    $('#zoom-label').textContent = `${Math.round(z * 100)}%`;
    $('#zoom-slider').value = String(Math.log2(z));
    layoutEditor();
  }

  // Change zoom, keeping the canvas point under `anchor` (a pointer event) in place.
  function setZoom(zoom, anchor) {
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(zoom - state.zoom) < 1e-4) return;
    const view = workspace.getBoundingClientRect();
    const ax = anchor ? anchor.clientX : view.left + workspace.clientWidth / 2;
    const ay = anchor ? anchor.clientY : view.top + workspace.clientHeight / 2;
    const before = wrap.getBoundingClientRect();
    const px = (ax - before.left) / state.zoom;
    const py = (ay - before.top) / state.zoom;

    state.zoom = zoom;
    applyZoom();
    const after = wrap.getBoundingClientRect();
    workspace.scrollLeft += after.left + px * zoom - ax;
    workspace.scrollTop += after.top + py * zoom - ay;
  }

  function zoomStep(direction) {
    const z = state.zoom;
    const next = direction > 0
      ? ZOOM_LEVELS.find((level) => level > z + 1e-4)
      : [...ZOOM_LEVELS].reverse().find((level) => level < z - 1e-4);
    if (next) setZoom(next);
  }

  function zoomToFit() {
    const w = (workspace.clientWidth - 2 * WORKSPACE_MARGIN) / canvas.width;
    const h = (workspace.clientHeight - 2 * WORKSPACE_MARGIN) / canvas.height;
    setZoom(Math.min(w, h));
    workspace.scrollTo(0, 0);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
