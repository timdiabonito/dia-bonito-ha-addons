// Built from dia-bonito-concierge island/ac-gateway. Do not edit here.

// island/ac-gateway/src/gateway.ts
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createServer as createHttps } from "node:https";

// supabase/functions/_shared/logic/cooler.ts
var ROOM_CLIMATE = {
  "cuarto-1": "climate.hacienda_poolside_1",
  "cuarto-2": "climate.hacienda_poolside_2",
  "cuarto-3": "climate.hacienda_jungleside_1",
  "cuarto-4": "climate.hacienda_jungleside_2",
  "cuarto-5": "climate.hacienda_bunk_room",
  "cuarto-6": "climate.hacienda_master_bedroom",
  "bungalow-cuarto-1": "climate.bungalow_water_bedroom",
  "bungalow-cuarto-2": "climate.bungalow_bedroom_jungle"
};
var COOLER_WINDOW_MS = 60 * 6e4;

// supabase/functions/_shared/logic/acPass.ts
var PASS_MAX_SECONDS = 72 * 3600;
var enc = new TextEncoder();
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(text) {
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
async function key(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
var HEADER = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "ACP" })));
async function signPass(claims, secret) {
  const body = `${HEADER}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}
async function verifyPass(token, secret, nowMs) {
  if (typeof token !== "string" || token.length > 4096 || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const sig = fromB64url(parts[2]);
  if (!sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret), sig, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const raw = fromB64url(parts[1]);
  if (!raw) return null;
  let c;
  try {
    c = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (c.v !== 1 || typeof c.stay_id !== "string" || typeof c.guest_id !== "string" || typeof c.arrives_on !== "string" || typeof c.departs_on !== "string" || typeof c.iat !== "number" || typeof c.exp !== "number" || !Array.isArray(c.rooms)) {
    return null;
  }
  if (nowMs >= c.exp * 1e3 || c.iat * 1e3 > nowMs + 5 * 6e4) return null;
  return c;
}

// supabase/functions/_shared/logic/acControl.ts
var LEVELS = ["cool", "cold", "coldest"];
var LEVEL_SETPOINT_C = { cool: 26, cold: 25, coldest: 24 };
var FLOOR_SETPOINT_C = 23;
var FANS = ["low", "medium", "high", "auto"];
var TURBO_COOLDOWN_MS = 60 * 6e4;
var LIVING_ROOM_SLUG = "living-room";
var SHARED_ROOMS = [LIVING_ROOM_SLUG];
var AC_CLIMATE = {
  ...ROOM_CLIMATE,
  [LIVING_ROOM_SLUG]: "climate.hacienda_living_room"
};
var EXTRA_ROOM_NAMES = {
  [LIVING_ROOM_SLUG]: { es: "Sala", en: "Living room" }
};
var AC_LIMIT = 20;
var AC_WINDOW_MS = 10 * 6e4;
var ALERT_WINDOW_MS = 60 * 6e4;
function checkCommand(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "empty" };
  const input = raw;
  const command = {};
  if ("on" in input) {
    if (typeof input.on !== "boolean") return { ok: false, reason: "bad_power" };
    command.on = input.on;
  }
  if ("level" in input) {
    if (!LEVELS.includes(input.level)) return { ok: false, reason: "bad_level" };
    command.level = input.level;
  }
  if ("fan" in input) {
    if (!FANS.includes(input.fan)) return { ok: false, reason: "bad_fan" };
    command.fan = input.fan;
  }
  if ("turbo" in input) {
    if (input.turbo !== true || Object.keys(input).length !== 1) return { ok: false, reason: "bad_turbo" };
    return { ok: true, command: { turbo: true } };
  }
  if (Object.keys(command).length === 0) return { ok: false, reason: "empty" };
  return { ok: true, command };
}
var FAN_RANK = { auto: 0, low: 1, medium: 2, high: 3 };
function fanForLevel(level, current) {
  const wanted = level === "coldest" ? "high" : level === "cold" ? "medium" : null;
  if (!wanted) return null;
  return FAN_RANK[current] < FAN_RANK[wanted] ? wanted : null;
}
function toHaOrder(entityId, command, currentFan) {
  if (command.turbo) return { entity_id: entityId, turbo: true };
  const lift = command.level !== void 0 && command.fan === void 0 ? fanForLevel(command.level, currentFan) : null;
  const setpoint = command.level !== void 0 ? Math.max(LEVEL_SETPOINT_C[command.level], FLOOR_SETPOINT_C) : void 0;
  return {
    entity_id: entityId,
    ...command.on !== void 0 ? { on: command.on } : {},
    ...command.on === true || command.level !== void 0 ? { mode: "cool" } : {},
    ...setpoint !== void 0 ? { setpoint_c: setpoint } : {},
    ...command.fan !== void 0 ? { fan: command.fan } : lift ? { fan: lift, lift: true } : {}
  };
}
function allowedRooms(args) {
  const known = args.allSlugs.filter((s) => AC_CLIMATE[s]);
  if (args.isLead) return known;
  return known.filter((s) => SHARED_ROOMS.includes(s) || s === args.claimSlug);
}
function unitFromHa(ha) {
  if (!ha || ha.state === "unavailable" || ha.state === "unknown") return null;
  const t = typeof ha.temperature === "number" ? ha.temperature : 26;
  const level = t <= 24.5 ? "coldest" : t <= 25.5 ? "cold" : "cool";
  const f = ha.fan_mode ?? "auto";
  const fan = f === "strong" ? "high" : f === "quiet" ? "low" : FANS.includes(f) ? f : "auto";
  const on = ha.state !== "off";
  const turbo = on && f === "strong";
  return { on, level, fan, ...turbo ? { turbo: true, turbo_until: ha.turbo_until ?? null } : {} };
}
var COPY = {
  sent: { es: "Enviado a la unidad.", en: "Sent to the unit." },
  pending: {
    es: "Recibimos tu pedido y nos encargamos en un ratito.",
    en: "We got your ask and we will get to it shortly."
  },
  throttled: {
    es: "Ya estamos en eso. Dale un ratito a la unidad.",
    en: "We are on it. Give the unit a little time."
  },
  turbo_wait: {
    es: "El turbo necesita descansar un rato. Prueba de nuevo en un rato.",
    en: "Turbo needs a rest. Try again in a little while."
  },
  refused: { es: "Ese cambio no es posible desde aqu\xED.", en: "That change is not possible from here." },
  no_room: {
    es: 'Primero escoge tu cuarto en "Qui\xE9n duerme d\xF3nde" y despu\xE9s usa el aire.',
    en: 'Pick your room in "Who sleeps where" first, then use the air conditioning.'
  },
  not_in_stay: {
    es: "Esto funciona durante tu estad\xEDa en la isla.",
    en: "This works while you are staying on the island."
  },
  not_your_room: {
    es: "Solo puedes cambiar el aire de tu propio cuarto y la sala.",
    en: "You can only change the air conditioning in your own room and the living room."
  },
  off_island: {
    es: "Con\xE9ctate al Wi-Fi de la isla para usar el control del aire.",
    en: "Join the island Wi-Fi to use the air conditioning remote."
  },
  unavailable: {
    es: "El control del aire no est\xE1 disponible en este momento.",
    en: "The air conditioning remote is not available right now."
  },
  staff_only: {
    es: "Solo los encargados y los due\xF1os pueden cambiar los aires.",
    en: "Only managers and owners can change the air conditioners."
  }
};
function answer(status) {
  return { status, message_es: COPY[status].es, message_en: COPY[status].en };
}
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readClientId(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
async function gate(caller, ports) {
  if (caller.app_role !== "guest" || !caller.stay_id || !caller.guest_id) {
    return { ok: false, outcome: { httpStatus: 403, body: answer("not_your_room") } };
  }
  const stay = await ports.findStay(caller.stay_id);
  const today = ports.today();
  if (!stay || stay.status === "cancelled" || today < stay.arrives_on || today > stay.departs_on) {
    return { ok: false, outcome: { httpStatus: 200, body: answer("not_in_stay") } };
  }
  const [claimSlug, lead, all] = await Promise.all([
    ports.findClaimSlug(caller.stay_id, caller.guest_id),
    ports.isLead(caller.guest_id),
    ports.listRooms()
  ]);
  const slugs = allowedRooms({ isLead: lead, claimSlug, allSlugs: all.map((r) => r.slug) });
  if (slugs.length === 0) return { ok: false, outcome: { httpStatus: 200, body: answer("no_room") } };
  return { ok: true, stayId: caller.stay_id, guestId: caller.guest_id, rooms: all.filter((r) => slugs.includes(r.slug)) };
}
async function handleAcState(caller, ports) {
  const g = await gate(caller, ports);
  if (!g.ok) return g.outcome;
  const rooms = await Promise.all(
    g.rooms.map(async (r) => ({
      slug: r.slug,
      name_es: r.name_es,
      name_en: r.name_en,
      unit: unitFromHa(await ports.readUnit(AC_CLIMATE[r.slug]).catch(() => null))
    }))
  );
  return { httpStatus: 200, body: { rooms } };
}
async function handleAcCommand(caller, body, ports) {
  const g = await gate(caller, ports);
  if (!g.ok) return g.outcome;
  const slug = typeof body.room === "string" ? body.room : "";
  if (!g.rooms.some((r) => r.slug === slug)) return { httpStatus: 403, body: answer("not_your_room") };
  const clientId = readClientId(body.client_id);
  if (clientId) {
    const earlier = await ports.findByClientId(clientId);
    if (earlier) return { httpStatus: 200, body: answer(earlier.status === "sent" ? "sent" : "pending") };
  }
  const base = { stay_id: g.stayId, guest_id: g.guestId, room_slug: slug, client_id: clientId };
  const checked = checkCommand(body.command);
  if (!checked.ok) {
    await ports.record({ ...base, status: "refused", command: {} });
    return { httpStatus: 400, body: answer("refused") };
  }
  const recent = await ports.countRecent(slug, ports.now() - AC_WINDOW_MS);
  if (recent >= AC_LIMIT) {
    await ports.record({ ...base, status: "throttled", command: checked.command });
    return { httpStatus: 200, body: answer("throttled") };
  }
  if (ports.isAvailable && !await ports.isAvailable().catch(() => true)) {
    return { httpStatus: 200, body: answer("unavailable") };
  }
  if (checked.command.turbo) {
    const last = await ports.lastTurboAt(slug);
    if (last !== null && ports.now() - last < TURBO_COOLDOWN_MS) {
      await ports.record({ ...base, status: "throttled", command: checked.command });
      return { httpStatus: 200, body: answer("turbo_wait") };
    }
  }
  const entityId = AC_CLIMATE[slug];
  const current = unitFromHa(await ports.readUnit(entityId).catch(() => null));
  const order = toHaOrder(entityId, checked.command, current?.fan ?? "auto");
  let reached = false;
  try {
    reached = await ports.callHomeAssistant(order);
  } catch {
    reached = false;
  }
  const status = reached ? "sent" : "pending";
  await ports.record({ ...base, status, command: checked.command });
  if (!reached) {
    await ports.raiseAlert({ stayId: g.stayId, roomSlug: slug, what: "Home Assistant did not answer the AC command." });
  }
  return { httpStatus: 200, body: answer(status) };
}
var STAFF_UNITS = [...new Set(Object.values(AC_CLIMATE))].map((e) => e.replace(/^climate\./, ""));

// island/ac-gateway/src/testPage.ts
var TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Living room AC test</title>
<style>body{font:18px system-ui;margin:0;padding:20px;background:#0a1310;color:#ede7da}h1{font-size:24px}button{font:inherit;padding:16px;margin:6px 6px 6px 0;border-radius:12px;border:1px solid #8fb8a8;background:#0e1915;color:#ede7da;min-width:110px}button.on{background:#8fb8a8;color:#0a1310}#s{margin:14px 0;min-height:3em}</style></head><body>
<h1>Hacienda living room</h1><div id="s">Loading...</div>
<div><button data-c='{"on":true}'>On</button><button data-c='{"on":false}'>Off</button></div>
<div><button data-c='{"level":"cool"}'>Cool</button><button data-c='{"level":"cold"}'>Cold</button><button data-c='{"level":"coldest"}'>Coldest</button></div>
<div><button data-c='{"fan":"low"}'>Fan low</button><button data-c='{"fan":"auto"}'>Fan auto</button></div>
<script>
const pass=decodeURIComponent(location.hash.slice(1)),room='living-room',s=document.getElementById('s');
async function api(b){const r=await fetch('/ac',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({pass,...b})});return r.json()}
function show(u,m){s.textContent=(u?('Now: '+(u.on?'on':'off')+', '+u.level+', fan '+u.fan+(u.turbo?', turbo':'')):'')+(m?' | '+m:'')}
async function refresh(m){try{const j=await api({action:'state'});const r=(j.rooms||[]).find(x=>x.slug===room);r&&r.unit?show(r.unit,m):show(null,j.message_en||'No reading')}catch(e){show(null,'Cannot reach the island')}}
document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{show(null,'Sending...');try{const j=await api({action:'command',room,command:JSON.parse(b.dataset.c),client_id:crypto.randomUUID()});await refresh(j.message_en||j.status)}catch(e){show(null,'Cannot reach the island')}});
refresh();setInterval(()=>refresh(),5000);
</script></body></html>`;

// island/ac-gateway/src/gateway.ts
import { createHmac, timingSafeEqual } from "node:crypto";
function testCode(secret, expMinutes) {
  const mac = createHmac("sha256", secret).update(`living-room-test|${expMinutes}`).digest("hex").slice(0, 10);
  return expMinutes.toString(36).padStart(5, "0") + mac;
}
async function passFromTestCode(code, secret, nowMs) {
  if (!/^[0-9a-z]{5}[0-9a-f]{10}$/.test(code)) return null;
  const expMinutes = parseInt(code.slice(0, 5), 36);
  const expSeconds = expMinutes * 60;
  if (expSeconds * 1e3 <= nowMs || expSeconds * 1e3 > nowMs + 4 * 36e5) return null;
  const want = Buffer.from(testCode(secret, expMinutes));
  const have = Buffer.from(code);
  if (want.length !== have.length || !timingSafeEqual(want, have)) return null;
  const today = panamaToday(nowMs);
  return signPass(
    {
      v: 1,
      stay_id: "tim-test",
      guest_id: "tim-test",
      arrives_on: today,
      departs_on: today,
      rooms: [{ slug: "living-room", name_es: "Sala", name_en: "Living Room" }],
      iat: Math.floor(nowMs / 1e3),
      exp: expSeconds
    },
    secret
  );
}
var OPTIONS_FILE = process.env.OPTIONS_FILE ?? "/data/options.json";
var STATE_FILE = process.env.STATE_FILE ?? "/data/ac-gateway-state.json";
var HA_BASE = (process.env.HA_BASE ?? "http://supervisor/core").replace(/\/+$/, "");
function readHaToken() {
  const fromEnv = process.env.SUPERVISOR_TOKEN ?? process.env.HA_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync("/run/s6/container_environment/SUPERVISOR_TOKEN", "utf8").trim();
  } catch {
    return "";
  }
}
var HA_TOKEN = readHaToken();
var HA_TIMEOUT_MS = 8e3;
var MAX_BODY = 4096;
function loadOptions() {
  const raw = JSON.parse(readFileSync(OPTIONS_FILE, "utf8"));
  return {
    webhook_id: String(raw.webhook_id ?? ""),
    pass_secret: String(raw.pass_secret ?? ""),
    origins: Array.isArray(raw.origins) && raw.origins.length ? raw.origins.map(String) : ["https://guest.diabonitoresorts.com"],
    port: Number(raw.port ?? 8443),
    cert_file: String(raw.cert_file ?? "/ssl/fullchain.pem"),
    key_file: String(raw.key_file ?? "/ssl/privkey.pem")
  };
}
var Log = class {
  constructor(file) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        this.rows = JSON.parse(readFileSync(file, "utf8")).rows ?? [];
      } catch {
        this.rows = [];
      }
    }
  }
  rows = [];
  add(row) {
    this.rows.push(row);
    const cutoff = row.at - 26 * 36e5;
    this.rows = this.rows.filter((r) => r.at >= cutoff);
    this.save();
  }
  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: this.rows }));
      renameSync(tmp, this.file);
    } catch {
    }
  }
};
function panamaToday(nowMs) {
  return new Date(nowMs - 5 * 36e5).toISOString().slice(0, 10);
}
function portsFor(pass, env) {
  return {
    findStay: async () => ({ arrives_on: pass.arrives_on, departs_on: pass.departs_on, status: "in_house" }),
    // The pass lists exactly the rooms this guest may control, so the booker rule is already applied.
    findClaimSlug: async () => null,
    isLead: async () => true,
    listRooms: async () => pass.rooms,
    async readUnit(entityId) {
      const res = await env.ha(`/api/states/${encodeURIComponent(entityId)}`);
      if (!res || !res.ok) return null;
      const j = await res.json().catch(() => null);
      if (!j || typeof j.state !== "string") return null;
      const fan = j.attributes?.fan_mode ?? null;
      let turboUntil = null;
      if (fan === "strong") {
        const timerId = `timer.ac_turbo_${entityId.replace(/^climate\./, "")}`;
        const tr = await env.ha(`/api/states/${encodeURIComponent(timerId)}`);
        const tj = tr && tr.ok ? await tr.json().catch(() => null) : null;
        if (tj?.state === "active") turboUntil = tj.attributes?.finishes_at ?? null;
      }
      return { state: j.state, temperature: j.attributes?.temperature ?? null, fan_mode: fan, turbo_until: turboUntil };
    },
    async lastTurboAt(room) {
      const hit = [...env.log.rows].reverse().find((r) => r.room === room && r.status === "sent" && r.command.turbo === true);
      return hit ? hit.at : null;
    },
    async findByClientId(clientId) {
      const hit = env.log.rows.find((r) => r.client_id === clientId);
      return hit ? { status: hit.status } : null;
    },
    async countRecent(room, sinceMs) {
      return env.log.rows.filter(
        (r) => r.room === room && r.at >= sinceMs && ["sent", "pending", "unconfirmed"].includes(r.status)
      ).length;
    },
    async record(row) {
      env.log.add({ room: row.room_slug, status: row.status, command: row.command, client_id: row.client_id, at: env.now() });
    },
    // The phone tells the cloud when it has signal (action 'problem'), which writes the alert for the team.
    markUnconfirmed: async () => true,
    async isAvailable() {
      const res = await env.ha("/api/states/input_boolean.guest_mode");
      if (!res || !res.ok) return true;
      const j = await res.json().catch(() => null);
      return j?.state !== "off";
    },
    async callHomeAssistant(order) {
      if (!env.webhookId) return false;
      const res = await env.ha(`/api/webhook/${encodeURIComponent(env.webhookId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order)
      });
      return Boolean(res && res.status >= 200 && res.status < 300);
    },
    raiseAlert: async () => void 0,
    now: env.now,
    today: () => panamaToday(env.now())
  };
}
var SELF_ORIGIN = "https://ac.diabonitoresorts.com:8443";
var NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
function corsHeaders(origin, origins) {
  if (!origin || !origins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    // Chrome asks before a public page may reach a private address.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600"
  };
}
async function handle(req, opts, env) {
  const cors = corsHeaders(req.origin, opts.origins);
  const reply = (status, body2) => ({ status, headers: { ...NO_STORE, ...cors }, body: JSON.stringify(body2) });
  if (req.method === "OPTIONS") return { status: 204, headers: cors, body: "" };
  if (req.method === "GET" && req.path === "/ping") {
    const probe = await env.ha("/api/");
    return reply(200, { ok: true, island: true, ha: probe ? probe.status : 0 });
  }
  if (req.method === "GET" && req.path.startsWith("/t/")) {
    const pass2 = await passFromTestCode(req.path.slice(3), opts.pass_secret, env.now());
    if (!pass2) return { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" }, body: "Not found" };
    return { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Location: `/test#${pass2}` }, body: "" };
  }
  if (req.method === "GET" && req.path === "/test") {
    return { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" }, body: TEST_PAGE };
  }
  if (req.method !== "POST" || req.path !== "/ac") return reply(404, { error: "not_found" });
  if (req.origin && req.origin !== SELF_ORIGIN && !opts.origins.includes(req.origin)) return reply(403, answer("refused"));
  let body;
  try {
    const parsed = JSON.parse(req.body);
    if (!parsed || typeof parsed !== "object") throw new Error("shape");
    body = parsed;
  } catch {
    return reply(400, answer("refused"));
  }
  const pass = await verifyPass(body.pass, opts.pass_secret, env.now());
  if (!pass) return reply(401, { error: "no_pass", ...answer("not_in_stay") });
  const caller = { app_role: "guest", stay_id: pass.stay_id, guest_id: pass.guest_id };
  const ports = portsFor(pass, env);
  if (body.action === "command") {
    const out = await handleAcCommand(caller, body, ports);
    return reply(out.httpStatus, out.body);
  }
  if (body.action === "state" || body.action === void 0) {
    const out = await handleAcState(caller, ports);
    return reply(out.httpStatus, out.body);
  }
  return reply(400, answer("refused"));
}
var Brake = class {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  hits = /* @__PURE__ */ new Map();
  allow(key2, nowMs) {
    const keep = (this.hits.get(key2) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (keep.length >= this.limit) {
      this.hits.set(key2, keep);
      return false;
    }
    keep.push(nowMs);
    this.hits.set(key2, keep);
    if (this.hits.size > 2e3) this.hits.clear();
    return true;
  }
};
function realEnv(opts) {
  return {
    async ha(path, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HA_TIMEOUT_MS);
      try {
        return await fetch(`${HA_BASE}${path}`, {
          ...init,
          signal: controller.signal,
          headers: { Authorization: `Bearer ${HA_TOKEN}`, ...init?.headers ?? {} }
        });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    webhookId: opts.webhook_id,
    log: new Log(STATE_FILE),
    now: () => Date.now(),
    today: () => panamaToday(Date.now())
  };
}
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
function start() {
  const opts = loadOptions();
  if (!opts.pass_secret) throw new Error("pass_secret is not set");
  const env = realEnv(opts);
  const brake = new Brake(120, 6e4);
  const rooms = Object.keys(AC_CLIMATE).length;
  const onRequest = async (req, res) => {
    const send = (r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    };
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
    if (!brake.allow(req.socket.remoteAddress ?? "x", Date.now())) {
      return send({ status: 429, headers: { ...NO_STORE, ...corsHeaders(origin, opts.origins) }, body: JSON.stringify(answer("throttled")) });
    }
    const path = (req.url ?? "/").split("?")[0];
    const body = req.method === "POST" ? await readBody(req) : "";
    if (body === null) return send({ status: 413, headers: NO_STORE, body: "{}" });
    try {
      send(await handle({ method: req.method ?? "GET", path, origin, body }, opts, env));
    } catch {
      send({ status: 500, headers: { ...NO_STORE, ...corsHeaders(origin, opts.origins) }, body: JSON.stringify(answer("pending")) });
    }
  };
  let server = null;
  let loadedAt = 0;
  const bring = () => {
    if (server && Date.now() - loadedAt < 6 * 36e5) return;
    try {
      const ctx = { cert: readFileSync(opts.cert_file), key: readFileSync(opts.key_file) };
      loadedAt = Date.now();
      if (!server) {
        server = createHttps(ctx, onRequest);
        server.listen(opts.port, "0.0.0.0", () => console.log(`ac-gateway listening on ${opts.port}, ${rooms} rooms mapped`));
      } else {
        server.setSecureContext(ctx);
      }
    } catch (e) {
      console.log(`waiting for the certificate (${e.message})`);
    }
  };
  bring();
  setInterval(bring, 6e4);
}
if (process.argv[1] && /gateway\.(mjs|ts)$/.test(process.argv[1])) start();
export {
  Brake,
  Log,
  handle,
  loadOptions,
  panamaToday,
  portsFor,
  start,
  testCode
};
