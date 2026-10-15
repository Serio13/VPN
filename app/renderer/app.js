'use strict';
/* global d3, topojson, WORLD_TOPO, COUNTRIES */
(() => {
  const $ = (id) => document.getElementById(id);
  const byCc = new Map(COUNTRIES.map((c) => [c.cc, c]));
  const byNum = new Map(COUNTRIES.filter((c) => c.num).map((c) => [c.num, c]));
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let countries = [];           // resumen por país con servidores [{cc,name,count,bestMbps}]
  let available = new Map();    // cc -> resumen
  let selected = null;          // cc seleccionado
  let state = { state: 'idle' };
  let timer = null;
  let zoomK = 1;

  const flag = (cc) => `vendor/flags/${cc.toLowerCase()}.svg`;
  const nameOf = (cc, fallback) => (byCc.get(cc) || {}).name || fallback || cc;
  const fmtMbps = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

  /* ---------------------------------------------------------------- mapa */
  const svg = d3.select('#map');
  const gMap = svg.append('g');
  const gMarkers = svg.append('g');
  let projection; let path;

  function drawMap() {
    const { width, height } = $('map').getBoundingClientRect();
    if (!width || !height) return;
    projection = d3.geoNaturalEarth1().fitExtent([[10, 10], [width - 10, height - 10]], { type: 'Sphere' });
    path = d3.geoPath(projection);
    const feats = topojson.feature(WORLD_TOPO, WORLD_TOPO.objects.countries).features;
    gMap.selectAll('path').data(feats, (d) => d.id).join('path')
      .attr('class', 'country')
      .attr('d', path)
      .on('click', (_e, d) => { const c = byNum.get(String(d.id).padStart(3, '0')); if (c && available.has(c.cc)) select(c.cc); })
      .on('mousemove', (e, d) => tip(e, byNum.get(String(d.id).padStart(3, '0'))))
      .on('mouseleave', () => { $('tooltip').hidden = true; });
    paintMap();
  }

  function paintMap() {
    const liveCc = state.state === 'connected' && state.server ? state.server.cc : null;
    gMap.selectAll('path')
      .classed('has', (d) => { const c = byNum.get(String(d.id).padStart(3, '0')); return !!c && available.has(c.cc); })
      .classed('sel', (d) => { const c = byNum.get(String(d.id).padStart(3, '0')); return !!c && c.cc === selected; })
      .classed('live', (d) => { const c = byNum.get(String(d.id).padStart(3, '0')); return !!c && c.cc === liveCc; });
    if (!projection) return;
    const data = countries.filter((c) => byCc.has(c.cc));
    gMarkers.selectAll('circle').data(data, (d) => d.cc).join('circle')
      .attr('class', (d) => 'marker' + (d.cc === liveCc ? ' live' : ''))
      .attr('cx', (d) => projection([byCc.get(d.cc).lng, byCc.get(d.cc).lat])[0])
      .attr('cy', (d) => projection([byCc.get(d.cc).lng, byCc.get(d.cc).lat])[1])
      .attr('r', (d) => markerR(d) / zoomK)
      .on('click', (_e, d) => select(d.cc))
      .on('mousemove', (e, d) => tip(e, byCc.get(d.cc)))
      .on('mouseleave', () => { $('tooltip').hidden = true; });
  }
  const markerR = (d) => Math.min(8, 3 + Math.log2(d.count + 1));

  function tip(e, c) {
    const t = $('tooltip');
    if (!c) { t.hidden = true; return; }
    const info = available.get(c.cc);
    t.textContent = info ? `${c.name} · ${info.count} servidores · hasta ${fmtMbps(info.bestMbps)} Mbps` : `${c.name} · sin servidores`;
    const box = $('map').getBoundingClientRect();
    t.style.left = `${Math.min(e.clientX - box.left + 14, box.width - 260)}px`;
    t.style.top = `${e.clientY - box.top + 14}px`;
    t.hidden = false;
  }

  svg.call(d3.zoom().scaleExtent([1, 12]).on('zoom', (e) => {
    zoomK = e.transform.k;
    gMap.attr('transform', e.transform);
    gMarkers.attr('transform', e.transform);
    gMarkers.selectAll('circle').attr('r', (d) => markerR(d) / zoomK);
  }));
  new ResizeObserver(drawMap).observe($('map'));

  /* ----------------------------------------------------------- lista países */
  function renderList() {
    const q = norm($('search').value.trim());
    const liveCc = state.state === 'connected' && state.server ? state.server.cc : null;
    const rows = countries.filter((c) => !q || norm(nameOf(c.cc, c.name)).includes(q) || c.cc.toLowerCase() === q);
    const ul = $('country-list');
    ul.replaceChildren();
    if (!rows.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Sin resultados'; ul.append(li); return;
    }
    for (const c of rows) {
      const li = document.createElement('li');
      li.className = (c.cc === selected ? 'sel ' : '') + (c.cc === liveCc ? 'live' : '');
      li.tabIndex = 0;
      li.dataset.cc = c.cc;
      const img = document.createElement('img'); img.src = flag(c.cc); img.width = 24; img.height = 18; img.alt = '';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = nameOf(c.cc, c.name);
      const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${c.count} · ${fmtMbps(c.bestMbps)} Mbps`;
      li.append(img, name, meta);
      li.addEventListener('click', () => select(c.cc));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(c.cc); });
      ul.append(li);
    }
  }

  /* ------------------------------------------------------------- detalle */
  async function select(cc) {
    selected = cc;
    renderList(); paintMap();
    const info = available.get(cc);
    $('detail').hidden = false;
    $('detail-flag').src = flag(cc);
    $('detail-name').textContent = nameOf(cc, info && info.name);
    $('detail-sub').textContent = info ? `${info.count} servidores disponibles` : '';
    const ul = $('server-list');
    ul.replaceChildren();
    const servers = await window.vpn.countryServers(cc);
    if (selected !== cc) return; // el usuario cambió de país mientras cargaba
    for (const s of servers.slice(0, 60)) {
      const li = document.createElement('li');
      const ip = document.createElement('span'); ip.className = 'ip'; ip.textContent = s.ip;
      const sub = document.createElement('span'); sub.className = 'sub';
      const proto = document.createElement('span'); proto.className = 'badge'; proto.textContent = s.proto;
      sub.append(`${fmtMbps(s.mbps)} Mbps · ${s.ping} ms · `, proto, ` · logs: ${s.logs || '?'}`);
      const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Conectar';
      btn.addEventListener('click', () => connect({ ip: s.ip }));
      li.append(ip, sub, btn);
      ul.append(li);
    }
  }

  /* -------------------------------------------------------------- estado */
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function renderState() {
    const box = $('status');
    const st = state.state;
    box.className = `status ${st === 'error' ? 'idle' : st === 'disconnecting' ? 'connecting' : st}`;
    const title = $('status-title'); const sub = $('status-sub');
    const busy = st === 'connecting' || st === 'disconnecting';
    $('btn-disconnect').hidden = !(st === 'connected' || st === 'connecting');
    $('status-timer').hidden = st !== 'connected';
    $('btn-quick').disabled = busy || st === 'connected';
    $('btn-connect-best').disabled = busy || st === 'connected';
    if (st === 'connecting') {
      title.textContent = `Conectando a ${nameOf(state.server.cc, state.server.country)}…`;
      sub.textContent = `Servidor ${state.server.ip} · intento ${state.attempt}/${state.total}`;
    } else if (st === 'connected') {
      title.textContent = `Conectado · ${nameOf(state.server.cc, state.server.country)}`;
      sub.textContent = `Servidor ${state.server.ip}` + (state.ip ? ` · Tu IP pública: ${state.ip}` : '');
    } else if (st === 'disconnecting') {
      title.textContent = 'Desconectando…'; sub.textContent = '';
    } else if (st === 'error') {
      title.textContent = 'No se pudo conectar'; sub.textContent = state.message || '';
    } else {
      title.textContent = 'Desconectado'; sub.textContent = 'Tu conexión no está protegida';
    }
    clearInterval(timer);
    if (st === 'connected') {
      const tick = () => { $('status-timer').textContent = fmtElapsed(Date.now() - state.since); };
      tick(); timer = setInterval(tick, 1000);
    }
    renderList(); paintMap();
  }

  function connect(target) {
    window.vpn.connect(target).catch((e) => { state = { state: 'error', message: e.message }; renderState(); });
  }

  /* -------------------------------------------------------------- carga */
  function banner(text, { error = false, action } = {}) {
    const b = $('banner');
    if (!text) { b.hidden = true; return; }
    b.className = 'banner' + (error ? ' error' : '');
    b.replaceChildren(document.createTextNode(text));
    if (action) {
      const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = action.label;
      btn.addEventListener('click', action.run); b.append(btn);
    }
    b.hidden = false;
  }

  async function checkOpenVpn() {
    const s = await window.vpn.openvpnStatus();
    if (s.installed) { banner(null); return true; }
    banner('Falta OpenVPN (gratuito), el motor que crea el túnel.', {
      action: {
        label: 'Instalar automáticamente',
        run: async () => {
          banner('Instalando OpenVPN… (puede tardar un minuto y pedir permiso)');
          const r = await window.vpn.installOpenvpn();
          if (r.ok && (await window.vpn.openvpnStatus()).installed) banner(null);
          else banner(`No se pudo instalar automáticamente. Instala OpenVPN Community desde openvpn.net y reinicia la app. ${r.message || ''}`.trim(), { error: true });
        },
      },
    });
    return false;
  }

  async function load(refresh = false) {
    $('summary').textContent = 'Cargando servidores…';
    $('btn-refresh').disabled = true;
    try {
      const r = await window.vpn.loadServers(refresh);
      countries = r.countries;
      available = new Map(countries.map((c) => [c.cc, c]));
      $('summary').textContent = `${r.total} servidores en ${countries.length} países`;
      if (r.stale) banner(`Sin conexión con VPN Gate: usando la lista guardada (${new Date(r.fetchedAt).toLocaleString()}).`);
      else if ($('banner').textContent.startsWith('Sin conexión')) banner(null);
    } catch (e) {
      $('summary').textContent = '';
      banner(`No se pudo cargar la lista de servidores: ${e.message}`, { error: true, action: { label: 'Reintentar', run: () => load(true) } });
    } finally {
      $('btn-refresh').disabled = false;
    }
    renderList(); paintMap();
  }

  /* ------------------------------------------------------------- eventos */
  $('search').addEventListener('input', renderList);
  $('btn-refresh').addEventListener('click', () => load(true));
  $('btn-quick').addEventListener('click', () => connect({}));
  $('btn-connect-best').addEventListener('click', () => selected && connect({ cc: selected }));
  $('btn-disconnect').addEventListener('click', () => window.vpn.disconnect());
  $('detail-close').addEventListener('click', () => { selected = null; $('detail').hidden = true; renderList(); paintMap(); });
  $('btn-log').addEventListener('click', async () => {
    $('log-body').textContent = (await window.vpn.getLog()).join('\n') || 'Sin actividad todavía.';
    $('log-modal').hidden = false;
  });
  $('log-close').addEventListener('click', () => { $('log-modal').hidden = true; });
  window.vpn.onState((s) => { state = s; renderState(); });

  (async () => {
    drawMap();
    state = await window.vpn.getState();
    renderState();
    await checkOpenVpn();
    await load(false);
  })();
})();
