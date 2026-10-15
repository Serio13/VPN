// Copia al renderer los recursos de npm (mapa, d3, banderas) para que la app funcione sin internet
// y genera la tabla de países. Se ejecuta antes de `npm start` y de `npm run dist`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'renderer', ...p);

fs.mkdirSync(out('vendor', 'flags'), { recursive: true });
fs.mkdirSync(out('data'), { recursive: true });

fs.copyFileSync(nm('d3', 'dist', 'd3.min.js'), out('vendor', 'd3.min.js'));
fs.copyFileSync(nm('topojson-client', 'dist', 'topojson-client.min.js'), out('vendor', 'topojson-client.min.js'));
// Como <script> y no fetch(): en file:// Chromium no permite fetch de JSON local.
const world = fs.readFileSync(nm('world-atlas', 'countries-110m.json'), 'utf8');
fs.writeFileSync(out('data', 'world.js'), `window.WORLD_TOPO = ${world};\n`);

const countries = JSON.parse(fs.readFileSync(nm('world-countries', 'countries.json'), 'utf8'));
const table = countries.map((c) => ({
  cc: c.cca2,
  num: c.ccn3 || null,
  name: (c.translations && c.translations.spa && c.translations.spa.common) || c.name.common,
  lat: c.latlng[0],
  lng: c.latlng[1],
}));
fs.writeFileSync(out('data', 'countries.js'), `window.COUNTRIES = ${JSON.stringify(table)};\n`);

let flags = 0;
const flagDir = nm('flag-icons', 'flags', '4x3');
for (const c of table) {
  const src = path.join(flagDir, `${c.cc.toLowerCase()}.svg`);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, out('vendor', 'flags', `${c.cc.toLowerCase()}.svg`));
    flags++;
  }
}
console.log(`assets listos: ${table.length} países, ${flags} banderas`);
