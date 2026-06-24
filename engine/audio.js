// engine/audio.js — WEB AUDIO MANAGER (GLOBAL L22).
//
// A single shared AudioContext drives all sound. Each MP3 is fetched + decoded
// ONCE at startup into an AudioBuffer (decode is async + off the critical path —
// it never blocks first paint, and a failed decode is caught, not thrown, so a
// missing/corrupt clip just makes that one sound silent). SFX play through the
// shared context with a small POOL + THROTTLE so the same clip can't stack many
// times per frame (min-interval per clip + a cap on concurrent voices) — this is
// the L13 "SFX = pool + throttle, allocations ~0 in the hot path" rule. BGM is a
// single looping source at a LOWER gain than SFX.
//
// Browser autoplay policy: no sound before a user gesture. On the FIRST
// pointerdown/touchstart we resume() the context and start the BGM (iOS Safari
// can't play before a gesture). A master MUTE toggle is persisted in localStorage
// and respected by both SFX and BGM (mute ducks the master gain to 0 + pauses BGM
// start; unmute restores it and starts BGM if we're already unlocked).
//
// MP3 ONLY (iOS Safari plays MP3; do NOT use .ogg). Paths are RELATIVE so this is
// static-servable (GitHub Pages) and Capacitor-friendly (GLOBAL A3 / L22).
//
// 3-layer split (GLOBAL A6): this is a pure SOUND layer. It owns no game rules —
// index.html wires game/FX events to play() calls, mirroring the FX director.

const AUDIO_DIR = 'assets/audio/';
const MUTE_KEY = 'bb_muted';     // single localStorage key (shared origin → lobby+game)

// clip name → file. SFX are short; bgm loops. (No .ogg — iOS Safari = MP3, L22.)
const CLIPS = {
  place:      'sfx_place.mp3',
  clear:      'sfx_clear.mp3',
  combo:      'sfx_combo.mp3',
  gem:        'sfx_gem.mp3',
  praise:     'sfx_praise.mp3',
  stageclear: 'sfx_stageclear.mp3',
  button:     'sfx_button.mp3',
  bgm:        'bgm_loop.mp3',
};

// per-clip throttle: a clip won't retrigger within this many ms (anti-stacking on
// rapid events — e.g. a multi-line clear that fires several gem dings). Tuned so
// rapid arrivals still read as a cascade but never a buzzsaw of overlaps.
const THROTTLE_MS = {
  place: 40, clear: 70, combo: 90, gem: 55, praise: 120, stageclear: 200, button: 50,
};
const DEFAULT_THROTTLE_MS = 60;
const MAX_CONCURRENT = 6;        // hard cap on simultaneously-playing SFX voices

// relative SFX/BGM gains (SFX LOUDER than BGM, per task spec).
const SFX_GAIN = 0.85;
const BGM_GAIN = 0.32;
const HTML_POOL = 4;             // pre-primed <audio> per SFX (round-robin → low-latency replay, ㉝)
// ㉞/㊳: only these SFX play (user req). BGM is separate (always on, not gated here). The rest
// ('clear','gem','button') stay OFF. Edit this set to toggle clips on/off.
const ENABLED_SFX = new Set(['stageclear', 'combo', 'place', 'praise', 'clear']);

export class AudioManager {
  constructor() {
    this.ctx = null;             // created lazily on first gesture (avoids a suspended ctx warning)
    this.buffers = Object.create(null);  // name -> AudioBuffer (absent until decoded / on failure)
    this.master = null;          // master GainNode (mute = gain 0)
    this.sfxGain = null;
    this.bgmGain = null;
    this.bgmSource = null;       // the looping BGM source (null when stopped)
    this.unlocked = false;       // true after the first gesture resumed the context
    this._lastPlay = Object.create(null);  // name -> last play timestamp (throttle)
    this._activeVoices = 0;      // currently-playing SFX count (concurrency cap)
    this._decoded = false;       // all decode attempts settled (for QA hook)
    this._decodePromise = null;
    this.muted = this._readMuted();
    // HTMLAudio primary playback (㉙) — a POOL of pre-primed <audio> per SFX (㉝: round-robin so a
    // fresh, ready element plays each trigger → low latency, no seek-on-busy-element delay).
    this._htmlPool = Object.create(null);   // name -> [<audio> ...] (HTML_POOL each)
    this._htmlPoolIdx = Object.create(null);// name -> round-robin index
    this._htmlBgm = null;                   // looping <audio> BGM (fallback only; null on normal path)
    this._htmlPrimed = false;               // one-time guard: prime the <audio> fallback pool ONCE
    // test/telemetry hook (read by QA): counts play() calls per clip even before
    // unlock, so a test can assert "an event fired the audio call" without sound.
    this.playCounts = Object.create(null);
  }

