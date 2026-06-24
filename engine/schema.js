// engine/schema.js — LEVEL / MISSION VALIDATION (SSOT, GAME_DESIGN §5).
// validateLevel(json) → { ok, errors:[], level } where `level` is a normalized copy.
// Pure data validation; no engine state. The editor and the loader both call this
// so a malformed level fails LOUD instead of half-loading.

export const SCHEMA_VERSION = 1;

const MISSION_TYPES = ['collect', 'score', 'lines', 'clearCells', 'survive', 'tutorial', 'combo'];
const TUTORIAL_GATES = ['place', 'lineClear', 'auto'];

// ── preset cell reader (SSOT — GAME_DESIGN §11.2) ────────────────────────────
// A preset cell is EITHER the legacy positional array `[x,y,colorKey]` OR an
// object `{ x, y, color, gem? }`. The object form lets a filled block EMBED a
// gem (gem-in-block): the cell is colored AND carries a collectible gem that is
// collected when the block's row/col clears. Both schema validation and game
// init read cells through THIS one helper so the two never drift (L15).
// Returns { x, y, color, gem|null } or null if the shape is unrecognized.
export function readPresetCell(c) {
  if (Array.isArray(c)) {
    if (c.length !== 3) return null;
    return { x: c[0], y: c[1], color: c[2], gem: null };
  }
  if (c && typeof c === 'object') {
    return { x: c.x, y: c.y, color: c.color, gem: (c.gem != null ? c.gem : null) };
  }
  return null;
}

// Normalize a collect mission target into a list of { gem, count } (SSOT — used by
// schema validation AND game init so single/array forms behave identically). The
// gem id may be given as `item` (legacy) or `gem`. Returns [] for unrecognized.
export function collectTargets(target) {
  const one = (e) => {
    if (!e || typeof e !== 'object') return null;
    const gem = (typeof e.gem === 'string' && e.gem) ? e.gem : (typeof e.item === 'string' && e.item) ? e.item : null;
    if (gem == null) return null;
    return { gem, count: e.count };
  };
  if (Array.isArray(target)) return target.map(one).filter(Boolean);
  const single = one(target);
  return single ? [single] : [];
}

// Normalize a `combo` mission (GAME_DESIGN §12.2) into a flat list of sub-goals so
// schema validation AND game init read it the SAME way (SSOT). A combo mission's
// `goals` is an ARRAY where each entry is EITHER a score goal `{ score:N }` OR a
// collect goal `{ collect:[{gem,count},…] }` (collect may also be a single object).
// Returns { ok, score: <N|null>, collect: [{gem,count}…] } — `ok` is false when the
// goals array is missing/empty or no recognizable sub-goal is found. The mission is
// cleared only when ALL of these are met (see game.js _checkMissionClear).
export function comboGoals(mission) {
  const out = { ok: false, score: null, collect: [] };
  const goals = mission && Array.isArray(mission.goals) ? mission.goals : null;
  if (!goals || goals.length === 0) return out;
  for (const g of goals) {
    if (!g || typeof g !== 'object') continue;
    if (Number.isInteger(g.score)) { out.score = g.score; continue; }
    if ('collect' in g) {
      const list = collectTargets(g.collect);
      for (const e of list) out.collect.push(e);
    }
  }
  out.ok = (out.score != null) || (out.collect.length > 0);
  return out;
}

