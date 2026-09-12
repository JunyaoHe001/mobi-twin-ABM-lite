/* Display-only control: never modifies research data or simulation state. */
(() => {
  'use strict';
  window.createAtlasBasemapToggle = function (apply, note) {
    const key = 'atlas-basemap-visible:' + location.pathname;
    let visible = true;
    try { visible = localStorage.getItem(key) !== 'false'; } catch (_) {}
    const section = document.createElement('section');
    section.className = 'control-section';
    section.setAttribute('aria-label', 'Basemap display');
    const label = document.createElement('label');
    label.className = 'toggle-row';
    label.style.cssText = 'display:flex;align-items:center;gap:9px;cursor:pointer';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'atlas-basemap-toggle';
    input.setAttribute('role', 'switch');
    input.checked = visible;
    const span = document.createElement('span');
    span.textContent = 'Show basemap';
    label.append(input, span);
    const p = document.createElement('p');
    p.className = 'micro-note';
    p.style.cssText = 'font-size:11px;line-height:1.5;color:#667085;margin:6px 0 0';
    p.textContent = note || 'Geographic context only; research layers stay visible.';
    section.append(label, p);
    const host = document.querySelector('.sidebar-inner') || document.querySelector('#sidebar, .sidebar');
    if (!host) throw new Error('Basemap sidebar not found');
    const header = host.querySelector(':scope > header');
    if (header) header.after(section); else host.prepend(section);
    input.addEventListener('change', () => {
      try { localStorage.setItem(key, String(input.checked)); } catch (_) {}
      apply(input.checked);
    });
    apply(visible);
    return input;
  };
})();
