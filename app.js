/* Noah — Calculadora de interés compuesto (v2)
 *
 * Privacidad: todo el cálculo y el guardado ocurren en este dispositivo.
 * No hay llamadas de red con datos del usuario; la política CSP del index.html
 * además bloquea cualquier script o conexión hacia otros sitios.
 *
 * Modelo: el motor SIEMPRE capitaliza mes a mes. La vista Anual/Mensual solo
 * cambia cómo se muestran los resultados, así que ambas dan el mismo número.
 * Las ediciones manuales se guardan por mes (formato canónico), por lo que
 * cambiar de vista no borra nada.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_YEARS = 100;
  const STORAGE_KEY = 'noahCalc_state_v2';
  const LEGACY_KEY = 'noahCalc_state_v1';
  const AUTOLOCK_MS = 5 * 60 * 1000;
  const PBKDF2_ITER = 600000;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const VALUE_IDS = ['capital', 'inflacion', 'rendBruto', 'moneda', 'totalYears',
    'defDepMensual', 'defDepAnual', 'defRetMensual', 'defRetAnual'];

  // Ediciones manuales por mes: { [mes]: { depM, retM, depA, retA } }.
  // depA/retA solo existen en el mes 12 de cada año.
  let ov = {};
  let view = 'anual';

  // Estado de seguridad
  let cryptoKey = null;      // clave AES en memoria (solo si hay PIN)
  let pinSalt = null;
  let locked = false;
  let ready = false;         // false hasta cargar datos: evita sobrescribir lo guardado
  let userChanged = false;   // para mostrar "Guardado" solo tras cambios del usuario

  // ---------------------------------------------------------------- utilidades
  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

  function sanitizeSymbol(s) {
    // Solo texto: se quitan caracteres que podrían interpretarse como HTML.
    const clean = String(s || '').replace(/[<>&"'`\\\u0000-\u001F]/g, '').slice(0, 3);
    return clean || '$';
  }

  const nfInt = new Intl.NumberFormat('es-CR', { maximumFractionDigits: 0 });
  const nfCompact = new Intl.NumberFormat('es-CR', { notation: 'compact', maximumFractionDigits: 1 });
  const nfPct = new Intl.NumberFormat('es-CR', { maximumFractionDigits: 2 });

  function fmtMoney(v, sym) {
    const r = Math.round(v);
    return (r < 0 ? '-' : '') + sym + nfInt.format(Math.abs(r));
  }
  function fmtCompact(v, sym) { return (v < 0 ? '-' : '') + sym + nfCompact.format(Math.abs(v)); }
  function fmtPct(v) { return Number.isFinite(v) ? nfPct.format(v * 100) + '%' : '—'; }

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'dataset') Object.assign(e.dataset, attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------------------------------------------------------------- entradas
  function setFieldError(id, msg) {
    const input = $(id), err = $('err-' + id);
    if (input) input.classList.toggle('invalid', !!msg);
    if (err) err.textContent = msg || '';
  }

  function readInputs() {
    let capital = num($('capital').value);
    if (capital < 0) { setFieldError('capital', 'No puede ser negativo — se usa 0.'); capital = 0; }
    else setFieldError('capital', '');

    let infl = num($('inflacion').value);
    if (infl < -50 || infl > 1000) {
      setFieldError('inflacion', 'Debe estar entre -50% y 1000%.');
      infl = Math.min(1000, Math.max(-50, infl));
    } else setFieldError('inflacion', '');

    let rb = num($('rendBruto').value);
    if (rb < -90 || rb > 1000) {
      setFieldError('rendBruto', 'Debe estar entre -90% y 1000%.');
      rb = Math.min(1000, Math.max(-90, rb));
    } else setFieldError('rendBruto', '');

    let years = Math.floor(num($('totalYears').value));
    if (years < 1 || years > MAX_YEARS) {
      setFieldError('totalYears', 'Debe estar entre 1 y ' + MAX_YEARS + ' años.');
      years = Math.min(MAX_YEARS, Math.max(1, years));
    } else setFieldError('totalYears', '');

    return {
      capital,
      inflacion: infl / 100,
      rendBruto: rb / 100,
      sym: sanitizeSymbol($('moneda').value),
      years,
      defDepM: Math.abs(num($('defDepMensual').value)),
      defDepA: Math.abs(num($('defDepAnual').value)),
      defRetM: Math.abs(num($('defRetMensual').value)),
      defRetA: Math.abs(num($('defRetAnual').value)),
    };
  }

  // ---------------------------------------------------------------- motor
  function compute(inp) {
    const rendReal = (1 + inp.rendBruto) / (1 + inp.inflacion) - 1;
    const rm = Math.pow(1 + rendReal, 1 / 12) - 1;
    const months = inp.years * 12;

    let bal = inp.capital;
    let totDep = 0, totRet = 0, totInt = 0, shortfall = 0;
    let depletedMonth = null;
    const rows = new Array(months);

    for (let m = 1; m <= months; m++) {
      const o = ov[m] || {};
      const ye = m % 12 === 0;
      const depM = o.depM !== undefined ? o.depM : inp.defDepM;
      const retM = o.retM !== undefined ? o.retM : inp.defRetM;
      const depA = ye ? (o.depA !== undefined ? o.depA : inp.defDepA) : 0;
      const retA = ye ? (o.retA !== undefined ? o.retA : inp.defRetA) : 0;

      const interest = bal * rm;           // bal nunca es negativo
      bal += interest; totInt += interest;
      bal += depM + depA; totDep += depM + depA;

      const want = retM + retA;
      const paid = Math.min(want, bal);    // no se puede retirar más de lo que hay
      bal -= paid; totRet += paid;
      if (want - paid > 0.005) {
        shortfall += want - paid;
        if (depletedMonth === null) depletedMonth = m;
      }
      if (bal < 1e-9) bal = 0;

      rows[m - 1] = { m, y: Math.ceil(m / 12), ye, depM, retM, depA, retA, bal, overridden: !!ov[m] };
    }
    return { inp, rendReal, rows, final: months ? rows[months - 1].bal : inp.capital,
      totDep, totRet, totInt, shortfall, depletedMonth };
  }

  // Filas para la vista actual
  function viewRows(res) {
    if (view === 'mensual') {
      return res.rows.map((r) => ({
        key: 'm' + r.m, label: r.y + ' · ' + (((r.m - 1) % 12) + 1), ye: r.ye,
        months: [r.m], depM: r.depM, retM: r.retM, depA: r.depA, retA: r.retA,
        annualEnabled: r.ye, bal: r.bal, overridden: r.overridden,
      }));
    }
    const out = [];
    for (let y = 1; y <= res.inp.years; y++) {
      const slice = res.rows.slice((y - 1) * 12, y * 12);
      const last = slice[11];
      const same = (f) => slice.every((r) => r[f] === slice[0][f]) ? slice[0][f] : null;
      out.push({
        key: 'y' + y, label: String(y), ye: true,
        months: slice.map((r) => r.m), depM: same('depM'), retM: same('retM'),
        depA: last.depA, retA: last.retA, annualEnabled: true,
        bal: last.bal, overridden: slice.some((r) => r.overridden),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- render
  let tableSig = '';
  let justEdited = null;
  let renderQueued = false;

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    const inp = readInputs();
    const res = compute(inp);
    const sym = inp.sym;

    $('rendReal').value = fmtPct(res.rendReal);
    $('sumFinal').textContent = fmtMoney(res.final, sym);
    $('sumFinal').classList.toggle('warn-text', res.final <= 0 && res.inp.years > 0);
    $('sumInteres').textContent = fmtMoney(res.totInt, sym);
    $('sumDepositos').textContent = fmtMoney(res.totDep, sym);
    $('sumRetiros').textContent = fmtMoney(res.totRet, sym);
    $('sumRendReal').textContent = fmtPct(res.rendReal);

    // Aviso de capital agotado
    const wb = $('warningBox');
    wb.textContent = '';
    if (res.depletedMonth) {
      const y = Math.ceil(res.depletedMonth / 12), mo = ((res.depletedMonth - 1) % 12) + 1;
      wb.append(el('b', null, 'Atención: '),
        document.createTextNode('el capital se agota en el '),
        el('b', null, 'año ' + y + ', mes ' + mo),
        document.createTextNode('. Desde ahí los retiros quedan limitados a lo disponible: faltaron '),
        el('b', null, fmtMoney(res.shortfall, sym)),
        document.createTextNode(' de los retiros planificados. Revisá los retiros de esa etapa.'));
      wb.classList.remove('hidden');
    } else wb.classList.add('hidden');

    $('thPeriodo').textContent = view === 'mensual' ? 'Año · Mes' : 'Año';
    $('detailTitle').textContent = view === 'mensual' ? 'Detalle mes a mes' : 'Detalle año a año';
    $('detailHint').textContent = view === 'mensual'
      ? 'Depósito/retiro mensual es editable en cualquier fila. Depósito/retiro anual solo se aplica —y es editable— en el mes 12 de cada año (resaltado). Dejá una celda vacía para volver al valor por defecto.'
      : 'Editá cualquier celda para ajustar un año puntual — todos los montos en positivo. "varía" indica meses con montos distintos dentro de ese año. Dejá una celda vacía para volver al valor por defecto.';

    $('eqDepM').textContent = fmtMoney(inp.defDepM, sym);
    $('eqDepMD').textContent = fmtMoney(inp.defDepM / 30.44, sym);
    $('eqDepA').textContent = fmtMoney(inp.defDepA / 12, sym);
    $('eqDepAD').textContent = fmtMoney(inp.defDepA / 365, sym);
    $('eqRetM').textContent = fmtMoney(inp.defRetM, sym);
    $('eqRetMD').textContent = fmtMoney(inp.defRetM / 30.44, sym);
    $('eqRetA').textContent = fmtMoney(inp.defRetA / 12, sym);
    $('eqRetAD').textContent = fmtMoney(inp.defRetA / 365, sym);

    const rows = viewRows(res);
    renderChart(res, rows, sym);
    renderTable(rows, sym);
    saveState();
  }

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function renderChart(res, rows, sym) {
    const host = $('chartHost');
    host.textContent = '';
    if (!rows.length) return;
    const W = 900, H = 280, padL = 72, padR = 16, padT = 14, padB = 28;
    const pts = [res.inp.capital].concat(rows.map((r) => r.bal));
    let minV = Math.min(0, ...pts), maxV = Math.max(...pts);
    if (maxV - minV < 1) maxV = minV + 1;
    const step = niceStep(maxV - minV, 4);
    minV = Math.floor(minV / step) * step;
    maxV = Math.ceil(maxV / step) * step;
    const x = (i) => padL + (W - padL - padR) * (i / rows.length);
    const y = (v) => padT + (H - padT - padB) * (1 - (v - minV) / (maxV - minV));

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img',
      'aria-label': 'Trayectoria del capital' });
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svgEl('stop', { offset: '0%', class: 'grad-top' }), svgEl('stop', { offset: '100%', class: 'grad-bottom' }));
    defs.append(grad); svg.append(defs);

    for (let v = minV; v <= maxV + step / 2; v += step) {
      const gy = y(v);
      svg.append(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, class: 'grid-line' }));
      svg.append(svgEl('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 10 }, fmtCompact(v, sym)));
    }
    if (minV < 0 && maxV > 0) svg.append(svgEl('line', { x1: padL, y1: y(0), x2: W - padR, y2: y(0), class: 'zero-line' }));

    let d = `M ${x(0)} ${y(pts[0])}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${x(i)} ${y(pts[i])}`;
    const base = y(Math.max(0, minV));
    svg.append(svgEl('path', { d: d + ` L ${x(rows.length)} ${base} L ${x(0)} ${base} Z`, class: 'area' }));
    svg.append(svgEl('path', { d, class: 'line' }));

    const perYear = view === 'mensual' ? 12 : 1;
    const years = res.inp.years;
    const yStep = Math.max(1, Math.ceil(years / 6));
    for (let yr = 0; yr <= years; yr += yStep) {
      svg.append(svgEl('text', { x: x(yr * perYear), y: H - padB + 16, 'text-anchor': 'middle', 'font-size': 10 }, String(yr)));
    }
    host.append(svg);
  }

  const FIELDS = [
    { f: 'depM', cls: 'dep', step: 10, annual: false },
    { f: 'depA', cls: 'dep', step: 100, annual: true },
    { f: 'retM', cls: 'ret', step: 10, annual: false },
    { f: 'retA', cls: 'ret', step: 100, annual: true },
  ];

  function renderTable(rows, sym) {
    const tbody = $('tableBody');
    const sig = view + ':' + rows.length;
    if (sig !== tableSig) {
      // Estructura nueva: se arma la tabla una vez.
      tableSig = sig;
      const frag = document.createDocumentFragment();
      rows.forEach((r, idx) => {
        const tr = el('tr', { dataset: { idx: String(idx) } });
        tr.append(el('td', null, r.label));
        FIELDS.forEach((c) => {
          const td = el('td', { class: 'mono ' + c.cls });
          const input = el('input', { type: 'number', step: String(c.step), min: '0', inputmode: 'decimal',
            dataset: { idx: String(idx), field: c.f }, 'aria-label': c.f + ' ' + r.label });
          if (c.annual && !r.annualEnabled) {
            input.disabled = true;
            input.title = 'Solo aplica al cerrar el año (mes 12)';
          }
          td.append(input); tr.append(td);
        });
        tr.append(el('td', { class: 'balance mono' }));
        frag.append(tr);
      });
      tbody.textContent = '';
      tbody.append(frag);
    }
    // Actualización en sitio: no se recrea nada, así el foco y el Tab no se pierden.
    const active = document.activeElement;
    const trs = tbody.children;
    rows.forEach((r, idx) => {
      const tr = trs[idx];
      tr._months = r.months;
      tr.classList.toggle('overridden', r.overridden);
      tr.classList.toggle('year-end', view === 'mensual' && r.ye);
      const inputs = tr.querySelectorAll('input');
      FIELDS.forEach((c, i) => {
        const input = inputs[i];
        if (input === active && input !== justEdited) return;
        const val = r[c.f];
        if (val === null) { input.value = ''; input.placeholder = 'varía'; }
        else { input.value = String(Math.round(val * 100) / 100); input.placeholder = ''; }
      });
      const bal = tr.lastElementChild;
      bal.textContent = fmtMoney(r.bal, sym);
      bal.classList.toggle('neg', r.bal <= 0);
    });
  }

  // ---------------------------------------------------------------- ediciones
  function setOverride(m, field, val) {
    if (val === null) {
      if (ov[m]) { delete ov[m][field]; if (!Object.keys(ov[m]).length) delete ov[m]; }
    } else {
      (ov[m] = ov[m] || {})[field] = val;
    }
  }

  function onTableChange(e) {
    const input = e.target;
    if (!input.matches('input[data-field]')) return;
    const tr = input.closest('tr');
    const months = tr._months || [];
    const field = input.dataset.field;
    const raw = input.value.trim();
    const val = raw === '' ? null : Math.abs(num(raw));   // vacío = volver al valor por defecto
    const annualField = field === 'depA' || field === 'retA';
    const targets = annualField ? months.filter((m) => m % 12 === 0) : months;
    targets.forEach((m) => setOverride(m, field, val));
    userChanged = true;
    justEdited = input;   // que esta celda muestre el valor resultante (p. ej. el por defecto)
    render();
    justEdited = null;
  }

  function applyRange() {
    const years = readInputs().years;
    let from = Math.max(1, Math.floor(num($('rangeFrom').value)) || 1);
    let to = Math.max(from, Math.floor(num($('rangeTo').value)) || from);
    const note = $('rangeNote');
    note.classList.add('hidden');
    if (from > years) {
      note.textContent = 'El rango empieza después del último año proyectado (' + years + '). No se aplicó nada.';
      note.classList.remove('hidden'); note.classList.add('show-warn');
      return;
    }
    if (to > years) {
      note.textContent = 'El rango se ajustó al año ' + years + ', el último de la proyección.';
      note.classList.remove('hidden', 'show-warn');
      to = years;
    }
    const tipo = $('rangeTipo').value, per = $('rangePeriod').value;
    const monto = Math.abs(num($('rangeMonto').value));
    const field = per === 'mensual' ? (tipo === 'deposito' ? 'depM' : 'retM') : (tipo === 'deposito' ? 'depA' : 'retA');
    for (let m = (from - 1) * 12 + 1; m <= to * 12; m++) {
      if (per === 'anual' && m % 12 !== 0) continue;
      setOverride(m, field, monto);
    }
    userChanged = true;
    render();
  }

  function setView(v) {
    if (v === view) return;
    view = v;
    $('btnAnual').classList.toggle('active', v === 'anual');
    $('btnMensual').classList.toggle('active', v === 'mensual');
    userChanged = true;
    render();
  }

  // ---------------------------------------------------------------- persistencia
  function storage() { try { return window.localStorage; } catch (e) { return null; } }

  function collect() {
    const values = {};
    VALUE_IDS.forEach((id) => { values[id] = $(id).value; });
    values.moneda = sanitizeSymbol(values.moneda);
    return { values, view, ov };
  }

  function applyData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.values) VALUE_IDS.forEach((id) => {
      if (d.values[id] !== undefined) $(id).value = id === 'moneda' ? sanitizeSymbol(d.values[id]) : String(d.values[id]);
    });
    if (d.ov && typeof d.ov === 'object') {
      ov = {};
      for (const k in d.ov) {
        const m = parseInt(k, 10); const o = d.ov[k];
        if (!(m >= 1 && m <= MAX_YEARS * 12) || !o || typeof o !== 'object') continue;
        const clean = {};
        ['depM', 'retM', 'depA', 'retA'].forEach((f) => {
          if (typeof o[f] === 'number' && Number.isFinite(o[f]) && o[f] >= 0) clean[f] = o[f];
        });
        if (Object.keys(clean).length) ov[m] = clean;
      }
    }
    view = d.view === 'mensual' ? 'mensual' : 'anual';
    $('btnAnual').classList.toggle('active', view === 'anual');
    $('btnMensual').classList.toggle('active', view === 'mensual');
  }

  // Convierte el formato guardado de la v1 (ediciones por período de la vista)
  function migrateV1(raw) {
    try {
      const s = JSON.parse(raw); if (!s || typeof s !== 'object') return null;
      const out = { values: s.values || {}, view: s.mensual ? 'mensual' : 'anual', ov: {} };
      const map = { depMensual: 'depM', retMensual: 'retM', depAnual: 'depA', retAnual: 'retA' };
      for (const k in (s.overrides || {})) {
        const p = parseInt(k, 10), o = s.overrides[k] || {};
        for (const f in map) {
          if (o[f] === undefined) continue;
          const val = Math.abs(num(o[f])), nf = map[f];
          const months = s.mensual ? [p] : Array.from({ length: 12 }, (_, i) => (p - 1) * 12 + i + 1);
          months.forEach((m) => {
            if ((nf === 'depA' || nf === 'retA') && m % 12 !== 0) return;
            (out.ov[m] = out.ov[m] || {})[nf] = val;
          });
        }
      }
      return out;
    } catch (e) { return null; }
  }

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(pin, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  let saveTimer = null;
  function saveState() {
    if (!ready || locked) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    const st = storage(); if (!st || !ready || locked) return;
    try {
      const data = collect();
      let env;
      if (cryptoKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(data)));
        env = { v: 2, enc: true, salt: b64(pinSalt), iter: PBKDF2_ITER, iv: b64(iv), ct: b64(ct) };
      } else {
        env = { v: 2, enc: false, data };
      }
      st.setItem(STORAGE_KEY, JSON.stringify(env));
      if (userChanged) showSaved();
    } catch (e) { /* almacenamiento lleno o bloqueado: se sigue sin guardar */ }
  }

  function showSaved() {
    const ind = $('saveIndicator');
    ind.classList.add('show');
    clearTimeout(showSaved.t);
    showSaved.t = setTimeout(() => ind.classList.remove('show'), 1200);
  }

  function readEnvelope() {
    const st = storage(); if (!st) return null;
    try {
      const raw = st.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
      const legacy = st.getItem(LEGACY_KEY);
      if (legacy) {
        const d = migrateV1(legacy);
        st.removeItem(LEGACY_KEY);
        if (d) return { v: 2, enc: false, data: d, migrated: true };
      }
    } catch (e) { /* datos corruptos: se arranca de cero */ }
    return null;
  }

  // ---------------------------------------------------------------- PIN
  function updatePinUi() {
    const on = !!cryptoKey;
    $('pinStatus').textContent = on ? 'PIN activo · datos cifrados' : 'Sin PIN';
    $('pinStatus').classList.toggle('on', on);
    $('pinSetup').classList.toggle('hidden', on);
    $('pinActive').classList.toggle('hidden', !on);
  }
  function pinMsg(text, warn) {
    const n = $('pinMsg');
    n.textContent = text || '';
    n.classList.toggle('hidden', !text);
    n.classList.toggle('show-warn', !!warn);
  }

  async function enablePin() {
    const a = $('pinNew').value, b = $('pinConfirm').value;
    if (a.length < 6) return pinMsg('El PIN debe tener al menos 6 caracteres.', true);
    if (a !== b) return pinMsg('Los PIN no coinciden.', true);
    pinMsg('Cifrando…');
    pinSalt = crypto.getRandomValues(new Uint8Array(16));
    cryptoKey = await deriveKey(a, pinSalt);
    $('pinNew').value = ''; $('pinConfirm').value = '';
    await saveNow();
    updatePinUi();
    pinMsg('PIN activado. Tus datos quedaron cifrados en este dispositivo.');
  }

  async function disablePin() {
    if (!confirm('¿Quitar el PIN? Tus datos seguirán en este dispositivo, pero sin cifrar.')) return;
    cryptoKey = null; pinSalt = null;
    await saveNow();
    updatePinUi();
    pinMsg('PIN quitado.');
  }

  async function lockNow() {
    if (!cryptoKey) return;
    await saveNow();
    location.reload();   // recarga para borrar los datos descifrados de la memoria
  }

  let failCount = 0, retryAt = 0;
  async function tryUnlock(env) {
    const err = $('lockErr');
    const wait = retryAt - Date.now();
    if (wait > 0) { err.textContent = 'Esperá ' + Math.ceil(wait / 1000) + ' s antes de reintentar.'; return; }
    const pin = $('lockPin').value;
    if (!pin) return;
    err.textContent = 'Verificando…';
    $('unlockBtn').disabled = true;
    try {
      const salt = unb64(env.salt);
      const key = await deriveKey(pin, salt);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
      const data = JSON.parse(new TextDecoder().decode(pt));
      cryptoKey = key; pinSalt = salt; locked = false; failCount = 0;
      $('lockPin').value = ''; err.textContent = '';
      $('lockScreen').classList.add('hidden');
      document.body.classList.remove('locked');
      applyData(data);
      ready = true;
      updatePinUi();
      render();
    } catch (e) {
      failCount++;
      retryAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, failCount - 1));
      err.textContent = 'PIN incorrecto.';
      $('lockPin').select();
    } finally {
      $('unlockBtn').disabled = false;
    }
  }

  function clearAll(msg) {
    if (!confirm(msg)) return;
    const st = storage();
    if (st) { try { st.removeItem(STORAGE_KEY); st.removeItem(LEGACY_KEY); } catch (e) { /* nada */ } }
    cryptoKey = null; ready = false;
    location.reload();
  }

  // ---------------------------------------------------------------- arranque
  function bind() {
    VALUE_IDS.forEach((id) => $(id).addEventListener('input', () => { userChanged = true; queueRender(); }));
    $('moneda').addEventListener('change', () => { $('moneda').value = sanitizeSymbol($('moneda').value); });
    $('tableBody').addEventListener('change', onTableChange);
    $('resetBtn').addEventListener('click', () => {
      if (Object.keys(ov).length && !confirm('¿Borrar todas las ediciones manuales de la tabla?')) return;
      ov = {}; userChanged = true; render();
    });
    $('applyRangeBtn').addEventListener('click', applyRange);
    $('btnAnual').addEventListener('click', () => setView('anual'));
    $('btnMensual').addEventListener('click', () => setView('mensual'));
    $('pinEnableBtn').addEventListener('click', enablePin);
    $('pinDisableBtn').addEventListener('click', disablePin);
    $('lockNowBtn').addEventListener('click', lockNow);
    $('clearAllBtn').addEventListener('click', () =>
      clearAll('¿Borrar todos tus datos de este dispositivo (y el PIN, si hay)? No se puede deshacer.'));
    $('forgotBtn').addEventListener('click', () =>
      clearAll('Sin el PIN no hay forma de recuperar los datos cifrados. ¿Borrarlos y empezar de cero?'));

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); saveNow(); }
      else if (cryptoKey && hiddenAt && Date.now() - hiddenAt > AUTOLOCK_MS) lockNow();
    });
  }

  function start() {
    bind();
    const env = readEnvelope();
    if (env && env.enc) {
      locked = true;
      document.body.classList.add('locked');
      $('lockScreen').classList.remove('hidden');
      $('unlockBtn').addEventListener('click', () => tryUnlock(env));
      $('lockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(env); });
      $('lockPin').focus();
      return;
    }
    if (env && env.data) applyData(env.data);
    ready = true;
    updatePinUi();
    render();
    if (env && env.migrated) saveNow();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* sin soporte: sigue funcionando online */ });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
