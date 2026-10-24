/* Steady Days server side (Firebase Functions, London region).
   - tick: every 5 minutes, sends the morning nudge at each person's chosen time and any task reminders that are due.
   - claude: a signed-in owner asks Claude (prettify, sorting a vision); the API key never leaves the server.
   - tick also refreshes WaniKani / Bunpro counts every 30 minutes (studyRefresh does it on request).
   - mangabaka / mangabakaSync: twice a week (and on request) copies your MangaBaka library into Backlog → Following. */
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {defineSecret, defineString} from "firebase-functions/params";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import {getAuth} from "firebase-admin/auth";
import {randomUUID} from "node:crypto";
import {fetchLibrary, mergeLibrary} from "./mangabaka.js";
import {fetchWaniKani, fetchBunpro} from "./study.js";

initializeApp();
const db = getFirestore();
const REGION = "europe-west2";
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ALLOWED_EMAILS = defineString("ALLOWED_EMAILS", {default: ""});
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", {default: "claude-sonnet-5-5"});
/* lighter, cheaper model for simple jobs like tidying titles */
const CLAUDE_MODEL_QUICK = defineString("CLAUDE_MODEL_QUICK", {default: "claude-haiku-5-5"});
const MANGABAKA_TOKEN = defineSecret("MANGABAKA_TOKEN");
const WANIKANI_TOKEN = defineSecret("WANIKANI_TOKEN");
const BUNPRO_TOKEN = defineSecret("BUNPRO_TOKEN");
const APP_URL = "https://shoussoudev.github.io/steady-days/";