export function validateLevel(json) {
  const errors = [];
  const E = (m) => errors.push(m);

  if (json == null || typeof json !== 'object') {
    return { ok: false, errors: ['level is not an object'], level: null };
  }

  // schemaVersion
  if (json.schemaVersion !== SCHEMA_VERSION) {
    E(`schemaVersion must be ${SCHEMA_VERSION} (got ${json.schemaVersion})`);
  }

  // id / index
  if (typeof json.id !== 'string' || !json.id) E('id must be a non-empty string');
  if (!Number.isInteger(json.index) || json.index < 0) E('index must be a non-negative integer');

  // board
  const board = json.board || {};
  const cols = board.cols, rows = board.rows;
  if (!Number.isInteger(cols) || cols < 4 || cols > 16) E('board.cols must be an integer in [4,16]');
  if (!Number.isInteger(rows) || rows < 4 || rows > 16) E('board.rows must be an integer in [4,16]');

  // palette
  const palette = json.palette || {};
  const paletteKeys = Object.keys(palette);
  if (paletteKeys.length === 0) E('palette must have at least one color key');
  for (const k of paletteKeys) {
    if (!/^#[0-9a-fA-F]{6}$/.test(palette[k])) E(`palette["${k}"] must be a #RRGGBB hex color`);
  }

  const inBounds = (x, y) =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < cols && y < rows;

  // preset: [ [x,y,colorKey] | {x,y,color,gem?}, ... ]  (read via readPresetCell — SSOT)
  // Collect the gem ids embedded in preset blocks so a collect mission can be
  // validated against them (gem-in-block, GAME_DESIGN §11.3).
  const presetGemCounts = Object.create(null);
  if (json.preset != null) {
    if (!Array.isArray(json.preset)) E('preset must be an array');
    else json.preset.forEach((raw, i) => {
      const c = readPresetCell(raw);
      if (!c) { E(`preset[${i}] must be [x,y,colorKey] or {x,y,color,gem?}`); return; }
      if (!inBounds(c.x, c.y)) E(`preset[${i}] out of board bounds`);
      if (!(c.color in palette)) E(`preset[${i}] color "${c.color}" not in palette`);
      if (c.gem != null) {
        if (typeof c.gem !== 'string' || !c.gem) E(`preset[${i}].gem must be a non-empty gem id string`);
        else presetGemCounts[c.gem] = (presetGemCounts[c.gem] || 0) + 1;
      }
    });
  }

  // items: [ [x,y,itemId], ... ]
  if (json.items != null) {
    if (!Array.isArray(json.items)) E('items must be an array');
    else json.items.forEach((c, i) => {
      if (!Array.isArray(c) || c.length !== 3) { E(`items[${i}] must be [x,y,itemId]`); return; }
      const [x, y, id] = c;
      if (!inBounds(x, y)) E(`items[${i}] out of board bounds`);
      if (typeof id !== 'string' || !id) E(`items[${i}] itemId must be a non-empty string`);
    });
  }

  // mission
  const mission = json.mission || {};
  // available gem supply = floating items[] + gems embedded in preset blocks.
  const itemGemCounts = Object.create(null);
  if (Array.isArray(json.items)) for (const c of json.items) if (Array.isArray(c) && c[2]) itemGemCounts[c[2]] = (itemGemCounts[c[2]] || 0) + 1;
  const gemSupply = (gem) => (presetGemCounts[gem] || 0) + (itemGemCounts[gem] || 0);
  if (!MISSION_TYPES.includes(mission.type)) {
    E(`mission.type must be one of ${MISSION_TYPES.join('|')} (got "${mission.type}")`);
  } else {
    const t = mission.target || {};
    switch (mission.type) {
      case 'collect': {
        // target is EITHER a single { item|gem, count } OR an ARRAY of them (multi-gem,
        // GAME_DESIGN §11.2). Normalize to a list for validation; game.js does the same.
        const list = collectTargets(t);
        if (list.length === 0) {
          E('collect mission.target must be { item|gem, count } or an array of them');
        }
        for (let k = 0; k < list.length; k++) {
          const e = list[k];
          if (typeof e.gem !== 'string' || !e.gem) E(`collect target[${k}].item/gem required`);
          if (!Number.isInteger(e.count) || e.count <= 0) E(`collect target[${k}].count must be a positive integer`);
          // NOTE: gems are delivered by the feeder via the QUEUE now (gem-in-queue), not
          // preset on the board — so a preset gem-supply requirement no longer applies; the
          // solver (verify_lib) is the completability gate.
        }
        break;
      }
      case 'score':
        // accept target.score (preferred, §11) OR legacy target.count.
        if (!Number.isInteger(t.score ?? t.count) || (t.score ?? t.count) <= 0) {
          E('score mission.target.score must be a positive integer');
        }
        break;
      case 'lines':
      case 'clearCells':
        if (!Number.isInteger(t.count) || t.count <= 0) E(`mission.target.count must be a positive integer for ${mission.type}`);
        break;
      case 'survive':
        if (!Number.isInteger(t.moves) && !Number.isInteger(mission.moves)) {
          E('survive mission requires target.moves or mission.moves');
        }
        break;
      case 'tutorial':
        // tutorial victory = completing the last tutorial step; no numeric target.
        if (json.tutorial == null || json.tutorial.enabled !== true) {
          E('mission.type "tutorial" requires a tutorial block with enabled:true');
        }
        break;
      case 'combo': {
        // composite mission (GAME_DESIGN §12.2): score AND gem goals together, cleared
        // ONLY when ALL goals are met. `goals` is an array of {score:N} | {collect:[…]}.
        const cg = comboGoals(mission);
        if (!cg.ok) {
          E('combo mission.goals must be a non-empty array of { score:N } and/or { collect:[{gem,count}…] }');
        } else {
          if (cg.score != null && (!Number.isInteger(cg.score) || cg.score <= 0)) {
            E('combo goal score must be a positive integer');
          }
          for (let k = 0; k < cg.collect.length; k++) {
            const e = cg.collect[k];
            if (typeof e.gem !== 'string' || !e.gem) E(`combo collect goal[${k}].gem required`);
            if (!Number.isInteger(e.count) || e.count <= 0) E(`combo collect goal[${k}].count must be a positive integer`);
            // gem-in-queue: gems come from the feeder, not preset — no preset-supply check.
          }
        }
        break;
      }
    }
  }
  if (mission.moves != null && (!Number.isInteger(mission.moves) || mission.moves < 0)) {
    E('mission.moves must be a non-negative integer (0 = unlimited)');
  }

  // feeder override (optional) — only shallow type check; deep-merged at load
  if (json.feeder != null && (typeof json.feeder !== 'object' || Array.isArray(json.feeder))) {
    E('feeder override must be an object');
  }

  // tutorial block (optional) — drives the onboarding controller (GAME_DESIGN §10.3).
  // When enabled, fixedQueue replaces the adaptive feeder and steps[] gate input.
  if (json.tutorial != null) {
    const tut = json.tutorial;
    if (typeof tut !== 'object' || Array.isArray(tut)) {
      E('tutorial must be an object');
    } else {
      if (typeof tut.enabled !== 'boolean') E('tutorial.enabled must be a boolean');
      if (!Array.isArray(tut.fixedQueue) || tut.fixedQueue.length === 0) {
        E('tutorial.fixedQueue must be a non-empty array of piece ids');
      } else {
        tut.fixedQueue.forEach((id, i) => {
          if (typeof id !== 'string' || !id) E(`tutorial.fixedQueue[${i}] must be a piece id string`);
        });
      }
      if (!Array.isArray(tut.steps) || tut.steps.length === 0) {
        E('tutorial.steps must be a non-empty array');
      } else {
        tut.steps.forEach((s, i) => {
          if (s == null || typeof s !== 'object') { E(`tutorial.steps[${i}] must be an object`); return; }
          if (typeof s.text !== 'string') E(`tutorial.steps[${i}].text must be a string`);
          if (!TUTORIAL_GATES.includes(s.gate)) {
            E(`tutorial.steps[${i}].gate must be one of ${TUTORIAL_GATES.join('|')} (got "${s.gate}")`);
          }
          if (s.gate === 'auto') {
            if (!Number.isInteger(s.ms) || s.ms < 0) E(`tutorial.steps[${i}].ms must be a non-negative integer for an auto gate`);
          } else {
            // place / lineClear steps drive a drag → require pointTo + dropAt
            const pt = s.pointTo || {};
            if (pt.type !== 'tray' || !Number.isInteger(pt.index) || pt.index < 0) {
              E(`tutorial.steps[${i}].pointTo must be { type:"tray", index:>=0 }`);
            }
            const da = s.dropAt || {};
            if (!inBounds(da.x, da.y)) E(`tutorial.steps[${i}].dropAt must be a board cell { x, y }`);
          }
        });
      }
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, level: ok ? normalizeLevel(json) : null };
}

// Fill in optional fields with safe defaults so downstream code never branches on undefined.
function normalizeLevel(json) {
  const lvl = structuredClone(json);
  lvl.preset = lvl.preset || [];
  lvl.items = lvl.items || [];
  lvl.mission.moves = lvl.mission.moves ?? 0;
  lvl.mission.target = lvl.mission.target || {};
  lvl.tutorial = lvl.tutorial || null; // onboarding controller reads this (GAME_DESIGN §10.3)
  lvl.intro = lvl.intro || { title: lvl.id, hint: '' };
  return lvl;
}
