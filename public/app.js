/**
 * AquaSentinel – Pool Safety Monitor (Đội AquaVix • STEMPETITION)
 * Bản tối giản: gọn nhẹ, thời gian thực (SSE), còi Web Audio, MPU6050 & Màn hình thiết lập khởi động.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    students: [],
    kpis: { total: 0, inWater: 0, onDeck: 0, safe: 0, warning: 0, danger: 0, hardwareOnlineCount: 0, threshold: 10, simulationMode: 'normal' },
    tab: 'pool',
    filterZone: 'ALL',
    filterLane: 'ALL',
    filterRisk: 'ALL',
    search: '',
    audioOn: true,
    voiceOn: true,
    lastSpokenFor: null,
    lastSpokenAt: 0,
    activeDanger: null,
    mutedFor: null,
    dismissedFor: null,
    selectedId: null,
    lastUpdate: 0,
    sessionStart: Date.now(),
    simTargetCount: 0,
    thresholdDragging: false,
    esp32CodeLoaded: false,
    esp32CodeRaw: '',
  };

  const LEVEL = {
    DANGER: { label: 'NGUY HIỂM', chip: 'bg-red-500/20 text-red-500', color: '#ef4444' },
    WARNING: { label: 'VÙNG VẪY', chip: 'bg-amber-500/20 text-amber-500', color: '#f59e0b' },
    SAFE: { label: 'BÌNH THƯỜNG', chip: 'bg-emerald-500/15 text-emerald-500', color: '#10b981' },
    DECK: { label: 'TRÊN BỜ', chip: 'chip-neutral', color: '#64748b' },
  };
  const SIM_LABEL = {
    normal: ['Bình thường', 'bg-emerald-500/15 text-emerald-500'],
    sos: ['SOS', 'bg-red-500/20 text-red-500'],
    silent_drowning: ['Đuối nước', 'bg-orange-500/20 text-orange-500'],
    struggling: ['Vùng vẫy', 'bg-amber-500/20 text-amber-500'],
  };

  const levelOf = (s) => {
    const l = s.risk ? s.risk.level : 'SAFE';
    return l === 'SAFE' && !s.inWater ? 'DECK' : l;
  };
  const shortName = (n) => n.split(' ').slice(-2).join(' ');
  const initials = (n) => n.split(' ').slice(-2).map((w) => w[0]).join('').toUpperCase();
  const idNum = (id) => (String(id).match(/\d+/) || [id])[0].replace(/^0+(?=\d)/, '');
  const fmtTime = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour12: false });

  function toast(msg) {
    const wrap = $('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light', isLight);
    try { localStorage.setItem('aquasentinel_theme', isLight ? 'light' : 'dark'); } catch {}
    const icon = $('themeIcon');
    if (icon) {
      icon.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
      lucide.createIcons();
    }
    if (chart) {
      chart.options.scales.y.grid.color = isLight ? 'rgba(0,0,82,0.08)' : 'rgba(255,255,255,0.07)';
      chart.update('none');
    }
  }

  // ================= CÒI BÁO ĐỘNG (WEB AUDIO) =================
  let ctx = null, osc = null, gain = null, sweepTimer = null, sirenOn = false;

  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function startSiren() {
    if (!state.audioOn || sirenOn) return;
    ensureAudio();
    if (!ctx) return;
    sirenOn = true;
    gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.1);
    gain.connect(ctx.destination);
    osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 650;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    osc.connect(lp).connect(gain);
    osc.start();
    let up = true;
    const sweep = () => {
      if (!osc) return;
      const t = ctx.currentTime;
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(osc.frequency.value, t);
      osc.frequency.linearRampToValueAtTime(up ? 1050 : 650, t + 0.5);
      up = !up;
    };
    sweep();
    sweepTimer = setInterval(sweep, 500);
  }

  function stopSiren() {
    if (!sirenOn) return;
    sirenOn = false;
    clearInterval(sweepTimer);
    const o = osc, g = gain;
    osc = gain = null;
    try {
      g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
      setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch (e) {} }, 200);
    } catch (e) {}
  }

  // Tiếng còi tuýt giáo viên bơi (2800Hz có rung bi 28Hz)
  function playWhistle() {
    ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime;
    const carrier = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const outGain = ctx.createGain();

    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(2850, t);
    lfo.frequency.setValueAtTime(28, t);
    lfoGain.gain.setValueAtTime(140, t);

    outGain.gain.setValueAtTime(0.0001, t);
    outGain.gain.exponentialRampToValueAtTime(0.28, t + 0.04);
    outGain.gain.setValueAtTime(0.28, t + 0.65);
    outGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

    lfo.connect(lfoGain).connect(carrier.frequency);
    carrier.connect(outGain).connect(ctx.destination);
    carrier.start(t);
    lfo.start(t);
    carrier.stop(t + 0.9);
    lfo.stop(t + 0.9);
  }

  document.addEventListener('pointerdown', ensureAudio, { once: true });

  // ================= ĐỒNG HỒ =================
  function tickClock() {
    $('liveClock').textContent = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const sec = Math.floor((Date.now() - state.sessionStart) / 1000);
    if ($('sessionTimer')) {
      $('sessionTimer').textContent = [sec / 3600, (sec % 3600) / 60, sec % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
    }
    const ok = state.lastUpdate && (Date.now() - state.lastUpdate) / 1000 < 5;
    $('connDot').className = 'w-2 h-2 rounded-full ' + (ok ? 'bg-emerald-500' : 'bg-red-500');
  }

  // ================= DỮ LIỆU =================
  async function fetchStatus() {
    try {
      const res = await fetch('/api/pool-status', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) ingest(data.students, data.kpis);
    } catch {}
  }

  function connectStream() {
    if (!window.EventSource) return void setInterval(fetchStatus, 1000);
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data);
        if (p.type === 'STATUS_UPDATE') ingest(p.students, p.kpis);
      } catch {}
    };
    es.onerror = () => {
      es.close();
      setTimeout(connectStream, 3000);
      fetchStatus();
    };
  }

  function ingest(students, kpis) {
    state.students = students || [];
    state.kpis = kpis || state.kpis;
    state.lastUpdate = Date.now();
    renderAll();
  }

  // ================= RENDER =================
  function renderAll() {
    renderKPIs();
    if (state.tab === 'pool') renderPool();
    else renderCards();
    renderAttention();
    renderSimDock();
    handleEmergency();
    if (state.selectedId) {
      const s = state.students.find((x) => x.id === state.selectedId);
      if (s) { fillDetail(s); pushChart(s); }
    }
  }

  function applyLocalSessionConfig(cfg) {
    if (!cfg) return;
    $('hdrClassName').textContent = cfg.className || 'Lớp 10A1 & 10A2';
    $('hdrSupervisor').textContent = cfg.supervisorName || 'Thầy Trần Hữu Nghĩa';
    if ($('tagThDepth')) $('tagThDepth').textContent = `Nông • ${cfg.thDepth ?? cfg.shallowDepth ?? 0.9}m`;
    if ($('tagThcsDepth')) $('tagThcsDepth').textContent = `Trung bình • ${cfg.thcsDepth ?? 1.3}m`;
    if ($('tagThptDepth')) $('tagThptDepth').textContent = `Sâu • ${cfg.thptDepth ?? cfg.deepDepth ?? 1.8}m`;
    if ($('infoWaterEnv')) $('infoWaterEnv').textContent = `${cfg.waterTemp ?? 28.2}°C • pH ${cfg.waterPh ?? 7.3}`;
    const len = cfg.poolLength || 25;
    const wid = cfg.poolWidth || 12.5;
    const area = Math.round(len * wid * 10) / 10;
    if ($('btnPoolSizeLabel')) $('btnPoolSizeLabel').textContent = `${len}×${wid}m (${area}m²)`;
  }

  function renderKPIs() {
    const k = state.kpis;
    const total = k.total || 1;
    $('kpiInWater').textContent = k.inWater;
    $('kpiTotal').textContent = k.total;
    $('kpiOnDeck').textContent = k.onDeck;
    $('kpiSafe').textContent = k.safe;
    $('kpiSafePct').textContent = Math.round((k.safe / total) * 100) + '%';
    $('kpiWarning').textContent = k.warning;
    $('kpiDanger').textContent = k.danger;
    $('kpiThreshold').textContent = k.threshold;
    $('tabCount').textContent = k.total;
    $('kpiWarnCard').classList.toggle('is-warning', k.warning > 0);
    $('kpiDangerCard').classList.toggle('is-danger', k.danger > 0);

    const hwCount = k.hardwareOnlineCount || 0;
    $('hwBadge').classList.toggle('hidden', hwCount === 0);
    if (hwCount > 0) $('hwBadge').textContent = `ESP32 LIVE: ${hwCount}`;
    if (k.sessionConfig) applyLocalSessionConfig(k.sessionConfig);

    const isHwMode = !k.sessionConfig || k.sessionConfig.dataMode !== 'demo';
    $('modeHardware').classList.toggle('active', isHwMode);
    $('modeDemo').classList.toggle('active', !isHwMode);
    $('poolEmptyState').classList.toggle('hidden', !(isHwMode && state.students.length === 0));

    // Pin trung bình các đai đeo & làn đông nhất
    if (state.students.length) {
      const avgBat = Math.round(state.students.reduce((a, s) => a + (Number(s.battery) || 0), 0) / state.students.length);
      const lowBat = state.students.filter((s) => (Number(s.battery) || 0) < 25).length;
      $('infoAvgBattery').textContent = lowBat > 0 ? `${avgBat}% (${lowBat} yếu)` : `${avgBat}%`;
      $('infoAvgBattery').className = 'font-mono font-bold ' + (lowBat > 0 ? 'text-amber-500' : 'text-emerald-500');

      const counts = [0, 0, 0, 0, 0, 0];
      state.students.forEach((s) => { if (s.inWater && s.lane >= 1 && s.lane <= 5) counts[s.lane]++; });
      let maxLane = 0, maxVal = 0;
      for (let i = 1; i <= 5; i++) { if (counts[i] > maxVal) { maxVal = counts[i]; maxLane = i; } }
      $('infoBusiestLane').textContent = maxVal > 0 ? `Làn ${maxLane} (${maxVal} HS)` : 'Trống';
    } else {
      $('infoAvgBattery').textContent = '—';
      $('infoAvgBattery').className = 'font-mono font-bold text-muted';
      $('infoBusiestLane').textContent = 'Chờ thiết bị';
    }
  }

  function filtered() {
    const q = state.search;
    return state.students.filter((s) => {
      if (state.filterZone === 'DECK' && s.inWater) return false;
      if (!['ALL', 'DECK'].includes(state.filterZone) && (!s.inWater || (s.zone || 'THCS') !== state.filterZone)) return false;
      if (state.filterLane !== 'ALL' && (!s.inWater || String(s.lane) !== state.filterLane)) return false;
      if (state.filterRisk !== 'ALL' && (s.risk ? s.risk.level : 'SAFE') !== state.filterRisk) return false;
      if (q && !`${s.name} ${s.id} ${s.class} ${s.zone || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // --- Sơ đồ hồ bơi ---
  const markers = new Map();
  function renderPool() {
    const layer = $('swimmersLayer');
    const list = filtered();
    const seen = new Set();

    list.filter((s) => s.inWater).forEach((s) => {
      let el = markers.get(s.id);
      if (!el) {
        el = document.createElement('button');
        el.className = 'swimmer';
        el.dataset.id = s.id;
        el.innerHTML = '<span class="swimmer-dot"></span><span class="swimmer-label"></span>';
        layer.appendChild(el);
        markers.set(s.id, el);
      }
      const lvl = levelOf(s);
      const poolLen = (state.kpis.sessionConfig && state.kpis.sessionConfig.poolLength) || 25;
      el.dataset.level = lvl;
      el.dataset.dir = s.direction === -1 ? '-1' : '1';
      el.style.left = Math.max(3, Math.min(97, (s.posX / poolLen) * 100)) + '%';
      el.style.top = (Math.min(5, Math.max(1, s.lane)) - 0.5) * 20 + '%';
      el.title = `${s.name} • ${s.class} • ${s.id} • Làn ${s.lane}`;
      el.firstChild.textContent = idNum(s.id);
      el.lastChild.textContent = lvl === 'DANGER'
        ? `${shortName(s.name)} • ${s.sosPressed ? 'SOS' : s.stillDuration + 's'}`
        : shortName(s.name);
      seen.add(s.id);
    });

    for (const [id, el] of markers) {
      if (!seen.has(id)) { el.remove(); markers.delete(id); }
    }

    const deck = list.filter((s) => !s.inWater);
    $('deckList').innerHTML = deck.length
      ? deck.map((s) => `<button class="deck-chip" data-id="${esc(s.id)}">${esc(shortName(s.name))}</button>`).join('')
      : '<span class="text-[11px] text-slate-400">Không có</span>';

    // Cập nhật màu bục xuất phát theo trạng thái nguy hiểm của từng làn + đếm & tô màu 3 phân khu (TH / THCS / THPT)
    const laneState = [null, 'SAFE', 'SAFE', 'SAFE', 'SAFE', 'SAFE'];
    const zoneCount = { TH: 0, THCS: 0, THPT: 0 };
    const zoneState = { TH: 'SAFE', THCS: 'SAFE', THPT: 'SAFE' };
    state.students.forEach((s) => {
      if (!s.inWater) return;
      const lvl = levelOf(s);
      if (s.lane >= 1 && s.lane <= 5) {
        if (lvl === 'DANGER') laneState[s.lane] = 'DANGER';
        else if (lvl === 'WARNING' && laneState[s.lane] !== 'DANGER') laneState[s.lane] = 'WARNING';
      }
      const z = s.zone || 'THCS';
      if (zoneCount[z] !== undefined) {
        zoneCount[z]++;
        if (lvl === 'DANGER') zoneState[z] = 'DANGER';
        else if (lvl === 'WARNING' && zoneState[z] !== 'DANGER') zoneState[z] = 'WARNING';
      }
    });
    document.querySelectorAll('[data-lane-block]').forEach((b) => {
      const ln = Number(b.dataset.laneBlock);
      b.classList.toggle('lane-danger', laneState[ln] === 'DANGER');
      b.classList.toggle('lane-warning', laneState[ln] === 'WARNING');
    });
    ['TH', 'THCS', 'THPT'].forEach((z) => {
      const cntEl = $('zoneCount' + z);
      const colEl = $('zoneCol' + z);
      const tabEl = $('zoneTab' + z);
      if (cntEl) cntEl.textContent = `${zoneCount[z]} HS`;
      [colEl, tabEl].forEach((el) => {
        if (!el) return;
        el.classList.toggle('zone-danger', zoneState[z] === 'DANGER');
        el.classList.toggle('zone-warning', zoneState[z] === 'WARNING');
      });
    });
  }

  // --- Thẻ học sinh ---
  function renderCards() {
    const list = filtered();
    const th = state.kpis.threshold || 10;
    if (!list.length) {
      $('cardsGrid').innerHTML = '<div class="col-span-full text-center text-sm text-muted py-10">Không có học sinh phù hợp</div>';
      return;
    }
    const order = { DANGER: 0, WARNING: 1, SAFE: 2, DECK: 3 };
    list.sort((a, b) => order[levelOf(a)] - order[levelOf(b)]);

    $('cardsGrid').innerHTML = list.map((s) => {
      const lvl = levelOf(s);
      const L = LEVEL[lvl];
      const pct = Math.min(100, (s.stillDuration / th) * 100);
      const barColor = s.stillDuration >= th ? '#ef4444' : s.stillDuration >= th * 0.6 ? '#f59e0b' : '#10b981';
      return `
        <div class="s-card ${lvl.toLowerCase()}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-bold text-main truncate">${esc(s.name)}</div>
              <div class="text-[11px] text-muted">Lớp ${esc(s.class)} • <span class="font-mono">${esc(s.id)}</span></div>
            </div>
            <span class="chip ${L.chip} shrink-0">${L.label}</span>
          </div>
          <div class="grid grid-cols-3 gap-1.5 mt-2.5">
            <div class="mini"><div class="mini-l">Khu vực</div><div class="mini-v ${s.inWater ? 'text-sky-500' : ''}">${s.inWater ? esc(s.zone || 'THCS') : 'Bờ'}</div></div>
            <div class="mini"><div class="mini-l">Nghiêng</div><div class="mini-v">${s.tiltAngle}°</div></div>
            <div class="mini"><div class="mini-l">Làn</div><div class="mini-v">${s.inWater ? 'Làn ' + s.lane : '—'}</div></div>
          </div>
          <div class="mt-2.5">
            <div class="flex justify-between text-[11px] mb-1">
              <span class="text-muted">Bất động</span>
              <span class="font-mono font-bold" style="color:${barColor}">${s.stillDuration}s / ${th}s</span>
            </div>
            <div class="h-1.5 rounded-full bg-slate-500/15 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${barColor}"></div></div>
          </div>
          <div class="flex items-center justify-between mt-2.5 text-[11px] text-muted">
            <span>♥ ${s.heartRate} • ${s.battery}%</span>
            <button data-id="${esc(s.id)}" class="px-2.5 py-1 rounded-lg bg-ocean-500/15 text-ocean-500 font-semibold">Chi tiết</button>
          </div>
        </div>`;
    }).join('');
  }

  // --- Trạng thái cảnh báo ---
  function renderAttention() {
    const list = state.students
      .filter((s) => ['DANGER', 'WARNING'].includes(levelOf(s)))
      .sort((a, b) => (levelOf(a) === 'DANGER' ? -1 : 1) - (levelOf(b) === 'DANGER' ? -1 : 1));
    $('attentionCount').textContent = list.length;
    $('attentionCount').className = 'chip ' + (list.length ? 'bg-red-500/20 text-red-500' : 'chip-neutral');

    if (!list.length) {
      $('attentionList').innerHTML = `
        <div class="flex items-center gap-2.5 p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
          <div class="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center font-bold">✓</div>
          <div><div class="text-xs font-semibold text-emerald-500">Tất cả học sinh an toàn</div>
          <div class="text-[11px] text-muted">Không có tín hiệu bất thường</div></div>
        </div>`;
      return;
    }
    $('attentionList').innerHTML = list.map((s) => {
      const lvl = levelOf(s);
      return `
        <button data-id="${esc(s.id)}" class="alert-row ${lvl.toLowerCase()}">
          <span class="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold font-mono shrink-0" style="background:${LEVEL[lvl].color};color:${lvl === 'WARNING' ? '#1c1917' : '#fff'}">${esc(idNum(s.id))}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold text-main truncate">${esc(s.name)}</span>
              <span class="text-[11px] font-mono font-bold ${lvl === 'DANGER' ? 'text-red-500' : 'text-amber-500'}">${s.sosPressed ? 'SOS' : s.stillDuration + 's'}</span>
            </span>
            <span class="block text-[11px] text-muted truncate">Làn ${s.lane} • ${esc(s.poolZone)}</span>
          </span>
        </button>`;
    }).join('');
  }

  function renderSimDock() {
    const mode = state.kpis.simulationMode || 'normal';
    const [label, cls] = SIM_LABEL[mode] || SIM_LABEL.normal;
    $('simModeLabel').textContent = label;
    $('simModeLabel').className = 'chip ' + cls;
    document.querySelectorAll('[data-sim]').forEach((b) => b.classList.toggle('active', b.dataset.sim === mode));

    if (!state.thresholdDragging) {
      $('thresholdSlider').value = state.kpis.threshold;
      $('thresholdValue').textContent = state.kpis.threshold + 's';
    }

    if (state.students.length && state.simTargetCount !== state.students.length) {
      const sel = $('simTarget');
      const prev = sel.value;
      sel.innerHTML = state.students.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} – ${esc(s.id)}</option>`).join('');
      sel.value = prev && state.students.some((s) => s.id === prev) ? prev : (state.kpis.targetStudentId || state.students[0].id);
      state.simTargetCount = state.students.length;
    }
  }

  // ================= BÁO ĐỘNG KHẨN CẤP =================
  function speakAlert(student) {
    if (!state.voiceOn || !state.audioOn || !('speechSynthesis' in window)) return;
    const now = Date.now();
    if (state.lastSpokenFor === student.id && now - state.lastSpokenAt < 9000) return;
    state.lastSpokenFor = student.id;
    state.lastSpokenAt = now;
    try {
      window.speechSynthesis.cancel();
      const reason = student.sosPressed ? 'đã bấm nút khẩn cấp' : `đang bất động ${student.stillDuration} giây`;
      const zoneSpoken = student.zone === 'TH' ? 'khu tiểu học' : student.zone === 'THPT' ? 'khu trung học phổ thông' : 'khu trung học cơ sở';
      const utter = new SpeechSynthesisUtterance(`Cảnh báo khẩn cấp! Học sinh ${student.name}, tại ${zoneSpoken}, làn ${student.lane}, ${reason}!`);
      utter.lang = 'vi-VN';
      utter.rate = 1.08;
      window.speechSynthesis.speak(utter);
    } catch {}
  }

  function handleEmergency() {
    const dangers = state.students.filter((s) => s.risk && s.risk.level === 'DANGER');
    const d = dangers[0];
    if (!d) {
      state.activeDanger = null;
      state.mutedFor = state.dismissedFor = state.lastSpokenFor = null;
      $('alertFrame').classList.add('hidden');
      $('alertBanner').classList.add('hidden');
      $('emergencyModal').classList.add('hidden');
      stopSiren();
      if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch {} }
      return;
    }

    const isNewDanger = !state.activeDanger || state.activeDanger.id !== d.id;
    state.activeDanger = d;
    const where = `Làn ${d.lane} (${d.poolZone})`;
    $('alertFrame').classList.remove('hidden');
    $('alertBanner').classList.remove('hidden');
    $('alertBannerText').textContent =
      `${d.name} • ${where} • ${d.sosPressed ? 'Nhấn nút SOS' : 'Bất động ' + d.stillDuration + 's'}` +
      (dangers.length > 1 ? ` (+${dangers.length - 1})` : '');

    if (state.mutedFor === d.id) stopSiren();
    else {
      startSiren();
      speakAlert(d);
      if (isNewDanger && navigator.vibrate) {
        try { navigator.vibrate([300, 100, 300, 100, 500]); } catch {}
      }
    }

    if (state.dismissedFor !== d.id) {
      $('emergencyModal').classList.remove('hidden');
      $('emName').textContent = d.name;
      $('emClass').textContent = `Lớp ${d.class}`;
      $('emId').textContent = d.id;
      $('emReason').textContent = d.risk.reason;
      $('emLocation').textContent = where;
      $('emStill').textContent = d.sosPressed ? 'Nhấn SOS' : `${d.stillDuration} giây`;
      $('emInstruction').textContent = `Hãy cử cứu hộ đến Làn ${d.lane} ngay lập tức!`;
      $('emContact').textContent = d.emergencyContact || '—';
    }
  }

  async function resolveAlert() {
    const d = state.activeDanger;
    if (!d) return;
    const notes = ($('emNotes') && $('emNotes').value.trim()) || '';
    const supervisor = (state.kpis.sessionConfig && state.kpis.sessionConfig.supervisorName) || 'Giáo viên thể chất';
    try {
      const res = await fetch('/api/resolve-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: d.id, responderName: supervisor, notes }),
      });
      const data = await res.json();
      if (data.ok) {
        stopSiren();
        if ($('emNotes')) $('emNotes').value = '';
        toast(`Đã cứu hộ ${d.name} • Phản ứng ${data.incident.responseTimeSeconds}s`);
        $('emergencyModal').classList.add('hidden');
        refreshIncidentBadge();
        fetchStatus();
      }
    } catch {}
  }

  // ================= CHI TIẾT HỌC SINH + BIỂU ĐỒ =================
  let chart = null;
  const CHART_N = 40;

  function initChart() {
    const mk = (label, color) => ({ label, data: Array(CHART_N).fill(null), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.35 });
    const isLight = document.body.classList.contains('light');
    chart = new Chart($('accelChart'), {
      type: 'line',
      data: { labels: Array(CHART_N).fill(''), datasets: [mk('X', '#ef4444'), mk('Y', '#10b981'), mk('Z', '#0ea5e9')] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { suggestedMin: -1.5, suggestedMax: 2.5, grid: { color: isLight ? 'rgba(0,0,82,0.08)' : 'rgba(255,255,255,0.07)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        },
      },
    });
  }

  function loadHistoryToChart(hist) {
    if (!chart || !Array.isArray(hist)) return;
    const pad = Math.max(0, CHART_N - hist.length);
    const slice = hist.slice(-CHART_N);
    chart.data.datasets[0].data = Array(pad).fill(null).concat(slice.map((p) => p.x));
    chart.data.datasets[1].data = Array(pad).fill(null).concat(slice.map((p) => p.y));
    chart.data.datasets[2].data = Array(pad).fill(null).concat(slice.map((p) => p.z));
    chart.update('none');
  }

  function pushChart(s) {
    if (!chart || !s.accel) return;
    const v = [Number(s.accel.x) || 0, Number(s.accel.y) || 0, Number(s.accel.z) || 0];
    chart.data.datasets.forEach((ds, i) => { ds.data.push(v[i]); ds.data.shift(); });
    chart.update('none');
    $('dtAx').textContent = v[0].toFixed(2);
    $('dtAy').textContent = v[1].toFixed(2);
    $('dtAz').textContent = v[2].toFixed(2);
    $('dtMag').textContent = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toFixed(2);
  }

  async function openDetail(id) {
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    state.selectedId = id;
    fillDetail(s);
    $('detailModal').classList.remove('hidden');
    try {
      const res = await fetch(`/api/students/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const json = await res.json();
      if (json.ok && json.data && state.selectedId === id) {
        loadHistoryToChart(json.data.accelHistory);
        fillDetail(json.data);
      }
    } catch { pushChart(s); }
  }

  function fillDetail(s) {
    const lvl = levelOf(s);
    const L = LEVEL[lvl];
    $('dtAvatar').textContent = initials(s.name);
    $('dtAvatar').style.cssText = `background:${L.color}22;color:${L.color}`;
    $('dtName').textContent = s.name;
    $('dtBadge').className = 'chip ' + L.chip;
    $('dtBadge').textContent = L.label;
    $('dtHwBadge').classList.toggle('hidden', !s.isHardwareOnline);
    $('dtClass').textContent = 'Lớp ' + s.class;
    $('dtId').textContent = s.id;
    $('dtLocation').textContent = s.inWater ? `Làn ${s.lane} • ${s.poolZone}` : 'Trên bờ';
    $('dtWater').textContent = s.inWater ? 'In Water' : 'Trên bờ';
    $('dtWater').className = 'stat-value ' + (s.inWater ? 'text-sky-500' : 'text-muted');
    $('dtTilt').textContent = `${s.tiltAngle}°`;
    const th = state.kpis.threshold || 10;
    $('dtStill').textContent = `${s.stillDuration}s / ${th}s`;
    $('dtStill').className = 'stat-value ' + (s.stillDuration >= th ? 'text-red-500' : s.stillDuration >= th * 0.6 ? 'text-amber-500' : 'text-emerald-500');
    $('dtVitals').textContent = `${s.heartRate} • ${s.battery}%`;
    $('dtContact').textContent = s.emergencyContact || '—';
    const phoneDigits = String(s.emergencyContact || '').replace(/[^\d+]/g, '');
    $('dtCallLink').href = phoneDigits ? `tel:${phoneDigits}` : '#';
    if ($('dtZoneSelect')) $('dtZoneSelect').value = s.zone || 'THCS';
    $('dtLaneSelect').value = String(s.lane || 1);
    $('btnDtToggleWater').textContent = s.inWater ? 'Đưa lên bờ' : 'Cho xuống bể';
    $('btnDtResolve').classList.toggle('hidden', lvl !== 'DANGER');
    const sig = $('dtSignal');
    if (sig) {
      if (s.isHardwareOnline) {
        const rssiText = s.rssi != null ? `${s.rssi} dBm` : 'Wi-Fi OK';
        const agoText = s.lastSeenAgo != null ? ` • ${s.lastSeenAgo}s` : '';
        sig.textContent = `📶 ${rssiText}${agoText}`;
        sig.classList.remove('hidden');
      } else {
        sig.classList.add('hidden');
      }
    }
  }

  // ================= GIẢ LẬP / API / NHẬT KÝ =================
  async function simulate(mode, studentId) {
    const id = studentId || $('simTarget').value || 'AQUA-11';
    try {
      await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, studentId: id, initialStill: 1 }),
      });
      state.mutedFor = state.dismissedFor = null;
      ensureAudio();
      fetchStatus();
    } catch {}
  }

  let thresholdTimer = null;
  function setThreshold(v) {
    clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(() => {
      fetch('/api/threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: Number(v) }),
      }).finally(() => { state.thresholdDragging = false; });
    }, 200);
  }

  async function refreshIncidentBadge() {
    try {
      const r = await fetch('/api/incidents');
      const d = await r.json();
      if (d.ok) $('incidentBadge').textContent = d.data.length;
      return d.data || [];
    } catch { return []; }
  }

  async function openIncidents() {
    $('incidentsModal').classList.remove('hidden');
    $('incidentsList').innerHTML = '<div class="text-xs text-muted">Đang tải…</div>';
    const items = await refreshIncidentBadge();
    if (items.length) {
      const avg = (items.reduce((a, i) => a + (Number(i.responseTimeSeconds) || 0), 0) / items.length).toFixed(1);
      $('incidentsSummary').textContent = `${items.length} ca đã xử lý • Phản ứng TB: ${avg}s`;
    } else {
      $('incidentsSummary').textContent = 'Chưa có sự cố nào.';
    }
    $('incidentsList').innerHTML = items.length
      ? items.map((i) => `
        <div class="flex items-start justify-between gap-3 p-3 rounded-xl stat-box">
          <div class="min-w-0">
            <div class="flex items-center gap-2"><span class="text-sm font-semibold text-main">${esc(i.studentName)}</span><span class="chip bg-red-500/15 text-red-500 font-mono">${esc(i.triggerType)}</span></div>
            <div class="text-xs text-muted mt-0.5">${esc(i.description)}</div>
            <div class="text-[11px] text-subtle mt-0.5">Làn ${esc(i.lane)} • ${esc(i.resolvedBy)}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs font-mono text-main">${fmtTime(i.timestamp)}</div>
            <div class="text-[11px] text-emerald-500 font-semibold">${esc(i.responseTimeSeconds)}s</div>
          </div>
        </div>`).join('')
      : '<div class="text-xs text-muted">Chưa có sự cố nào.</div>';
  }

  async function loadEsp32Code() {
    if (state.esp32CodeLoaded) return;
    try {
      const res = await fetch('/api/esp32-code');
      const data = await res.json();
      if (data.ok) {
        state.esp32CodeRaw = data.code;
        state.esp32CodeLoaded = true;
        $('esp32CodePre').textContent = data.code;
      }
    } catch { $('esp32CodePre').textContent = '// Không tải được mã nguồn.'; }
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Đã sao chép ${label}`);
    } catch { toast('Không thể sao chép tự động'); }
  }

  // ================= MÀN HÌNH THIẾT LẬP KHỞI ĐỘNG =================
  const parseNum = (val, fallback) => {
    const n = Number(String(val ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : fallback;
  };

  function fillSetupForm(cfg) {
    if (!cfg) return;
    if (cfg.className) $('inpClassName').value = cfg.className;
    if (cfg.supervisorName) $('inpSupervisor').value = cfg.supervisorName;
    if (cfg.studentCount) $('inpStudentCount').value = cfg.studentCount;
    if (cfg.threshold) $('inpThreshold').value = cfg.threshold;
    if ($('inpThDepth') && (cfg.thDepth || cfg.shallowDepth)) $('inpThDepth').value = cfg.thDepth || cfg.shallowDepth;
    if ($('inpThcsDepth') && cfg.thcsDepth) $('inpThcsDepth').value = cfg.thcsDepth;
    if ($('inpThptDepth') && (cfg.thptDepth || cfg.deepDepth)) $('inpThptDepth').value = cfg.thptDepth || cfg.deepDepth;
    if (cfg.dataMode) $('inpDataMode').value = cfg.dataMode;
    $('inpTheme').value = document.body.classList.contains('light') ? 'light' : 'dark';
    $('inpAudioOn').checked = state.audioOn;
  }

  async function switchDataMode(mode) {
    try {
      const res = await fetch('/api/session-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataMode: mode }),
      });
      if (res.ok) {
        state.simTargetCount = 0;
        toast(mode === 'hardware' ? 'Chế độ ESP32 Thật: chỉ hiện mạch đang kết nối' : 'Chế độ Giả lập Demo đã bật');
        fetchStatus();
      }
    } catch {}
  }

  async function openSetup(allowClose) {
    $('btnCloseSetup').classList.toggle('hidden', !allowClose);
    try {
      const saved = JSON.parse(localStorage.getItem('aquasentinel_setup') || 'null');
      if (saved) fillSetupForm(saved);
    } catch {}
    try {
      const res = await fetch('/api/session-config', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok && json.data && (allowClose || json.data.configured)) fillSetupForm(json.data);
    } catch {}
    $('setupOverlay').classList.remove('hidden');
    lucide.createIcons();
  }

  async function submitSetup(useDefault) {
    ensureAudio();
    const payload = useDefault
      ? { dataMode: 'hardware', className: 'TH • THCS • THPT', supervisorName: 'Thầy Trần Hữu Nghĩa', studentCount: 30, threshold: 10, thDepth: 0.9, thcsDepth: 1.3, thptDepth: 1.8 }
      : {
          dataMode: $('inpDataMode').value || 'hardware',
          className: $('inpClassName').value.trim() || 'TH • THCS • THPT',
          supervisorName: $('inpSupervisor').value.trim() || 'Thầy Trần Hữu Nghĩa',
          studentCount: Math.min(40, Math.max(5, Math.round(parseNum($('inpStudentCount').value, 30)))),
          threshold: Math.min(30, Math.max(5, Math.round(parseNum($('inpThreshold').value, 10)))),
          thDepth: Math.min(2.5, Math.max(0.4, parseNum($('inpThDepth')?.value, 0.9))),
          thcsDepth: Math.min(3.0, Math.max(0.6, parseNum($('inpThcsDepth')?.value, 1.3))),
          thptDepth: Math.min(5.0, Math.max(0.8, parseNum($('inpThptDepth')?.value, 1.8))),
        };

    const chosenTheme = useDefault ? (localStorage.getItem('aquasentinel_theme') || 'dark') : $('inpTheme').value;
    const chosenAudio = useDefault ? true : $('inpAudioOn').checked;

    applyTheme(chosenTheme);
    state.audioOn = chosenAudio;
    $('btnToggleAudio').classList.toggle('off', !state.audioOn);
    $('audioIcon').setAttribute('data-lucide', state.audioOn ? 'volume-2' : 'volume-x');
    if (!state.audioOn) stopSiren();

    $('setupOverlay').classList.add('hidden');
    applyLocalSessionConfig(payload);
    toast(`Sẵn sàng giám sát • ${payload.studentCount} HS • Ngưỡng ${payload.threshold}s`);

    try {
      localStorage.setItem('aquasentinel_setup', JSON.stringify(payload));
      sessionStorage.setItem('aquasentinel_session_ready', '1');
    } catch {}

    try {
      const res = await fetch('/api/session-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        state.simTargetCount = 0;
        fetchStatus();
      } else {
        await fetch('/api/threshold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: payload.threshold }),
        }).catch(() => {});
      }
    } catch {}
    lucide.createIcons();
  }

  // ================= SỰ KIỆN UI =================
  function bindUI() {
    const setTab = (t) => {
      state.tab = t;
      $('tabPool').classList.toggle('active', t === 'pool');
      $('tabCards').classList.toggle('active', t === 'cards');
      $('viewPool').classList.toggle('hidden', t !== 'pool');
      $('viewCards').classList.toggle('hidden', t !== 'cards');
      renderAll();
    };
    $('tabPool').onclick = () => setTab('pool');
    $('tabCards').onclick = () => setTab('cards');

    $('modeHardware').onclick = () => switchDataMode('hardware');
    $('modeDemo').onclick = () => switchDataMode('demo');
    $('btnEmptySwitchDemo').onclick = () => switchDataMode('demo');
    $('btnEmptyOpenDocs').onclick = () => { $('docsModal').classList.remove('hidden'); loadEsp32Code(); };

    // Điều chỉnh diện tích & kích thước hồ bơi
    const updatePoolPreview = () => {
      const len = Math.max(8, Math.min(100, parseNum($('inpPoolLength').value, 25)));
      const wid = Math.max(4, Math.min(50, parseNum($('inpPoolWidth').value, 12.5)));
      const area = Math.round(len * wid * 10) / 10;
      $('previewPoolArea').textContent = `${area} m²`;
      const inWater = state.kpis.inWater || 0;
      if (inWater > 0) {
        const perStudent = (area / inWater).toFixed(1);
        $('previewPoolDensity').textContent = `${perStudent} m² / HS`;
        $('previewPoolDensity').className = 'stat-value font-mono ' + (Number(perStudent) < 4 ? 'text-amber-500' : 'text-emerald-500');
      } else {
        $('previewPoolDensity').textContent = 'Rộng rãi';
        $('previewPoolDensity').className = 'stat-value font-mono text-emerald-500';
      }
    };

    $('btnPoolSize').onclick = () => {
      const cfg = state.kpis.sessionConfig || {};
      const len = cfg.poolLength || 25;
      const wid = cfg.poolWidth || 12.5;
      $('inpPoolLength').value = len;
      $('rngPoolLength').value = Math.min(50, Math.max(10, len));
      $('inpPoolWidth').value = wid;
      $('rngPoolWidth').value = Math.min(25, Math.max(5, wid));
      updatePoolPreview();
      $('poolSizeModal').classList.remove('hidden');
      lucide.createIcons();
    };

    $('inpPoolLength').oninput = () => { $('rngPoolLength').value = $('inpPoolLength').value; updatePoolPreview(); };
    $('rngPoolLength').oninput = () => { $('inpPoolLength').value = $('rngPoolLength').value; updatePoolPreview(); };
    $('inpPoolWidth').oninput = () => { $('rngPoolWidth').value = $('inpPoolWidth').value; updatePoolPreview(); };
    $('rngPoolWidth').oninput = () => { $('inpPoolWidth').value = $('rngPoolWidth').value; updatePoolPreview(); };

    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = () => {
        const [l, w] = btn.dataset.preset.split(',');
        $('inpPoolLength').value = l;
        $('rngPoolLength').value = l;
        $('inpPoolWidth').value = w;
        $('rngPoolWidth').value = w;
        updatePoolPreview();
      };
    });

    $('btnApplyPoolSize').onclick = async () => {
      const poolLength = Math.max(8, Math.min(100, parseNum($('inpPoolLength').value, 25)));
      const poolWidth = Math.max(4, Math.min(50, parseNum($('inpPoolWidth').value, 12.5)));
      const area = Math.round(poolLength * poolWidth * 10) / 10;
      $('poolSizeModal').classList.add('hidden');
      if ($('btnPoolSizeLabel')) $('btnPoolSizeLabel').textContent = `${poolLength}×${poolWidth}m (${area}m²)`;
      toast(`Đã đổi kích thước bể: ${poolLength}×${poolWidth}m (${area} m²)`);
      try {
        const res = await fetch('/api/session-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poolLength, poolWidth }),
        });
        if (res.ok) fetchStatus();
      } catch {}
    };

    if ($('filterZone')) $('filterZone').onchange = (e) => { state.filterZone = e.target.value; renderAll(); };
    $('filterLane').onchange = (e) => { state.filterLane = e.target.value; renderAll(); };
    $('filterRisk').onchange = (e) => { state.filterRisk = e.target.value; renderAll(); };
    $('searchInput').oninput = (e) => { state.search = e.target.value.trim().toLowerCase(); renderAll(); };

    ['swimmersLayer', 'deckList', 'cardsGrid', 'attentionList'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        const el = e.target.closest('[data-id]');
        if (el) openDetail(el.dataset.id);
      });
    });

    document.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => {
        $(b.dataset.close).classList.add('hidden');
        if (b.dataset.close === 'detailModal') state.selectedId = null;
      };
    });
    ['detailModal', 'incidentsModal', 'docsModal', 'poolSizeModal'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        if (e.target.id === id) {
          $(id).classList.add('hidden');
          if (id === 'detailModal') state.selectedId = null;
        }
      });
    });

    $('btnDtToggleWater').onclick = async () => {
      if (!state.selectedId) return;
      try {
        const res = await fetch(`/api/students/${encodeURIComponent(state.selectedId)}/toggle-water`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.ok) {
          toast(`${data.student.name}: ${data.student.inWater ? 'Xuống bể' : 'Lên bờ'}`);
          fetchStatus();
        }
      } catch {}
    };

    if ($('dtZoneSelect')) {
      $('dtZoneSelect').onchange = async (e) => {
        if (!state.selectedId) return;
        const zone = e.target.value;
        try {
          const res = await fetch(`/api/students/${encodeURIComponent(state.selectedId)}/zone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zone }),
          });
          const data = await res.json();
          if (data.ok) {
            toast(`Đã chuyển ${data.student.name} sang ${data.student.zoneLabel}`);
            fetchStatus();
          }
        } catch {}
      };
    }

    $('dtLaneSelect').onchange = async (e) => {
      if (!state.selectedId) return;
      const lane = Number(e.target.value);
      try {
        const res = await fetch(`/api/students/${encodeURIComponent(state.selectedId)}/lane`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lane }),
        });
        const data = await res.json();
        if (data.ok) {
          toast(`Đã chuyển ${data.student.name} sang Làn ${lane}`);
          fetchStatus();
        }
      } catch {}
    };

    // Nút điều phối nhanh trên bờ
    $('btnWhistle').onclick = () => {
      playWhistle();
      toast('Đã phát còi tập hợp / giải lao');
    };
    const setAllWater = async (inWater) => {
      try {
        const res = await fetch('/api/pool/all-water', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inWater }),
        });
        if (res.ok) {
          toast(inWater ? 'Đã cho toàn bộ học sinh xuống bể' : 'Đã cho toàn bộ học sinh lên bờ nghỉ');
          fetchStatus();
        }
      } catch {}
    };
    $('btnAllDeck').onclick = () => setAllWater(false);
    $('btnAllWater').onclick = () => setAllWater(true);

    // Đổi Sáng/Tối & Toàn màn hình
    $('btnQuickTheme').onclick = () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
    $('btnFullscreen').onclick = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    };
    document.addEventListener('fullscreenchange', () => {
      const icon = $('fsIcon');
      if (icon) {
        icon.setAttribute('data-lucide', document.fullscreenElement ? 'minimize' : 'maximize');
        lucide.createIcons();
      }
    });

    $('btnEmResolve').onclick = resolveAlert;
    $('btnBannerResolve').onclick = resolveAlert;
    $('btnEmMute').onclick = () => {
      if (!state.activeDanger) return;
      state.mutedFor = state.dismissedFor = state.activeDanger.id;
      stopSiren();
      $('emergencyModal').classList.add('hidden');
    };
    $('btnBannerView').onclick = () => { state.dismissedFor = null; handleEmergency(); };

    $('btnToggleAudio').onclick = () => {
      state.audioOn = !state.audioOn;
      $('btnToggleAudio').classList.toggle('off', !state.audioOn);
      $('audioIcon').setAttribute('data-lucide', state.audioOn ? 'volume-2' : 'volume-x');
      lucide.createIcons();
      toast(state.audioOn ? 'Đã bật còi' : 'Đã tắt còi');
      if (!state.audioOn) stopSiren();
      else handleEmergency();
    };
    if ($('btnToggleVoice')) {
      $('btnToggleVoice').onclick = () => {
        state.voiceOn = !state.voiceOn;
        $('btnToggleVoice').classList.toggle('off', !state.voiceOn);
        toast(state.voiceOn ? 'Đã bật thông báo giọng nói tiếng Việt' : 'Đã tắt giọng nói cảnh báo');
        if (!state.voiceOn && 'speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch {} }
      };
    }

    // Chỉnh sửa hồ sơ học sinh trong Modal Chi tiết
    if ($('btnDtEditToggle')) {
      $('btnDtEditToggle').onclick = () => {
        const s = state.students.find((x) => x.id === state.selectedId);
        if (!s) return;
        const form = $('dtEditForm');
        const opening = form.classList.contains('hidden');
        if (opening) {
          $('dtEditName').value = s.name || '';
          $('dtEditClass').value = s.class || '';
          $('dtEditContact').value = s.emergencyContact || '';
        }
        form.classList.toggle('hidden');
      };
    }
    if ($('dtEditForm')) {
      $('dtEditForm').onsubmit = async (e) => {
        e.preventDefault();
        if (!state.selectedId) return;
        try {
          const res = await fetch(`/api/students/${encodeURIComponent(state.selectedId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: $('dtEditName').value.trim(),
              class: $('dtEditClass').value.trim(),
              emergencyContact: $('dtEditContact').value.trim(),
            }),
          });
          const data = await res.json();
          if (data.ok) {
            $('dtEditForm').classList.add('hidden');
            state.simTargetCount = 0;
            toast(`Đã cập nhật hồ sơ ${data.student.name}`);
            fetchStatus();
          }
        } catch {}
      };
    }
    if ($('btnDtResolve')) {
      $('btnDtResolve').onclick = async () => {
        if (!state.selectedId) return;
        const s = state.students.find((x) => x.id === state.selectedId);
        if (!s) return;
        state.activeDanger = s;
        await resolveAlert();
        $('detailModal').classList.add('hidden');
        state.selectedId = null;
      };
    }
    $('btnTestSound').onclick = () => {
      ensureAudio();
      startSiren();
      setTimeout(() => { if (!state.activeDanger) stopSiren(); }, 1800);
    };

    $('btnOpenIncidents').onclick = openIncidents;
    $('btnOpenDocs').onclick = () => { $('docsModal').classList.remove('hidden'); loadEsp32Code(); };
    $('btnOpenSetup').onclick = () => openSetup(true);
    $('btnCloseSetup').onclick = () => $('setupOverlay').classList.add('hidden');
    $('btnUseDefault').onclick = () => submitSetup(true);
    $('setupForm').onsubmit = (e) => { e.preventDefault(); submitSetup(false); };

    document.querySelectorAll('[data-doctab]').forEach((btn) => {
      btn.onclick = () => {
        const t = btn.dataset.doctab;
        document.querySelectorAll('[data-doctab]').forEach((b) => b.classList.toggle('active', b === btn));
        $('docTabApi').classList.toggle('hidden', t !== 'api');
        $('docTabCode').classList.toggle('hidden', t !== 'code');
        $('docTabTest').classList.toggle('hidden', t !== 'test');
        if (t === 'code') loadEsp32Code();
      };
    });
    $('btnCopyJson').onclick = () => copyText($('sampleJsonPre').textContent, 'JSON');
    $('btnCopyIno').onclick = () => copyText(state.esp32CodeRaw || $('esp32CodePre').textContent, 'code ESP32');
    $('btnSendTestPayload').onclick = async () => {
      const msg = $('testResultMsg');
      try {
        const res = await fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(JSON.parse($('testPayloadInput').value)),
        });
        const data = await res.json();
        msg.textContent = res.ok ? `HTTP ${res.status} OK (${data.student.id})` : `Lỗi ${res.status}`;
        msg.className = (res.ok ? 'text-emerald-500' : 'text-red-500') + ' font-mono';
        if (res.ok) fetchStatus();
      } catch (err) {
        msg.textContent = 'JSON lỗi';
        msg.className = 'text-red-500 font-mono';
      }
    };

    document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => simulate(b.dataset.sim)));
    $('thresholdSlider').oninput = (e) => {
      state.thresholdDragging = true;
      $('thresholdValue').textContent = e.target.value + 's';
      setThreshold(e.target.value);
    };
    $('btnDtSos').onclick = () => {
      if (!state.selectedId) return;
      $('simTarget').value = state.selectedId;
      simulate('sos', state.selectedId);
      $('detailModal').classList.add('hidden');
      state.selectedId = null;
    };

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!$('setupOverlay').classList.contains('hidden')) {
        if (e.key === 'Escape' && !$('btnCloseSetup').classList.contains('hidden')) $('setupOverlay').classList.add('hidden');
        return;
      }
      if (e.key === 'Escape') {
        ['detailModal', 'incidentsModal', 'docsModal', 'poolSizeModal'].forEach((id) => $(id).classList.add('hidden'));
        if ($('dtEditForm')) $('dtEditForm').classList.add('hidden');
        state.selectedId = null;
        return;
      }
      // Phím tắt trình diễn nhanh STEMPETITION
      if (e.key === '1') simulate('normal');
      else if (e.key === '2') simulate('sos');
      else if (e.key === '3') simulate('silent_drowning');
      else if (e.key === '4') simulate('struggling');
      else if (e.key === ' ') { e.preventDefault(); playWhistle(); toast('Đã phát còi tập hợp'); }
      else if (e.key.toLowerCase() === 'm') $('btnToggleAudio').click();
      else if (e.key.toLowerCase() === 'f') $('btnFullscreen').click();
    });
  }

  // ================= KHỞI ĐỘNG =================
  window.addEventListener('DOMContentLoaded', () => {
    applyTheme(localStorage.getItem('aquasentinel_theme') || 'dark');
    lucide.createIcons();
    bindUI();
    initChart();
    tickClock();
    setInterval(tickClock, 1000);
    fetchStatus();
    connectStream();
    refreshIncidentBadge();

    if (!sessionStorage.getItem('aquasentinel_session_ready')) openSetup(false);
    else $('setupOverlay').classList.add('hidden');
  });
})();
