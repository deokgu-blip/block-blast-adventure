// engine/hostbridge.js — GAMEREELS WEBVIEW-HOST FEATURE LAYER (additive, no-op by default).
//
// A thin layer on TOP of the existing game. It is a strict NO-OP on the default
// (non-reels) load path: when `?gamereels` (or window.__GAMEREELS) is NOT present,
// GR.active === false and every GR method returns without emitting anything, no
// body class is added, and the runtime config (RT) is just {from:1, to:100} (the
// existing behavior). So a default load is byte-identical to today's game.
//
// Activated by `?gamereels` (or window.__GAMEREELS). Then GR emits the canonical
// gamereels postMessage contract to the webview host (4 channels), receives
// Pause/Resume, and RT reads start/end/loop/dev from the URL ONCE at module load.
//
// Ported from the sibling game's canonical contract
// (game_dev_supercent/cube_blast.html §gamereels) and adapted to an ES module.
//   · Payload = { event, data }  (data always present, null if none; NO timestamp)
//   · game→host:  GameStart / GameEnd{success,progressIndex,currentIndex}
//                 + Soft/Light/MediumVibrate (haptics delegated to the host)
//   · host→game:  OnMessageFromFlutter({event}) / window 'message' →
//                 GamePause (touch-block + audio pause) / GameResume

// Total adventure stages (used to clamp RT + as the default `to`/cap). The ordered
// stage list in index.html is also 100 (STAGES). Kept here as the single source for
// the host config's level bounds.
export const TOTAL_STAGES = 100;

