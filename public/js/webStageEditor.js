// webStageEditor.js -- the web block list editor (#91), shared by the web
// call flow (/admin/callflows) and the home page layouts (/admin/webhome).
// Markup: partials/admin/webStageEditor.pug. Each .web-stage-editor saves
// POST { stages } as JSON to its data-save-url, then the page reloads to
// show what was stored, having said why when the save was refused.
(function () {
  'use strict';

  function readJson(id, fallback) {
    var el = document.getElementById(id);
    if (!el) return fallback;
    try { return JSON.parse(el.textContent); } catch (_) { return fallback; }
  }
  var catalog = readJson('webStageCatalog', []);
  var pages = readJson('webPagesList', []);

  function entryFor(name) {
    for (var i = 0; i < catalog.length; i++) if (catalog[i].name === name) return catalog[i];
    return null;
  }

  function collect(editor) {
    var out = [];
    editor.querySelectorAll('.wstage-badge').forEach(function (b) {
      var s = { stage: b.dataset.stage };
      var opts = {};
      try { opts = JSON.parse(b.dataset.options || '{}'); } catch (_) {}
      if (opts && Object.keys(opts).length > 0) s.options = opts;
      out.push(s);
    });
    return out;
  }

  function save(editor, stages) {
    fetch(editor.dataset.saveUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages: stages })
    }).then(function (r) {
      return r.json().catch(function () { return { status: r.ok, errormessages: [] }; });
    }).then(function (result) {
      if (!result.status) alert('Not saved:\n' + ((result.errormessages || []).join('\n') || 'unknown error'));
      location.reload();
    }).catch(function (err) {
      alert('Not saved: ' + err.message);
      location.reload();
    });
  }

  // Remove
  document.addEventListener('click', function (e) {
    var x = e.target.closest ? e.target.closest('.wstage-remove') : null;
    if (!x) return;
    var editor = x.closest('.web-stage-editor');
    x.closest('.wstage-badge').remove();
    save(editor, collect(editor));
  });

  // Add. A Page block needs a page: the first not already in the list,
  // changed afterwards with its gear.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.wstage-add-btn') : null;
    if (!btn) return;
    var editor = btn.closest('.web-stage-editor');
    var name = editor.querySelector('.wstage-add-select').value;
    if (!name) return;
    var stages = collect(editor);
    var stage = { stage: name };
    var entry = entryFor(name);
    if (entry && entry.repeatable) {
      var used = stages.filter(function (s) { return s.stage === name && s.options; })
        .map(function (s) { return Number(s.options[entry.repeatable]); });
      var free = pages.filter(function (p) { return used.indexOf(p.id) === -1; });
      if (free.length === 0) {
        alert(pages.length ? 'Every one of your Web Pages is already here.' : 'Write a page under Content > Web Pages first.');
        return;
      }
      stage.options = {};
      stage.options[entry.repeatable] = free[0].id;
    }
    stages.push(stage);
    save(editor, stages);
  });

  // Drag to reorder, within one list
  var dragged = null;
  document.addEventListener('dragstart', function (e) {
    if (e.target.classList && e.target.classList.contains('wstage-badge')) {
      dragged = e.target;
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  document.addEventListener('dragover', function (e) {
    if (!dragged) return;
    var over = e.target.closest ? e.target.closest('.wstage-badge') : null;
    if (!over || over === dragged || over.parentElement !== dragged.parentElement) return;
    e.preventDefault();
    var rect = over.getBoundingClientRect();
    over.parentElement.insertBefore(dragged, e.clientX < rect.left + rect.width / 2 ? over : over.nextSibling);
  });
  document.addEventListener('dragend', function () {
    if (!dragged) return;
    var editor = dragged.closest('.web-stage-editor');
    dragged = null;
    save(editor, collect(editor));
  });

  // Settings, built from the block's definition
  var modal = document.getElementById('stageOptionsModal');
  if (!modal) return;
  var badge = null;
  modal.addEventListener('show.bs.modal', function (e) {
    badge = e.relatedTarget ? e.relatedTarget.closest('.wstage-badge') : null;
    var fields = document.getElementById('soFields');
    fields.innerHTML = '';
    if (!badge) return;
    var entry = entryFor(badge.dataset.stage);
    if (!entry) return;
    var current = {};
    try { current = JSON.parse(badge.dataset.options || '{}'); } catch (_) {}
    document.getElementById('soTitle').textContent = entry.label + ' settings';
    document.getElementById('soHint').textContent = entry.hint || '';
    entry.options.forEach(function (def) {
      var value = Object.prototype.hasOwnProperty.call(current, def.key) ? current[def.key] : def.default;
      var wrap = document.createElement('div');
      wrap.className = 'mb-3';
      var label = document.createElement('label');
      label.className = 'form-label';
      label.textContent = def.label;
      wrap.appendChild(label);
      var input;
      if (def.type === 'page' || def.type === 'select') {
        input = document.createElement('select');
        input.className = 'form-select';
        var choices = def.type === 'page'
          ? pages.map(function (p) { return { value: String(p.id), label: p.title + (p.active ? '' : ' (draft)') }; })
          : def.choices;
        choices.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c.value;
          o.textContent = c.label;
          if (String(c.value) === String(value)) o.selected = true;
          input.appendChild(o);
        });
        wrap.appendChild(input);
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.className = 'form-control';
        input.min = def.min;
        input.max = def.max;
        input.step = 1;
        input.value = value;
        wrap.appendChild(input);
        var help = document.createElement('div');
        help.className = 'form-text';
        help.textContent = def.min + ' to ' + def.max + ', default ' + def.default;
        wrap.appendChild(help);
      }
      input.dataset.key = def.key;
      input.dataset.type = def.type;
      input.dataset.default = String(def.default);
      fields.appendChild(wrap);
    });
  });

  document.getElementById('soSave').addEventListener('click', function () {
    if (!badge) return;
    // Only what differs from the default is stored, so a later change of
    // default reaches every block nobody touched; which page is never a
    // default, it is what the block is
    var opts = {};
    document.querySelectorAll('#soFields [data-key]').forEach(function (input) {
      var t = input.dataset.type;
      var v = (t === 'number' || t === 'page') ? parseInt(input.value, 10) : input.value;
      if (t === 'page' || String(v) !== input.dataset.default) opts[input.dataset.key] = (t === 'number' && isNaN(v)) ? input.value : v;
    });
    badge.dataset.options = JSON.stringify(opts);
    var editor = badge.closest('.web-stage-editor');
    bootstrap.Modal.getInstance(modal).hide();
    save(editor, collect(editor));
  });
})();
