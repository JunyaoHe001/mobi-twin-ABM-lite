/* Geographic background only. The simulation and research SVG are unchanged. */
(() => {
  'use strict';
  const svg = document.getElementById('region-map');
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  layer.id = 'atlas-basemap-image';
  for (const [key, value] of Object.entries({x:0,y:0,width:760,height:570,preserveAspectRatio:'none',opacity:0.7,'pointer-events':'none'})) layer.setAttribute(key, value);
  svg.insertBefore(layer, document.getElementById('region-layer'));
  // These constants reproduce setupMap() in assets/app.js for the published geometry.
  const scale = 294.942176856493, ox = -6377.515697975489, oy = 12276.378766843427;
  const bbox = [(-ox)/scale,(oy-570)/scale,(760-ox)/scale,oy/scale];
  const params = new URLSearchParams({SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:'OSM-WMS',STYLES:'',SRS:'EPSG:4326',BBOX:bbox.join(','),WIDTH:'1520',HEIGHT:'1140',FORMAT:'image/png'});
  const url = 'https://ows.terrestris.de/osm/service?' + params;
  const credit = document.createElement('div');
  credit.style.cssText = 'position:absolute;left:5px;bottom:3px;max-width:90%;padding:2px 4px;background:rgba(255,255,255,.94);font:9px/1.4 Arial,sans-serif;color:#344054';
  credit.textContent = '\u00a9 OpenStreetMap contributors, Natural Earth Data, GEBCO 2019, terrestris';
  const link = document.createElement('a');
  link.href = 'https://terrestris.de/en/products/free-osm-wms/';
  link.target = '_blank'; link.rel = 'noopener'; link.textContent = ' · Basemap';
  credit.appendChild(link); svg.parentElement.appendChild(credit);
  const input = window.createAtlasBasemapToggle(visible => {
    layer.style.display = visible ? '' : 'none'; credit.hidden = !visible;
    if (visible && !layer.hasAttribute('href')) layer.setAttribute('href', url);
  }, 'Geographic context in the original map projection. Simulation outputs stay visible when hidden.');
  layer.addEventListener('error', () => {
    const note = input.closest('section').querySelector('p');
    note.textContent = 'The background service could not be reached. The simulation remains available.';
    layer.style.display = 'none';
  });
  window.__ATLAS_BASEMAP__ = {type:'wms',input,layer};
})();