// ─────────────────────────────────────────────────────────────────────────────
// GR — host bridge (active only under ?gamereels / window.__GAMEREELS)
// ─────────────────────────────────────────────────────────────────────────────
export const GR = (function () {
  let ACTIVE = false;
  try { ACTIVE = /[?&]gamereels\b/.test(location.search) || !!window.__GAMEREELS; } catch (e) { ACTIVE = false; }
  const noop = function () {};
  if (!ACTIVE) {
    // INERT STUB on the default path: every method is a no-op, nothing is emitted,
    // no listeners are installed, no body class added → zero regression.
    return { active: false, emit: noop, gameStart: noop, gameEnd: noop, vibrate: noop, setPaused: noop, isPaused: function () { return false; }, gameState: noop, provideState: noop, onState: noop };
  }

  let _paused = false, _startSent = false;

  function _emit(event, data) {
    if (data === undefined) data = null;          // host spec: data field always present (null if none)
    const msg = { event: event, data: data };     // payload = { event, data } (NO timestamp — host expects {event,data})
    // (1) flutter_inappwebview single channel — send the whole {event,data} object to the
    //     registered handler ('flutterChannel') so the host receives it flat (no wrapping).
    try { if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) window.flutter_inappwebview.callHandler('flutterChannel', msg); } catch (e) {}
    // (2) named bridge object (host may inject)
    try { if (window.GameReels && window.GameReels.post) window.GameReels.post(event, data); } catch (e) {}
    // (3) iOS WKWebView messageHandler fallback
    try { if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.gamereels) window.webkit.messageHandlers.gamereels.postMessage(msg); } catch (e) {}
    // (4) parent/self window postMessage — webview · iframe host common fallback
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {}
    try { window.postMessage(msg, '*'); } catch (e) {}
  }
  function emit(event, data) { try { _emit(event, data); } catch (e) {} }

  function _emitStart() { emit('GameStart', null); }
  function gameStart() {
    if (_startSent) return; _startSent = true; _emitStart();
    // late host-listener guard — re-emit GameStart a few times (idempotent; the host
    // only needs the first signal). Covers a host listener registered after we boot.
    [300, 800, 1600, 3000, 5000].forEach(function (ms) { try { setTimeout(_emitStart, ms); } catch (e) {} });
  }

  // host spec: GameEnd data = { success, progressIndex, currentIndex }. progressIndex AND
  // currentIndex are BOTH the 1-based cleared level (user req: include both).
  function gameEnd(success, level) {
    emit('GameEnd', { success: !!success, progressIndex: level | 0, currentIndex: level | 0 });
  }

  const VMAP = { selection: 'SoftVibrate', light: 'LightVibrate', medium: 'MediumVibrate', heavy: 'MediumVibrate' };
  function vibrate(level) { emit(VMAP[level] || 'LightVibrate'); }

  // ── HOST-DELEGATED PROGRESS (the APP is the source of truth, NOT localStorage) ──
  // game→host SAVE: GameState{ clearedStages, currentStage, currency, items }. The host
  //   stores the payload VERBATIM (currency/items are generic dynamic maps — host must
  //   NOT interpret keys) and hands it back on relaunch.
  // host→game RESTORE: OnMessageFromFlutter({event:'GameState', data}) → onState(cb).
  //   host→game PULL:   OnMessageFromFlutter({event:'RequestState'})  → re-emit current
  //                     state from the registered provider (host pulls a save in early).
  // NOTE: inbound GameState/RequestState are accepted ONLY via OnMessageFromFlutter, never
  // via the window 'message' fallback — our OWN outgoing emit() also window.postMessage's
  // the {event,data}, so honoring GameState there would echo a save back as a restore loop.
  let _stateProvider = null, _restoreCb = null;
  function gameState(data) { emit('GameState', (data == null) ? {} : data); }
  function provideState(fn) { _stateProvider = (typeof fn === 'function') ? fn : null; }
  function onState(fn) { _restoreCb = (typeof fn === 'function') ? fn : null; }

  function setPaused(p) {
    p = !!p; if (p === _paused) return; _paused = p;
    let blk = document.getElementById('gr-pause-block');
    if (p) {
      if (!blk) {
        blk = document.createElement('div'); blk.id = 'gr-pause-block';
        blk.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent;touch-action:none';
        (document.body || document.documentElement).appendChild(blk);
      }
      blk.style.display = 'block';
      try { if (window.__audio && window.__audio.pause) window.__audio.pause(); } catch (e) {}
    } else {
      if (blk) blk.style.display = 'none';
      try { if (window.__audio && window.__audio.resume) window.__audio.resume(); } catch (e) {}
    }
  }

  // host→game receiver: OnMessageFromFlutter (single channel) + window 'message' fallback.
  let _hostSeen = false;
  function _recv(raw) {
    // a message FROM the host means the host listener is alive → re-emit a possibly-missed
    // GameStart (once) so a late host still gets it.
    if (!_hostSeen) { _hostSeen = true; if (_startSent) _emitStart(); }
    let m = raw; if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch (e) { m = { event: raw }; } }
    if (!m || !m.event) return;
    if (m.event === 'GamePause') setPaused(true);
    else if (m.event === 'GameResume') setPaused(false);
    else if (m.event === 'GameState') { if (_restoreCb) { try { _restoreCb(m.data || {}); } catch (e) {} } }   // host → game: restore saved progress
    else if (m.event === 'RequestState') { if (_stateProvider) { try { emit('GameState', _stateProvider() || {}); } catch (e) {} } } // host pulls current state → re-emit
  }
  try { window.OnMessageFromFlutter = function (d) { _recv(d); }; } catch (e) {}
  try { window.addEventListener('message', function (ev) { const d = ev && ev.data; if (d && (d.event === 'GamePause' || d.event === 'GameResume')) _recv(d); }); } catch (e) {}
  try { window.addEventListener('GamePause', function () { setPaused(true); }); window.addEventListener('GameResume', function () { setPaused(false); }); } catch (e) {}

  return { active: true, emit: emit, gameStart: gameStart, gameEnd: gameEnd, vibrate: vibrate, setPaused: setPaused, isPaused: function () { return _paused; }, gameState: gameState, provideState: provideState, onState: onState };
})();

try { window.__GR = GR; } catch (e) {}                                              // headless QA hook (contract-signal visibility)
try { if (GR.active && document.body) document.body.classList.add('gamereels'); } catch (e) {} // reels-build style gate (NO top gap — see CSS .gamereels)

