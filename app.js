/* ============================================================
   Windows Media Player — Visualizer
   Vanilla JS · Web Audio API · Canvas 2D · no libraries

   AUDIO GRAPH CONTRACT (the important part)
   -----------------------------------------
   There is exactly ONE <audio> element and exactly ONE
   MediaElementAudioSourceNode for the entire life of the page.

       <audio>  ->  MediaElementSource  ->  Analyser  ->  destination

   createMediaElementSource() may only be called once per media
   element — calling it twice throws InvalidStateError. So swapping
   tracks never touches the graph: we pause, assign a new
   audio.src, and the existing source node follows the element.
   Two source nodes can never fight over the analyser, because a
   second one is never created.

   No audio is ever started outside a user gesture: the
   AudioContext itself is constructed inside the Play handler.
   ============================================================ */

(() => {
  'use strict';

  // ── DOM ───────────────────────────────────────────────────
  const audioEl   = document.getElementById('audio');
  const canvas    = document.getElementById('viz');
  const well      = document.getElementById('vizWell');
  const player    = document.getElementById('player');
  const fileInput = document.getElementById('fileInput');
  const fileBtn   = document.getElementById('fileBtn');
  const playBtn   = document.getElementById('playBtn');
  const playGlyph = document.getElementById('playGlyph');
  const playLabel = document.getElementById('playLabel');
  const stopBtn   = document.getElementById('stopBtn');
  const fsBtn     = document.getElementById('fsBtn');
  const modeBtns  = [...document.querySelectorAll('.seg')];
  const modeBadge = document.getElementById('modeBadge');
  const trackName = document.getElementById('trackName');
  const timeText  = document.getElementById('timeText');
  const statusEl  = document.getElementById('statusText');
  const srcText   = document.getElementById('srcText');
  const lcd       = document.querySelector('.lcd');

  const ctx2d = canvas.getContext('2d', { alpha: false });

  // The default track, named once so the status messages can never drift from
  // what <audio src> in index.html actually requests.
  const DEFAULT_TRACK = 'songs/oru-naal.mp3';

  // ── Tunables ──────────────────────────────────────────────
  const BAR_COUNT   = 64;      // display bars (not FFT bins)
  const FFT_SIZE    = 2048;    // -> 1024 frequency bins, ~21 Hz each
  const F_MIN       = 30;      // Hz, low edge of the display range
  const F_MAX       = 16000;   // Hz, high edge
  const ATTACK      = 38;      // per-bar rise rate  (1/s)
  const RELEASE     = 9;       // per-bar fall rate  (1/s)
  const PEAK_HOLD   = 0.32;    // seconds a cap hangs before dropping
  const PEAK_GRAV   = 2.1;     // cap acceleration   (units/s^2)

  // The analyser does its own temporal averaging before we ever see a byte.
  // Stacking that on top of the attack/release envelope below smears every
  // transient twice, which reads as lag. Keep it low and let the envelope
  // — which has a genuinely fast attack — do the shaping.
  const SMOOTHING   = 0.5;

  // Auto-gain. A fixed dB window ties the display to how hard the track was
  // mastered: quiet mixes never leave the floor, loud ones sit pinned. Track
  // a fast-rising, slow-falling reference peak and normalise against it so
  // every track uses the full height.
  const AGC_FLOOR   = 0.30;    // reference never falls below this (no runaway gain on near-silence)
  const AGC_DECAY   = 0.5;     // 1/s, how fast the reference relaxes back down
  const BASS_LO     = 30;      // Hz, beat-detection band
  const BASS_HI     = 150;

  // ── State ─────────────────────────────────────────────────
  const state = {
    audioCtx: null,
    analyser: null,
    source: null,          // the one and only MediaElementSourceNode
    freq: null,            // Uint8Array of byte frequency data
    time: new Uint8Array(FFT_SIZE),  // byte time-domain data (Scope)
    bands: [],             // [loBin, hiBin] per display bar
    centers: [],           // fractional centre bin per display bar
    raw:      new Float32Array(BAR_COUNT),  // this frame's pre-gain bar targets
    bassBins: [1, 8],      // beat-detection bin range, derived from BASS_LO/HI
    agcRef:   AGC_FLOOR,   // rolling reference peak the display normalises against
    levels:   new Float32Array(BAR_COUNT),
    peaks:    new Float32Array(BAR_COUNT),
    peakVel:  new Float32Array(BAR_COUNT),
    peakHold: new Float32Array(BAR_COUNT),
    mode: 'bars',
    intensity: 0,          // smoothed overall loudness, 0..1
    bassAvg: 0,            // running mean of bass energy
    flash: 0,              // beat flash envelope, 0..1
    lastBeat: 0,
    rotation: 0,
    objectUrl: null,       // currently held blob URL, if any
    usingDefault: true,
    lastTime: 0,
    playing: false,
  };

  // ── Canvas sizing (DPR aware) ─────────────────────────────
  let cssW = 0, cssH = 0;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = well.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  new ResizeObserver(resizeCanvas).observe(well);
  resizeCanvas();

  // ── Audio graph ───────────────────────────────────────────
  // Built once, lazily, from inside a user gesture.
  function ensureAudioGraph() {
    if (state.audioCtx) return true;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      setStatus('This browser does not support the Web Audio API.', true);
      return false;
    }

    state.audioCtx = new AC();

    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    // Default -100/-30 dB wastes most of the byte range on silence.
    // This window keeps loud, modern masters off the ceiling while
    // still lifting quiet passages clear of the floor.
    analyser.minDecibels = -92;
    analyser.maxDecibels = -14;

    state.analyser = analyser;
    state.freq = new Uint8Array(analyser.frequencyBinCount);
    state.time = new Uint8Array(analyser.fftSize);

    // The single source node. Never created again.
    state.source = state.audioCtx.createMediaElementSource(audioEl);
    state.source.connect(analyser);
    analyser.connect(state.audioCtx.destination);

    buildBands();
    return true;
  }

  // Map BAR_COUNT display bars onto FFT bins logarithmically.
  // Linear binning would cram all musical content into the left
  // quarter and leave the right side permanently dead.
  function buildBands() {
    const binCount = state.analyser.frequencyBinCount;
    const nyquist  = state.audioCtx.sampleRate / 2;
    const bands = [];
    const centers = [];

    for (let i = 0; i < BAR_COUNT; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / BAR_COUNT);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / BAR_COUNT);
      let lo = Math.floor((f0 / nyquist) * binCount);
      let hi = Math.ceil((f1 / nyquist) * binCount);
      lo = Math.min(Math.max(lo, 1), binCount - 1);
      hi = Math.min(Math.max(hi, lo + 1), binCount);
      bands.push([lo, hi]);

      // Fractional bin position of the band's centre. At fftSize 512
      // a bin spans ~86 Hz, so every bar below ~350 Hz would otherwise
      // land on the same bin and render as identical stair-steps.
      // The low bars interpolate between bins instead.
      const fc = Math.sqrt(f0 * f1);
      centers.push(Math.min((fc / nyquist) * binCount, binCount - 1.001));
    }
    state.bands = bands;
    state.centers = centers;

    // Beat detection reads real Hz, not hardcoded bin indices — those mean
    // different frequencies at different fftSize/sample rates. At the old
    // fftSize these bins covered ~86-690 Hz, which is vocals and guitar,
    // not kick drum.
    state.bassBins = [
      Math.max(1, Math.floor((BASS_LO / nyquist) * binCount)),
      Math.max(2, Math.ceil((BASS_HI / nyquist) * binCount)),
    ];
  }

  // ── Playback ──────────────────────────────────────────────
  async function startPlayback() {
    if (!ensureAudioGraph()) return;

    // Browsers start the context suspended until a gesture resumes it.
    if (state.audioCtx.state === 'suspended') {
      try { await state.audioCtx.resume(); } catch (_) { /* ignore */ }
    }

    try {
      await audioEl.play();
      setStatus('Playing.');
    } catch (err) {
      setStatus(
        state.usingDefault
          ? 'Could not play ' + DEFAULT_TRACK + ' — check the file, or use Open File…'
          : 'Could not play that file: ' + (err && err.message ? err.message : err),
        true
      );
    }
  }

  function togglePlay() {
    if (audioEl.paused) startPlayback();
    else { audioEl.pause(); setStatus('Paused.'); }
  }

  function stopPlayback() {
    audioEl.pause();
    audioEl.currentTime = 0;
    setStatus('Stopped.');
  }

  // Swap the source track. The graph is deliberately untouched.
  function loadFile(file) {
    if (!file) return;

    const wasPlaying = !audioEl.paused;

    audioEl.pause();                                   // old track stops first
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);

    state.objectUrl   = URL.createObjectURL(file);
    state.usingDefault = false;

    audioEl.src = state.objectUrl;                     // same element, same source node
    audioEl.load();

    resetAnalysis();
    lcd.classList.remove('is-error');
    trackName.textContent = file.name.replace(/\.[^.]+$/, '');
    srcText.textContent = 'Source: uploaded file';
    setStatus(wasPlaying ? 'Switched track.' : 'Loaded. Press Play.');

    // A file-picker change is itself a user gesture, so resuming here is legal.
    if (wasPlaying) startPlayback();
  }

  function resetAnalysis() {
    state.levels.fill(0);
    state.peaks.fill(0);
    state.peakVel.fill(0);
    state.peakHold.fill(0);
    state.intensity = 0;
    state.bassAvg = 0;
    state.flash = 0;
    state.agcRef = AGC_FLOOR;   // a new track must not inherit the old one's gain
  }

  // ── UI helpers ────────────────────────────────────────────
  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', !!isError);
    lcd.classList.toggle('is-error', !!isError);
  }

  function syncPlayButton() {
    const paused = audioEl.paused;
    playGlyph.textContent = paused ? '▶' : '❚❚';
    playLabel.textContent = paused ? 'Play' : 'Pause';
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  }

  function syncTime() {
    timeText.textContent = fmtTime(audioEl.currentTime) + ' / ' + fmtTime(audioEl.duration);
  }

  const MODES = ['bars', 'radial', 'scope', 'cascade'];
  const MODE_LABELS = { bars: 'Bars', radial: 'Radial', scope: 'Scope', cascade: 'Cascade' };

  function setMode(mode) {
    if (!MODE_LABELS[mode]) return;
    state.mode = mode;
    modeBtns.forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode));
    modeBadge.textContent = MODE_LABELS[mode];
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    resizeCanvas();
  }

  function cycleMode() {
    setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
  }

  // ── Analysis step ─────────────────────────────────────────
  function analyse(dt) {
    const playing = !audioEl.paused && !audioEl.ended;
    state.playing = playing;

    if (state.analyser && playing) {
      state.analyser.getByteFrequencyData(state.freq);
      state.analyser.getByteTimeDomainData(state.time);

      // Pass 1: raw per-bar magnitude, and the loudest bar this frame.
      let frameMax = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const [lo, hi] = state.bands[i];
        let v;

        if (hi - lo <= 1) {
          // Narrower than one bin (the very bottom): interpolate.
          const p  = state.centers[i];
          const i0 = Math.floor(p);
          const w  = p - i0;
          v = state.freq[i0] * (1 - w) + state.freq[i0 + 1] * w;
        } else {
          // Peak within the band reads better than a mean — means
          // wash narrow musical partials out into mush.
          v = 0;
          for (let b = lo; b < hi; b++) if (state.freq[b] > v) v = state.freq[b];
        }
        v /= 255;

        // Tilt: high frequencies carry far less energy than lows.
        v *= 0.86 + 0.80 * (i / (BAR_COUNT - 1));
        state.raw[i] = v;
        if (v > frameMax) frameMax = v;
      }

      // Auto-gain reference: jump to a new peak instantly, relax back slowly.
      // Rising instantly matters — a gain that lags the first hit of a track
      // clips the very transient the display exists to show.
      if (frameMax > state.agcRef) state.agcRef = frameMax;
      else state.agcRef += (frameMax - state.agcRef) * (1 - Math.exp(-dt * AGC_DECAY));

      const gain = 1 / Math.max(state.agcRef, AGC_FLOOR);

      // Pass 2: normalise, curve, and drive the envelopes.
      let sum = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = Math.pow(Math.min(state.raw[i] * gain, 1), 0.88);
        state.raw[i] = v;          // kept post-gain: Cascade wants this, not the envelope
        applyEnvelope(i, v, dt);
        sum += state.levels[i];
      }

      const level = sum / BAR_COUNT;
      state.intensity += (level - state.intensity) * (1 - Math.exp(-dt * 6));

      // Beat detection off the true bass band, against a running mean.
      // The test is purely relative apart from a small floor — an absolute
      // threshold means a quietly-mastered track never flashes at all.
      const [bLo, bHi] = state.bassBins;
      let bass = 0;
      for (let b = bLo; b < bHi; b++) bass += state.freq[b];
      bass /= ((bHi - bLo) * 255);
      state.bassAvg += (bass - state.bassAvg) * (1 - Math.exp(-dt * 3));

      const now = performance.now();
      if (bass > state.bassAvg * 1.35 && bass > 0.04 && now - state.lastBeat > 160) {
        state.flash = 1;
        state.lastBeat = now;
      }
    } else {
      // Idle shimmer so the well never looks broken.
      const t = performance.now() / 1000;
      for (let i = 0; i < BAR_COUNT; i++) {
        const wave = 0.05
          + 0.035 * Math.sin(t * 1.5 + i * 0.30)
          + 0.020 * Math.sin(t * 0.7 + i * 0.11);
        applyEnvelope(i, Math.max(0.012, wave), dt);
      }
      state.intensity += (0.06 - state.intensity) * (1 - Math.exp(-dt * 3));

      // A drifting idle waveform, so Scope has something to trace.
      const n = state.time.length;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        state.time[i] = 128
          + Math.sin(p * Math.PI * 4 + t * 1.8) * 9 * (0.6 + 0.4 * Math.sin(t * 0.6))
          + Math.sin(p * Math.PI * 15 - t * 2.6) * 3;
      }
    }

    state.flash *= Math.exp(-dt * 5.5);
    state.rotation += dt * (0.05 + state.intensity * 0.28);
  }

  // Fast attack, slow release + gravity-driven peak caps.
  function applyEnvelope(i, target, dt) {
    const cur = state.levels[i];
    const rate = target > cur ? ATTACK : RELEASE;
    const lvl = cur + (target - cur) * (1 - Math.exp(-dt * rate));
    state.levels[i] = lvl;

    if (lvl >= state.peaks[i]) {
      state.peaks[i] = lvl;
      state.peakVel[i] = 0;
      state.peakHold[i] = PEAK_HOLD;
    } else if (state.peakHold[i] > 0) {
      state.peakHold[i] -= dt;
    } else {
      state.peakVel[i] += PEAK_GRAV * dt;
      state.peaks[i] = Math.max(lvl, state.peaks[i] - state.peakVel[i] * dt);
    }
  }

  // ── Colour ────────────────────────────────────────────────
  // Classic green -> yellow -> red meter ramp. Brightness and
  // saturation ride the overall intensity, so the whole display
  // gets hotter when the track does. LUTs are memoised per
  // intensity bucket to keep string building out of the loop.
  const lutCache = new Map();

  function getLUT(intensity) {
    const bucket = Math.round(Math.min(intensity, 1) * 8);
    let lut = lutCache.get(bucket);
    if (lut) return lut;

    const k = bucket / 8;
    lut = new Array(BAR_COUNT + 1);
    for (let s = 0; s <= BAR_COUNT; s++) {
      const t = s / BAR_COUNT;
      const hue = t < 0.55
        ? 122 - (t / 0.55) * 52          // 122 -> 70  (green to amber)
        : 70  - ((t - 0.55) / 0.45) * 70; // 70  -> 0   (amber to red)
      const sat = 88 + k * 12;
      const lit = 40 + k * 14 + t * 12;
      lut[s] = `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${lit.toFixed(0)}%)`;
    }
    lutCache.set(bucket, lut);
    return lut;
  }

  // Cascade needs a different ramp: a spectrogram carries magnitude in
  // brightness, so quiet bands fall away to near-black and structure
  // stands out, rather than every lit cell reading as a solid slab.
  const cascadeCache = new Map();

  function getCascadeLUT(intensity) {
    const bucket = Math.round(Math.min(intensity, 1) * 8);
    let lut = cascadeCache.get(bucket);
    if (lut) return lut;

    const k = bucket / 8;
    lut = new Array(BAR_COUNT + 1);
    for (let s = 0; s <= BAR_COUNT; s++) {
      const t = s / BAR_COUNT;
      const hue = t < 0.55
        ? 132 - (t / 0.55) * 62
        : 70  - ((t - 0.55) / 0.45) * 70;
      // Steep ramp. A gentle one lights every cell that carries any energy at
      // all, and the waterfall reads as a solid slab of colour with no visible
      // structure. Quiet bands have to fall most of the way to black for the
      // loud ones to mean anything.
      const lit = 2 + Math.pow(t, 1.8) * (58 + k * 12);
      lut[s] = `hsl(${hue.toFixed(0)} ${(70 + t * 30).toFixed(0)}% ${lit.toFixed(0)}%)`;
    }
    cascadeCache.set(bucket, lut);
    return lut;
  }

  // ── Renderers ─────────────────────────────────────────────
  function drawBackground(trail) {
    if (trail) {
      // Enough persistence to smear motion, not enough to spiral.
      ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
    } else {
      ctx2d.fillStyle = '#000';
    }
    ctx2d.fillRect(0, 0, cssW, cssH);

    // Beat-reactive wash: a bloom from the centre on bass hits.
    const f = state.flash;
    if (f > 0.01) {
      const hue = 150 - state.intensity * 130;
      const g = ctx2d.createRadialGradient(
        cssW / 2, cssH / 2, 0,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.62
      );
      g.addColorStop(0, `hsla(${hue} 90% 55% / ${(f * 0.20).toFixed(3)})`);
      g.addColorStop(1, 'hsla(0 0% 0% / 0)');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, cssW, cssH);
    }
  }

  function drawBars() {
    drawBackground(false);

    const lut  = getLUT(state.intensity);
    const cy   = cssH / 2;
    const padX = 10;
    const slot = (cssW - padX * 2) / BAR_COUNT;
    const barW = Math.max(2, Math.floor(slot * 0.72));
    const off  = (slot - barW) / 2;

    const segH  = 5;
    const segGap = 2;
    const step  = segH + segGap;
    const halfH = cy - 8;
    const segs  = Math.max(4, Math.floor(halfH / step));

    // Centre seam, brightening with the mix.
    const seam = ctx2d.createLinearGradient(0, cy - 1, cssW, cy + 1);
    seam.addColorStop(0,   'rgba(80,255,140,0)');
    seam.addColorStop(0.5, `rgba(140,255,190,${(0.18 + state.intensity * 0.5).toFixed(3)})`);
    seam.addColorStop(1,   'rgba(80,255,140,0)');
    ctx2d.fillStyle = seam;
    ctx2d.fillRect(0, cy - 0.5, cssW, 1);

    for (let i = 0; i < BAR_COUNT; i++) {
      const x   = padX + i * slot + off;
      const lvl = Math.min(state.levels[i], 1);
      const lit = Math.round(lvl * segs);

      for (let s = 0; s < lit; s++) {
        const t = segs > 1 ? s / (segs - 1) : 0;
        const color = lut[Math.round(t * BAR_COUNT)];
        const y = cy - 4 - s * step - segH;

        const isTop = (s === lit - 1);
        if (isTop) {
          ctx2d.shadowColor = color;
          ctx2d.shadowBlur = 6 + state.intensity * 12;
        }

        ctx2d.fillStyle = color;
        ctx2d.fillRect(x, y, barW, segH);                        // upper half

        ctx2d.globalAlpha = 0.42;
        ctx2d.fillRect(x, cssH - y - segH, barW, segH);           // mirrored lower half
        ctx2d.globalAlpha = 1;

        if (isTop) ctx2d.shadowBlur = 0;
      }

      // Peak-hold cap
      const pk = Math.min(state.peaks[i], 1);
      if (pk > 0.02) {
        const pSeg = Math.min(Math.round(pk * segs), segs);
        const py = cy - 4 - pSeg * step - 2;
        ctx2d.fillStyle = '#eafff2';
        ctx2d.shadowColor = lut[BAR_COUNT];
        ctx2d.shadowBlur = 8;
        ctx2d.fillRect(x, py, barW, 2);
        ctx2d.globalAlpha = 0.42;
        ctx2d.fillRect(x, cssH - py - 2, barW, 2);
        ctx2d.globalAlpha = 1;
        ctx2d.shadowBlur = 0;
      }
    }
  }

  function drawRadial() {
    drawBackground(true);   // trails read beautifully in this mode

    const lut = getLUT(state.intensity);
    const cx = cssW / 2;
    const cy = cssH / 2;
    const base = Math.min(cssW, cssH);
    const pulse = 1 + state.flash * 0.06;
    const r0 = base * 0.155 * pulse;
    const maxLen = base * 0.30;

    // Inner ring
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r0 - 5, 0, Math.PI * 2);
    ctx2d.strokeStyle = `hsla(${(140 - state.intensity * 120).toFixed(0)} 90% 60% / ${(0.25 + state.intensity * 0.5).toFixed(2)})`;
    ctx2d.lineWidth = 1 + state.intensity * 2;
    ctx2d.shadowColor = ctx2d.strokeStyle;
    ctx2d.shadowBlur = 10 + state.intensity * 22;
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;

    const segH = 5;
    const segGap = 2;
    const step = segH + segGap;
    const segs = Math.max(4, Math.floor(maxLen / step));
    const arc = (Math.PI * 2) / BAR_COUNT;
    const barW = Math.max(2, r0 * arc * 0.62);

    ctx2d.save();
    ctx2d.translate(cx, cy);
    ctx2d.rotate(state.rotation);

    for (let i = 0; i < BAR_COUNT; i++) {
      ctx2d.save();
      ctx2d.rotate(i * arc);

      const lvl = Math.min(state.levels[i], 1);
      const lit = Math.round(lvl * segs);

      for (let s = 0; s < lit; s++) {
        const t = segs > 1 ? s / (segs - 1) : 0;
        const color = lut[Math.round(t * BAR_COUNT)];
        const r = r0 + s * step;

        const isTop = (s === lit - 1);
        if (isTop) {
          ctx2d.shadowColor = color;
          ctx2d.shadowBlur = 6 + state.intensity * 14;
        }

        ctx2d.fillStyle = color;
        ctx2d.fillRect(-barW / 2, -r - segH, barW, segH);          // outward

        // Inward mirror — the radial answer to WMP's top/bottom mirror.
        ctx2d.globalAlpha = 0.30;
        const rIn = r0 - 10 - s * step;
        if (rIn > 4) ctx2d.fillRect(-barW / 2, rIn, barW, segH);
        ctx2d.globalAlpha = 1;

        if (isTop) ctx2d.shadowBlur = 0;
      }

      const pk = Math.min(state.peaks[i], 1);
      if (pk > 0.02) {
        const pSeg = Math.min(Math.round(pk * segs), segs);
        const pr = r0 + pSeg * step + 3;
        ctx2d.fillStyle = '#eafff2';
        ctx2d.shadowColor = lut[BAR_COUNT];
        ctx2d.shadowBlur = 8;
        ctx2d.fillRect(-barW / 2, -pr - 2, barW, 2);
        ctx2d.shadowBlur = 0;
      }

      ctx2d.restore();
    }

    ctx2d.restore();
  }

  // Oscilloscope. The only mode driven by time-domain data rather
  // than the FFT — three stacked traces at falling amplitude give
  // the depth the single-line version always lacks.
  function drawScope() {
    drawBackground(true);

    const data = state.time;
    const n = data.length;
    const cy = cssH / 2;
    const amp = cssH * 0.40;
    const hue = 140 - state.intensity * 130;

    // Centre rule
    ctx2d.fillStyle = `hsla(${hue.toFixed(0)} 80% 60% / 0.14)`;
    ctx2d.fillRect(0, cy - 0.5, cssW, 1);

    const traces = [
      { scale: 1.00, alpha: 1.00, width: 2.0, lift: 60 },
      { scale: 0.62, alpha: 0.45, width: 1.5, lift: 30 },
      { scale: 0.34, alpha: 0.22, width: 1.0, lift: 0  },
    ];

    for (const tr of traces) {
      ctx2d.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * cssW;
        const y = cy - ((data[i] - 128) / 128) * amp * tr.scale;
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      const col = `hsl(${(hue + tr.lift * 0.25).toFixed(0)} ${(85 + state.intensity * 15).toFixed(0)}% ${(52 + state.intensity * 18).toFixed(0)}%)`;
      ctx2d.globalAlpha = tr.alpha;
      ctx2d.strokeStyle = col;
      ctx2d.lineWidth = tr.width + state.intensity * 2;
      ctx2d.lineJoin = 'round';
      ctx2d.shadowColor = col;
      ctx2d.shadowBlur = 8 + state.intensity * 20;
      ctx2d.stroke();
    }

    ctx2d.globalAlpha = 1;
    ctx2d.shadowBlur = 0;
  }

  // Scrolling spectrogram. Kept on an offscreen canvas that shifts
  // itself down one pixel per frame; only the new top row is drawn,
  // so cost stays flat regardless of how much history is on screen.
  let wfCanvas = null, wfCtx = null;

  function ensureWaterfall() {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (!wfCanvas) {
      wfCanvas = document.createElement('canvas');
      // Opaque: every stored pixel stays fully opaque, so shifting the
      // buffer into itself can never accumulate alpha artefacts.
      wfCtx = wfCanvas.getContext('2d', { alpha: false });
    }
    if (wfCanvas.width !== w || wfCanvas.height !== h) {
      wfCanvas.width = w;
      wfCanvas.height = h;
      wfCtx.fillStyle = '#000';
      wfCtx.fillRect(0, 0, w, h);
    }
    return { w, h };
  }

  function drawCascade() {
    const { w } = ensureWaterfall();
    const lut = getCascadeLUT(state.intensity);

    // Shift the whole history down by one pixel.
    wfCtx.drawImage(wfCanvas, 0, 1);

    // New row along the top.
    wfCtx.fillStyle = '#000';
    wfCtx.fillRect(0, 0, w, 1);

    // Paused? Scroll black. The history is a record of what was
    // actually heard, so idle shimmer has no business being in it.
    const colW = w / BAR_COUNT;
    for (let i = 0; state.playing && i < BAR_COUNT; i++) {
      // The instantaneous value, not the envelope. A slow release smears each
      // event down several rows of history, blurring exactly the onsets a
      // spectrogram exists to show.
      const lvl = Math.min(state.raw[i], 1);
      if (lvl < 0.02) continue;
      wfCtx.fillStyle = lut[Math.round(lvl * BAR_COUNT)];
      wfCtx.fillRect(i * colW, 0, Math.ceil(colW), 1);
    }

    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, cssW, cssH);
    ctx2d.drawImage(wfCanvas, 0, 0, cssW, cssH);

    // Bright "now" line at the top edge, plus the beat wash.
    ctx2d.fillStyle = `hsla(${(140 - state.intensity * 130).toFixed(0)} 90% 70% / ${(0.30 + state.intensity * 0.5).toFixed(2)})`;
    ctx2d.fillRect(0, 0, cssW, 1);

    const f = state.flash;
    if (f > 0.01) {
      ctx2d.fillStyle = `hsla(${(150 - state.intensity * 130).toFixed(0)} 90% 55% / ${(f * 0.10).toFixed(3)})`;
      ctx2d.fillRect(0, 0, cssW, cssH);
    }
  }

  // ── Frame loop ────────────────────────────────────────────
  const RENDERERS = {
    bars:    drawBars,
    radial:  drawRadial,
    scope:   drawScope,
    cascade: drawCascade,
  };

  function frame(now) {
    const dt = state.lastTime ? Math.min((now - state.lastTime) / 1000, 0.05) : 0.016;
    state.lastTime = now;

    analyse(dt);
    (RENDERERS[state.mode] || drawBars)();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Events ────────────────────────────────────────────────
  playBtn.addEventListener('click', togglePlay);
  stopBtn.addEventListener('click', stopPlayback);

  // A clicked button keeps focus, which would make Space re-trigger
  // that button instead of play/pause. Drop focus after a *mouse*
  // activation only (detail > 0) so keyboard users keep their place.
  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', e => { if (e.detail > 0) btn.blur(); });
  });

  fileInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    loadFile(file);
    e.target.value = '';     // allow re-picking the same file
  });

  // The <label> handles the click; this makes it keyboard-operable too.
  fileBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  modeBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  fsBtn.addEventListener('click', () => {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const req = player.requestFullscreen || player.webkitRequestFullscreen;
    if (!req) { setStatus('Full screen is not supported here.', true); return; }
    Promise.resolve(req.call(player))
      .catch(() => setStatus('Full screen was blocked by the browser.', true));
  });
  document.addEventListener('fullscreenchange', resizeCanvas);
  document.addEventListener('webkitfullscreenchange', resizeCanvas);

  audioEl.addEventListener('play',  () => { syncPlayButton(); });
  audioEl.addEventListener('pause', () => { syncPlayButton(); });
  audioEl.addEventListener('ended', () => { syncPlayButton(); setStatus('Finished.'); });
  audioEl.addEventListener('timeupdate', syncTime);
  audioEl.addEventListener('loadedmetadata', syncTime);
  audioEl.addEventListener('durationchange', syncTime);

  audioEl.addEventListener('error', () => {
    if (state.usingDefault) {
      setStatus(DEFAULT_TRACK + ' not found — check the file, or use Open File…', true);
    } else {
      setStatus('That file could not be decoded. Try another audio file.', true);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    const onControl = tag === 'BUTTON' || tag === 'LABEL' || tag === 'INPUT';

    if (e.code === 'Space' && !onControl) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'v' || e.key === 'V') cycleMode();
    else if (e.key === 'f' || e.key === 'F') fsBtn.click();
  });

  // ── Boot ──────────────────────────────────────────────────
  syncPlayButton();
  syncTime();

  if (location.protocol === 'file:') {
    setStatus('Opened via file:// — Web Audio needs a local server. Run: python3 -m http.server 8000', true);
  }
})();