  _readMuted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { return false; }
  }
  _writeMuted(v) {
    try { localStorage.setItem(MUTE_KEY, v ? '1' : '0'); } catch (_) { /* private mode → ignore */ }
  }

  // Kick off async fetch+decode of every clip. Safe to call before any gesture:
  // we create a throwaway OfflineAudioContext-free decode via a temporary
  // AudioContext only when needed. To keep decode OFF the critical path we DO NOT
  // construct the live AudioContext here (that can print a "was not allowed to
  // start" warning on some browsers); instead we fetch the bytes now and decode
  // lazily into the real context the moment it's created on first gesture. If the
  // context already exists (unlocked), we decode straight away.
  preload() {
    if (this._decodePromise) return this._decodePromise;
    // fetch all bytes in parallel; decode happens in _decodeAll once we have a ctx.
    const names = Object.keys(CLIPS);
    this._rawBytes = Object.create(null);
    const fetches = names.map((name) =>
      fetch(AUDIO_DIR + CLIPS[name])
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((buf) => { this._rawBytes[name] = buf; })
        .catch((e) => { /* tolerate: that clip stays silent */ console.warn('[audio] fetch failed', name, e.message); })
    );
    this._decodePromise = Promise.all(fetches).then(() => {
      // if a context already exists (rare — gesture before preload settled), decode now.
      if (this.ctx) return this._decodeAll();
    });
    return this._decodePromise;
  }

  // decode all fetched bytes into AudioBuffers using the live context. Each decode
  // is independent + caught, so one corrupt clip never blocks the others (L22).
  async _decodeAll() {
    if (!this.ctx || !this._rawBytes) { this._decoded = true; return; }
    const names = Object.keys(this._rawBytes);
    await Promise.all(names.map((name) => {
      const bytes = this._rawBytes[name];
      if (!bytes || this.buffers[name]) return Promise.resolve();
      // decodeAudioData needs its own copy (it detaches the ArrayBuffer); slice keeps
      // _rawBytes reusable if we ever re-decode after a context recreate.
      return this.ctx.decodeAudioData(bytes.slice(0)).then(
        (audioBuf) => { this.buffers[name] = audioBuf; },
        (e) => { console.warn('[audio] decode failed', name, e && e.message); }
      );
    }));
    this._decoded = true;
  }

  // Wire user gestures → unlock audio. Listens for pointerdown/touchstart AND the STRONGER
  // activations click/touchend/keydown (㉜): iOS only honors <audio>.play() from a click/touchend,
  // NOT necessarily a touchstart/pointerdown.
  //
  // ⚠️ LIFECYCLE FIX (USER REPORT 2026-06-22 — "사운드 재생되면 프레임드랍이 생기고 지속된다"):
  // the OLD detach gate was `this._htmlBgm && !this._htmlBgm.paused`. On real iOS Safari that flag
  // does NOT flip synchronously inside the handler (play() is async; with the mute switch on or a
  // weak gesture it can stay `paused===true` indefinitely), so the handler NEVER detached. Every
  // tap (= 4 events: pointerdown+touchstart+touchend+click) then re-ran unlock → _primeHtmlAudio
  // (play()→pause() media-element thrash over the whole <audio> pool) → _startBgm. Measured: 1+10
  // taps drove _primeHtmlAudio 44× and _startBgm 89× → persistent, audio-correlated main-thread
  // jank that begins the moment audio engages. Now we detach on the RELIABLE signal — the
  // AudioContext actually RUNNING — and do the one-time prime exactly once. After that, gestures
  // do ZERO audio work (at most a cheap ctx.resume() if the OS suspended it). Capture phase so it
  // runs before the game's own handlers.
  // EAGER full audio init, OFF any gesture (USER 2026-06-24: "웹뷰로 실행할거라 iOS 정책은 무시해도돼"
  // — the app's webview allows autoplay, so the iOS user-gesture requirement is moot). Doing the
  // ~140ms init (new AudioContext + decodeAudioData + HTMLAudio prime + BGM) HERE — at boot, during
  // the interaction gate — keeps it ENTIRELY off the drag path: NO pointerdown AND NO pointerup
  // hitch (the prior gesture-END split still cost a one-time release hitch). The host calls this
  // during the boot gate (index.html). Idempotent. On a plain browser (no autoplay) the ctx is
  // created suspended + decoded now; the gesture handler's cheap resume() finalizes it later.
  unlockEager() {
    this._unlockWebAudio();          // create ctx + gains + kick async decode + try resume
    if (this._heavyUnlockDone) return;
    this._heavyUnlockDone = true;
    try { this._iosSilentSwitchFix(); this._primeHtmlAudio(); if (!this.muted) this._startBgm(); } catch (_) {}
  }

  installUnlockHandler(target = document) {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;
    // Audio is initialized EAGERLY at boot (unlockEager), off any gesture, so a GRAB never does audio
    // work → no main-thread hitch during the drag → no stuck block (USER REPORT 2026-06-23/24). This
    // handler is now a CHEAP safety net only: if autoplay was blocked at boot (plain browser) the
    // first gesture finalizes the unlock; if iOS later SUSPENDED the ctx, resume it. NO per-gesture
    // heavy work (that was the old jank). Listens on all gestures since it's cheap either way.
    const onGesture = () => {
      if (!this.unlocked) { this.unlockEager(); return; }         // browser fallback: finalize on 1st gesture
      if (this.ctx && this.ctx.state !== 'running') { try { this.ctx.resume(); } catch (_) {} }  // suspend recovery
    };
    for (const t of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'click', 'keydown']) target.addEventListener(t, onGesture, true);
  }

  // CHEAP Web Audio unlock (NO <audio> elements): create ctx + gains, kick async decode, resume.
  // Safe to call repeatedly; only the first does real work. The HEAVY media work (silent-switch /
  // HTMLAudio prime / HTMLAudio BGM fallback) is split out to a gesture END (installUnlockHandler)
  // so it never hitches the grab that unlocks audio (USER REPORT 2026-06-23 first-grab stuck).
  async _unlockWebAudio() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // no Web Audio → silent (graceful)
      try { this.ctx = new AC(); } catch (_) { return; }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = SFX_GAIN; this.sfxGain.connect(this.master);
      this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = BGM_GAIN; this.bgmGain.connect(this.master);
      // decode whatever bytes have arrived (fetch may still be in flight → decode
      // again when preload resolves, guarded by buffers[name] so it's idempotent).
      this._decodeAll();
      if (this._decodePromise) this._decodePromise.then(() => this._decodeAll().then(() => {
        // BGM clip may have arrived AFTER unlock. If the HTMLAudio fallback started first (decode
        // lost the race to the first gesture), upgrade to the Web Audio loop now and tear down the
        // <audio> element so we don't leave a continuously-looping media element running.
        if (this.unlocked && !this.muted) this._upgradeBgmToWebAudio();
      }));
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) { /* ignore */ } }
    this.unlocked = true;
  }

  // iOS SILENT-SWITCH workaround (㉖): by default iOS routes WebAudio through the "ringer"
  // channel, so a phone with the physical mute switch ON plays NO sound from a web game. Playing
  // a looping SILENT <audio> element (media channel) inside the unlock gesture switches the page's
  // audio session to "playback", which IGNORES the mute switch — so the game's SFX/BGM are then
  // audible regardless of the switch. Harmless if it doesn't apply (desktop/Android). Once only.
  _iosSilentSwitchFix() {
    if (this._silentEl) return;
    try {
      // build a tiny VALID silent WAV in-code (no external asset, correct by construction).
      const rate = 8000, ms = 400, n = Math.floor(rate * ms / 1000), buf = new ArrayBuffer(44 + n);
      const v = new DataView(buf), W = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      W(0, 'RIFF'); v.setUint32(4, 36 + n, true); W(8, 'WAVE'); W(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      W(36, 'data'); v.setUint32(40, n, true);
      for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);     // 8-bit PCM silence
      let bin = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      const el = new Audio('data:audio/wav;base64,' + btoa(bin));
      el.loop = true; el.volume = 0; el.setAttribute('playsinline', ''); el.muted = false;
      const p = el.play(); if (p && p.catch) p.catch(() => {});  // gesture-initiated → allowed
      this._silentEl = el;
    } catch (_) { /* no-op: best-effort */ }
  }

  // Play a short SFX with per-clip throttle + a concurrency cap (no per-call alloc
  // beyond the unavoidable BufferSource, which the browser GCs after onended). If
  // we're muted / not unlocked / the buffer didn't decode, this is a cheap no-op
  // (but still bumps playCounts so QA can assert the event fired).
  play(name) {
    this.playCounts[name] = (this.playCounts[name] || 0) + 1;
    // ㉞: user req — keep ONLY the result-screen sound; the per-action SFX (block-break/text/etc.)
    // carried a harsh "지이잉" tone, so they're disabled (BGM stays). Reversible: add names to
    // ENABLED_SFX (or regenerate the offending clip cleanly).
    if (!ENABLED_SFX.has(name)) return false;
    if (this.muted || !this.unlocked) return false;
    // shared throttle across BOTH playback paths (ms).
    const now = (this.ctx && this.ctx.currentTime ? this.ctx.currentTime * 1000 : this._perfNow());
    const last = this._lastPlay[name] || -1e9;
    const minGap = THROTTLE_MS[name] != null ? THROTTLE_MS[name] : DEFAULT_THROTTLE_MS;
    if (now - last < minGap) return false;          // throttle: same clip too soon
    this._lastPlay[name] = now;
    // PRIMARY (USER REQ 2026-06-22 — sound was "밀려서 재생"/laggy on iPhone): WEB AUDIO low-latency
    // path. createBufferSource + start(0) plays INSTANTLY off a pre-decoded buffer — NO media-element
    // seek/pipeline latency and NO main-thread hitch (the cause of the delay was the <audio> path's
    // currentTime=0 seek + play() pipeline). Used whenever the ctx is unlocked (running) + decoded.
    // If iOS SUSPENDED the ctx, kick a resume so it recovers for the NEXT play (this one falls to the
    // HTMLAudio fallback below — delayed but not silent). With the resume-on-gesture this keeps place
    // SFX instant + reliable (USER REQ 2026-06-22: place sound a beat late / frequently silent).
    if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (_) {} }
    if (this.ctx && this.ctx.state === 'running' && this.buffers[name]) {
      if (this._activeVoices < MAX_CONCURRENT) {
        let src = null;
        try { src = this.ctx.createBufferSource(); } catch (_) { src = null; }
        if (src) {
          src.buffer = this.buffers[name];
          src.connect(this.sfxGain);
          this._activeVoices++;
          src.onended = () => { this._activeVoices = Math.max(0, this._activeVoices - 1); try { src.disconnect(); } catch (_) {} };
          try { src.start(0); return true; } catch (_) { this._activeVoices = Math.max(0, this._activeVoices - 1); }
        }
      }
    }
    // FALLBACK: HTMLAudio (gesture-PRIMED pool) — only when WebAudio isn't running/decoded yet (e.g.
    // before the first decode completes, or a restrictive in-app webview where WebAudio stays silent).
    // Higher latency, but keeps sound working where WebAudio can't (no silence regression).
    if (this._htmlPlay(name)) return true;
    return false;
  }

  _perfNow() { try { return performance.now(); } catch (_) { return Date.now(); } }

  // Play from the gesture-PRIMED pool (㉙/㉝): round-robin to a ready element so playback is
  // instant (no seek-on-a-still-playing element). Primed elements → iOS allows this programmatic
  // play. Returns false if not primed (caller falls back to WebAudio).
  _htmlPlay(name) {
    if (this.muted) return false;
    const pool = this._htmlPool[name];
    if (!pool || !pool.length) return false;
    const i = (this._htmlPoolIdx[name] = ((this._htmlPoolIdx[name] || 0) + 1) % pool.length);
    const el = pool[i];
    // UNMUTE for the real play (㊳: primed muted, since iOS ignores <audio>.volume — only `muted`
    // silences. volume still set for desktop, where it IS honored).
    try { el.muted = false; if (el.currentTime) el.currentTime = 0; el.volume = SFX_GAIN; const p = el.play(); if (p && p.catch) p.catch(() => {}); return true; }
    catch (_) { return false; }
  }

  // Create + gesture-PRIME the HTMLAudio elements (㉙). iOS only allows <audio>.play() that was
  // initiated/primed by a user gesture, so on the FIRST gesture we play each at volume 0 then
  // pause+reset — leaving them ready for instant silent-free replay on game events.
  //
  // ⚠️ ONCE ONLY (lifecycle fix 2026-06-22): the <audio> pool is now just the FALLBACK path (Web
  // Audio is primary). Priming it on EVERY gesture ran a play()→pause() media-element thrash over
  // ~20 elements per tap = the persistent jank the user reported. We prime exactly once, guarded by
  // _htmlPrimed, inside the FIRST unlock gesture (a valid user activation is on the stack there).
  _primeHtmlAudio() {
    if (this._htmlPrimed) return;   // one-time only (㉙ fallback prime; Web Audio is primary)
    this._htmlPrimed = true;
    try {
      for (const name of Object.keys(CLIPS)) {
        // BGM is now a Web Audio looping source (decoded buffer → AudioBufferSourceNode), so there
        // is NO continuously-looping <audio> element to keep iOS in an active-media/repaint state
        // (suspect #2). _startBgm only creates an <audio> BGM as a last-resort fallback if the
        // buffer never decodes. So we do NOT pre-create _htmlBgm here.
        if (name === 'bgm') continue;
        // ㊱: only prime clips that can actually PLAY (ENABLED_SFX). Priming the disabled SFX too
        // made the unlock gesture play→pause ALL clips → a burst of "every sound at once" on the
        // first tap. Skipping them leaves only the stage-clear clip primed (silently, vol 0).
        if (!ENABLED_SFX.has(name)) continue;
        let pool = this._htmlPool[name];
        if (!pool) {
          pool = [];
          for (let k = 0; k < HTML_POOL; k++) { const el = new Audio(AUDIO_DIR + CLIPS[name]); el.preload = 'auto'; el.setAttribute('playsinline', ''); el.muted = true; el.volume = 0; pool.push(el); }
          this._htmlPool[name] = pool;
        }
        // (RE)PRIME on EACH gesture (㉜): a vol-0 play→pause marks each element user-activated. Re-
        // attempting each gesture means a later click/touchend succeeds even if an earlier
        // touchstart was ignored by iOS. `paused` guard skips one that's mid-prime.
        for (const el of pool) {
          if (el.paused) { try { const p = el.play(); if (p && p.then) p.then(() => { try { el.pause(); el.currentTime = 0; } catch (_) {} }).catch(() => {}); } catch (_) {} }
        }
      }
    } catch (_) { /* best-effort */ }
  }

  _htmlStartBgm() {
    if (this.muted) return;
    try {
      if (!this._htmlBgm) {
        this._htmlBgm = new Audio(AUDIO_DIR + CLIPS.bgm);
        this._htmlBgm.loop = true; this._htmlBgm.volume = BGM_GAIN; this._htmlBgm.setAttribute('playsinline', '');
      }
      const p = this._htmlBgm.play(); if (p && p.catch) p.catch(() => {});
    } catch (_) { /* no-op */ }
  }
  _htmlStopBgm() { try { if (this._htmlBgm) this._htmlBgm.pause(); } catch (_) {} }

  // Start (or restart) the looping BGM at the lower BGM gain. No-op if muted, not
  // unlocked, the buffer isn't decoded, or it's already playing.
  //
  // PRIMARY is now WEB AUDIO (lifecycle fix 2026-06-22): a decoded buffer looped through a single
  // AudioBufferSourceNode → bgmGain. No continuously-looping <audio> element (which can hold iOS in
  // an active-media/repaint state). Idempotent — once bgmSource exists this is a no-op, so it does
  // NOT thrash if called again. HTMLAudio BGM is only a last-resort fallback when the buffer hasn't
  // decoded (e.g. a restrictive webview where Web Audio stays silent).
  _startBgm() {
    if (this.muted || !this.unlocked) return;
    // PRIMARY: Web Audio looping source (no media element). Created at most once.
    if (this.ctx && this.ctx.state === 'running' && this.buffers.bgm) {
      if (this.bgmSource || this._htmlBgm) return;  // already looping (web) or on html fallback
      let src;
      try { src = this.ctx.createBufferSource(); } catch (_) { return; }
      src.buffer = this.buffers.bgm;
      src.loop = true;
      src.connect(this.bgmGain);
      try { src.start(0); } catch (_) { return; }
      this.bgmSource = src;
      return;
    }
    // FALLBACK: HTMLAudio BGM — only if Web Audio isn't running/decoded (keeps BGM working where
    // Web Audio is silent). Lazily created here, NOT pre-primed, so the normal path has no <audio>.
    if (!this.bgmSource) { this._htmlStartBgm(); }
  }

  // If the HTMLAudio BGM fallback started first (the decode lost the race to the first gesture),
  // switch to the Web Audio looping source once the buffer is ready and tear down the <audio>
  // element — so the steady state never keeps a continuously-looping media element alive.
  _upgradeBgmToWebAudio() {
    if (this.bgmSource) return;                       // already on Web Audio
    if (!(this.ctx && this.ctx.state === 'running' && this.buffers.bgm)) { this._startBgm(); return; }
    // start the Web Audio loop first (gapless-ish), then stop + release the <audio> element.
    let src;
    try { src = this.ctx.createBufferSource(); } catch (_) { this._startBgm(); return; }
    src.buffer = this.buffers.bgm; src.loop = true; src.connect(this.bgmGain);
    try { src.start(0); } catch (_) { return; }
    this.bgmSource = src;
    if (this._htmlBgm) { try { this._htmlBgm.pause(); this._htmlBgm.src = ''; } catch (_) {} this._htmlBgm = null; }
  }

  _stopBgm() {
    if (this.bgmSource) {
      try { this.bgmSource.stop(0); } catch (_) {}
      try { this.bgmSource.disconnect(); } catch (_) {}
      this.bgmSource = null;
    }
    this._htmlStopBgm();
  }

  // Master mute toggle (persisted). Mute → master gain 0 + stop BGM (so it doesn't
  // keep running silently). Unmute → restore gain + (re)start BGM if unlocked.
  setMuted(v) {
    this.muted = !!v;
    this._writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    if (this.muted) this._stopBgm();
    else if (this.unlocked) this._startBgm();
    return this.muted;
  }
  toggleMute() { return this.setMuted(!this.muted); }
  isMuted() { return this.muted; }

  // ── GAMEREELS host pause/resume (additive; only called by the host bridge when
  // the webview host sends GamePause/GameResume). On the default/solo path these are
  // never invoked, so audio behavior is unchanged. pause() suspends the AudioContext
  // (silences BGM + any in-flight SFX without losing the BGM source); resume() restores
  // it. Both are guarded no-ops if the ctx isn't running yet. ──
  pause() {
    this._grPaused = true;
    try { if (this.ctx && this.ctx.state === 'running' && this.ctx.suspend) this.ctx.suspend(); } catch (_) {}
    try { if (this._htmlBgm && !this._htmlBgm.paused) this._htmlBgm.pause(); } catch (_) {}
  }
  resume() {
    if (!this._grPaused) return; this._grPaused = false;
    try { if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume(); } catch (_) {}
    try { if (this._htmlBgm && this.unlocked && !this.muted) this._htmlBgm.play().catch(() => {}); } catch (_) {}
  }
}

// Singleton on window so it survives level loads + is shared with any lobby/iframe
// on the same origin (L22). preload() is fired immediately so decode runs off the
// critical path; the context itself isn't created until the first gesture (unlock).
export function getAudio() {
  if (!window.__audio) {
    const am = new AudioManager();
    window.__audio = am;
    am.preload();                 // async fetch+decode; never blocks first paint
    am.installUnlockHandler();    // first pointerdown/touchstart resumes ctx + starts BGM
  }
  return window.__audio;
}