// ─────────────────────────────────────────────────────────────────────────────
// haptic(level) — unified, works in BOTH host (reels) and solo web.
//   · In reels: GR.vibrate(level) delegates the buzz to the host (Soft/Light/Medium).
//   · In solo web: native bridge (Haptics/webkit/AndroidHaptic) if present, else the
//     web Vibration API (navigator.vibrate). Throttled per level so dragging a piece
//     across cells does not machine-gun the motor.
// Firing in solo web is intentional juice (desired) — it does NOT affect the
// default/reels distinction; it's the same in both builds.
// ─────────────────────────────────────────────────────────────────────────────
const HAPTIC = {
  enabled: true,
  MS:  { selection: 8, light: 16, medium: 28, heavy: 48 },   // web fallback vibration length (ms)
  GAP: { selection: 50, light: 60 },                          // throttle (ms): avoid motor overload / rapid-fire
};
const _hapticLast = {};
export function haptic(level) {
  if (!HAPTIC.enabled) return;
  try { if (GR && GR.active) GR.vibrate(level); } catch (e) {}  // reels: delegate the buzz to the host (signal only)
  const gap = HAPTIC.GAP[level] || 0;
  if (gap) {
    const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (t - (_hapticLast[level] || 0) < gap) return;            // too frequent → skip (esp. the selection tick)
    _hapticLast[level] = t;
  }
  try {
    if (window.Haptics && window.Haptics.impact) { window.Haptics.impact(level); return; }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.haptic) { window.webkit.messageHandlers.haptic.postMessage(level); return; }
    if (window.AndroidHaptic && window.AndroidHaptic.impact) { window.AndroidHaptic.impact(level); return; }
  } catch (e) {}
  try { if (navigator.vibrate) navigator.vibrate(HAPTIC.MS[level] || 12); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// RT — runtime config, read from the URL ONCE at module load. Priority: URL > default.
//   from  (?from=10 | ?level=10) → start level (1-based, default 1), clamp [1,TOTAL]
//   to    (?to=20)               → end/cap level (default TOTAL=100),  clamp [1,TOTAL]
//   loop  (?loop=20)             → repeat-signal period (optional)
//   dev   (?dev=1)               → dev mode on (default off; the existing Q-key / 3-tap
//                                  dev selector is unchanged — this just force-shows it)
// All of RT is inert on the default path (from=1, to=100, no loop, dev=off).
// ─────────────────────────────────────────────────────────────────────────────
export const RT = (function () {
  const TOTAL = TOTAL_STAGES;
  let q = null;
  try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
  const get = (k) => { try { return q ? q.get(k) : null; } catch (e) { return null; } };
  const intOf = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
  const clamp = (n) => Math.max(1, Math.min(TOTAL, n | 0));

  let from = clamp(intOf(get('from') != null ? get('from') : get('level'), 1));
  let to = clamp(intOf(get('to'), TOTAL));
  if (from > to) to = from;                                    // if from>to → single level (run only `from`)

  const loopRaw = intOf(get('loop'), 0);
  const loop = (loopRaw > 0) ? loopRaw : 0;                    // 0 = disabled

  // dev mode: ?dev=1 (or any truthy non-"0"/"false"). Also honor window.__GAMEREELS_DEV.
  let dev = false;
  try {
    const dv = get('dev');
    dev = (dv != null && dv !== '0' && dv !== 'false') || !!window.__GAMEREELS_DEV;
  } catch (e) { dev = false; }

  const isLevelLimited = (from > 1) || (to < TOTAL);

  // shouldEmitGameEnd(level) — POLICY (priority order):
  //   (a) limited run (to < TOTAL): emit ONLY when the cleared level === to (run end)
  //   (b) else loop set: emit every `loop` levels (level % loop === 0)
  //   (c) DEFAULT (full run, no loop): emit every 30 levels (user req) — 30/60/90...
  function shouldEmitGameEnd(level) {
    const lv = level | 0;
    if (to < TOTAL) return lv === to;
    if (loop > 0) return lv > 0 && (lv % loop === 0);
    return lv > 0 && (lv % 30 === 0);
  }

  return {
    TOTAL: TOTAL, from: from, to: to, loop: loop, dev: dev,
    isLevelLimited: isLevelLimited, shouldEmitGameEnd: shouldEmitGameEnd,
  };
})();