/* local date and time in a time zone, e.g. {date:"2026-10-22", hm:"07:22"} */
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"})
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`};
}
const minutes = hm => { const [h, m] = String(hm || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const short = (t, n) => (t = String(t || "").trim()).length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;

async function sendTo(uid, tokens, {title, body, url, tag}) {
  if (!tokens.length) return 0;
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: {title, body, url: url || APP_URL, tag: tag || "steady-days"},
    webpush: {headers: {Urgency: "high", TTL: "21600"}},
    android: {priority: "high"}
  });
  /* forget tokens the browser no longer accepts */
  const dead = [];
  res.responses.forEach((r, i) => { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(tokens[i]); });
  if (dead.length) await db.doc(`users/${uid}/docs/devices`).set({tokens: Object.fromEntries(dead.map(t => [t, FieldValue.delete()]))}, {merge: true});
  return res.successCount;
}

function studyLine(st) {
  if (!st || !st.at || Date.now() - Date.parse(st.at) > 6 * 3600e3) return "";
  const bits = [];
  if (st.wk && !st.wk.vacation && (st.wk.reviews || st.wk.lessons)) bits.push(`WaniKani ${st.wk.reviews || 0} reviews${st.wk.lessons ? `, ${st.wk.lessons} lessons` : ""}`);
  if (st.bp && st.bp.reviews) bits.push(`Bunpro ${st.bp.reviews}`);
  return bits.length ? "🈴 " + bits.join(" · ") : "";
}
function nudgeMessage(rem, date, study) {
  const d = rem && rem.days && rem.days[date];
  const sl = studyLine(study);
  if (!d && sl) return {title: "Good morning 🌿", body: sl};
  if (!d) return {title: "Good morning 🌿", body: "A fresh day in the forest. Take a minute with Steady Days when you can."};
  const lines = [];
  if (d.pointer && d.pointer.text) lines.push(short(d.pointer.text, 140));
  if (Array.isArray(d.top3) && d.top3.length) lines.push("★ " + d.top3.slice(0, 5).map(t => short(t, 40)).join(" · "));
  if (sl) lines.push(sl);
  if (Array.isArray(d.meals) && d.meals.length) lines.push("🍲 " + d.meals.map(m => short(String(m).replace(/^(Breakfast|Lunch|Dinner|Snack): /, ""), 30)).join(", "));
  return {title: `Good morning 🌿${d.dayCount ? ` Day ${d.dayCount}` : ""}`, body: lines.join("\n") || "Take a minute with Steady Days when you can."};
}

export const tick = onSchedule({schedule: "every 5 minutes", region: REGION, timeZone: "Europe/London", retryCount: 0, memory: "256MiB", secrets: [WANIKANI_TOKEN, BUNPRO_TOKEN]}, async () => {
  try { await refreshStudyForOwner(30); } catch (e) { console.error("study refresh failed", e); }
  const users = await db.collection("users").listDocuments();
  for (const u of users) {
    const uid = u.id;
    try {
      const [setS, devS, srvS] = await Promise.all(["settings", "devices", "server"].map(id => db.doc(`users/${uid}/docs/${id}`).get()));
      const tokens = Object.keys((devS.exists && devS.data().tokens) || {});
      if (!tokens.length) continue;
      const st = (setS.exists && setS.data()) || {};
      const srv = (srvS.exists && srvS.data()) || {};
      const tz = st.timeZone || "Europe/London";
      const now = localNow(tz);
      const patch = {};

      /* morning nudge: once a day, at or after the chosen time (within two hours, so a late tick still counts) */
      const at = st.nudgeTime || "07:22";
      const late = minutes(now.hm) - minutes(at);
      if (st.nudgeOn !== false && late >= 0 && late < 120 && srv.lastNudge !== now.date) {
        const rem = await db.doc(`users/${uid}/docs/reminder__next`).get();
        const sd = await db.doc(`users/${uid}/docs/study`).get();
        await sendTo(uid, tokens, {...nudgeMessage(rem.exists ? rem.data() : null, now.date, sd.exists ? sd.data() : null), tag: "nudge"});
        patch.lastNudge = now.date;
      }

      /* task reminders: anything open whose reminder time has passed in the last day and wasn't sent yet */
      const tt = await db.doc(`users/${uid}/docs/tt`).get();
      const sent = srv.sentReminders || {};
      const nowMs = Date.now(), keep = {};
      for (const t of ((tt.exists && tt.data().tasks) || [])) {
        if (!t.remindAt || (t.status !== 0 && t.status != null)) continue;
        const ms = Date.parse(t.remindAt);
        if (!(ms > 0)) continue;
        if (sent[t.id] === t.remindAt) { keep[t.id] = t.remindAt; continue; }
        if (ms <= nowMs && nowMs - ms < 24 * 3600e3) {
          await sendTo(uid, tokens, {title: "⏰ " + short(t.title, 80), body: t.content ? short(t.content, 120) : "Reminder from Steady Days", tag: "task-" + t.id});
          keep[t.id] = t.remindAt;
        }
      }
      if (JSON.stringify(keep) !== JSON.stringify(sent)) patch.sentReminders = keep;
      if (Object.keys(patch).length) await db.doc(`users/${uid}/docs/server`).set({...patch, updated: new Date().toISOString()}, {merge: true});
    } catch (e) {
      console.error("tick failed for", uid, e);
    }
  }
});

/* Ask Claude. Only the emails listed in ALLOWED_EMAILS may use it, so the key can't be spent by strangers. */
export const claude = onCall({region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "256MiB"}, async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email;
  const allowed = ALLOWED_EMAILS.value().split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(String(email).toLowerCase())) throw new HttpsError("permission-denied", "Claude isn't enabled for this account.");
  if (!ANTHROPIC_API_KEY.value() || ANTHROPIC_API_KEY.value() === "not-set") throw new HttpsError("failed-precondition", "No Claude key has been added yet.");
  const prompt = String((req.data && req.data.prompt) || "");
  if (!prompt || prompt.length > 60000) throw new HttpsError("invalid-argument", "Empty or too long.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01"},
    body: JSON.stringify({model: (req.data && req.data.tier === "quick") ? CLAUDE_MODEL_QUICK.value() : CLAUDE_MODEL.value(), max_tokens: 4000, messages: [{role: "user", content: prompt}]})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Anthropic error", r.status, j);
    throw new HttpsError(r.status === 429 ? "resource-exhausted" : "unavailable", (j.error && j.error.message) || `Claude returned ${r.status}`);
  }
  /* keep a running tally of usage so Settings can show it (prices are an estimate per million tokens) */
  try {
    const u = j.usage || {}, inT = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), outT = u.output_tokens || 0;
    const m = String(j.model || CLAUDE_MODEL.value()).toLowerCase();
    const [pi, po] = /haiku/.test(m) ? [1, 5] : /opus/.test(m) ? [5, 25] : [3, 15];
    const cost = (inT * pi + outT * po) / 1e6;
    const month = new Date().toISOString().slice(0, 7), inc = FieldValue.increment;
    const add = {calls: inc(1), input: inc(inT), output: inc(outT), cost: inc(cost)};
    await db.doc(`users/${req.auth.uid}/docs/usage`).set({months: {[month]: add}, total: add, last: {at: new Date().toISOString(), model: j.model || CLAUDE_MODEL.value(), input: inT, output: outT, cost}}, {merge: true});
  } catch (e) { console.error("usage tally failed", e); }
  return {text: (j.content || []).filter(c => c.type === "text").map(c => c.text).join("")};
});

/* ---------- MangaBaka: the token is yours, so it only ever syncs into the first allowed account ---------- */
const owner = () => ALLOWED_EMAILS.value().split(",").map(x => x.trim().toLowerCase()).filter(Boolean)[0] || "";

async function syncMangaBaka(uid) {
  const token = MANGABAKA_TOKEN.value();
  const ref = db.doc(`users/${uid}/docs/backlog`);
  const at = new Date().toISOString();
  if (!token || token === "not-set") {
    await ref.set({mbSync: {at, error: "no-token"}}, {merge: true});
    return {error: "no-token"};
  }
  let lib;
  try { lib = await fetchLibrary(token); }
  catch (e) {
    console.error("MangaBaka fetch failed", e);
    await ref.set({mbSync: {at, error: e.code || "unavailable"}}, {merge: true});
    return {error: e.code || "unavailable"};
  }
  const today = new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/London"}).format(new Date());
  const stats = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    const {items, stats} = mergeLibrary(Array.isArray(cur.items) ? cur.items : [], lib, today, () => randomUUID().slice(0, 12));
    tx.set(ref, {items, kind: "backlog", mbSync: {at, count: lib.length, ...stats}}, {merge: true});
    return stats;
  });
  return {count: lib.length, ...stats};
}

/* Monday and Thursday mornings */
export const mangabaka = onSchedule({schedule: "10 6 * * 1,4", region: REGION, timeZone: "Europe/London", retryCount: 0, secrets: [MANGABAKA_TOKEN], memory: "256MiB", timeoutSeconds: 120}, async () => {
  const email = owner();
  if (!email) return;
  let user;
  try { user = await getAuth().getUserByEmail(email); } catch (e) { console.error("owner not found", e); return; }
  await syncMangaBaka(user.uid);
});

/* "Sync now" from Settings */
export const mangabakaSync = onCall({region: REGION, secrets: [MANGABAKA_TOKEN], timeoutSeconds: 120, memory: "256MiB"}, async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (!email || String(email).toLowerCase() !== owner()) throw new HttpsError("permission-denied", "MangaBaka sync isn't enabled for this account.");
  return await syncMangaBaka(req.auth.uid);
});

/* ---------- Japanese study: counts for the owner's Today card, refreshed at most every `minAge` minutes ---------- */
const has = sec => { const v = sec.value(); return !!v && v !== "not-set"; };
async function refreshStudy(uid, minAge) {
  const ref = db.doc(`users/${uid}/docs/study`);
  const cur = (await ref.get()).data() || {};
  const E = cur.errors || {};
  /* a token that was missing or refused last time may have been added since: don't wait for the cache */
  const retry = (E.wk && has(WANIKANI_TOKEN)) || (E.bp && has(BUNPRO_TOKEN));
  if (!retry && cur.at && Date.now() - Date.parse(cur.at) < minAge * 60e3) return cur;
  const out = {at: new Date().toISOString(), wk: null, bp: null, errors: {}};
  if (has(WANIKANI_TOKEN)) { try { out.wk = await fetchWaniKani(WANIKANI_TOKEN.value()); } catch (e) { out.errors.wk = e.code || "unavailable"; out.wk = cur.wk || null; } }
  else out.errors.wk = "no-token";
  if (has(BUNPRO_TOKEN)) { try { out.bp = await fetchBunpro(BUNPRO_TOKEN.value()); } catch (e) { out.errors.bp = e.code || "unavailable"; out.bp = cur.bp || null; } }
  else out.errors.bp = "no-token";
  await ref.set(JSON.parse(JSON.stringify(out)));
  return out;
}
async function refreshStudyForOwner(minAge) {
  if (!has(WANIKANI_TOKEN) && !has(BUNPRO_TOKEN)) return;
  const email = owner();
  if (!email) return;
  const user = await getAuth().getUserByEmail(email);
  await refreshStudy(user.uid, minAge);
}

/* Today asks for fresh counts when it opens (at most every 5 minutes) */
export const studyRefresh = onCall({region: REGION, secrets: [WANIKANI_TOKEN, BUNPRO_TOKEN], timeoutSeconds: 30, memory: "256MiB"}, async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (!email || String(email).toLowerCase() !== owner()) throw new HttpsError("permission-denied", "Study counts aren't enabled for this account.");
  const st = await refreshStudy(req.auth.uid, req.data && req.data.force ? 0 : 5);
  return {at: st.at};
});
