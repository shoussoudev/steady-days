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
import {fetchWaniKani, fetchBunpro, fetchKnownKanji} from "./study.js";

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

/* server activity goes into the same daily usage record the app keeps (counts only), so Settings → Usage shows it */
async function logServer(uid, counts) {
  try {
    const day = new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/London"}).format(new Date());
    const server = {};
    for (const [k, v] of Object.entries(counts)) if (v) server[k] = FieldValue.increment(v);
    if (Object.keys(server).length) await db.doc(`users/${uid}/docs/use-${day}`).set({kind: "use", date: day, server}, {merge: true});
  } catch (e) { console.error("usage log failed", e); }
}

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
/* birthdays and dates: a line on the day and a week ahead */
function dateLines(items, date) {
  const dn = k => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 864e5;
  const p2 = n => String(n).padStart(2, "0");
  const out = [];
  for (const x of items || []) {
    if (!x || !/^\d\d-\d\d$/.test(x.md || "")) continue;
    const [mm, dd] = x.md.split("-").map(Number), y0 = +date.slice(0, 4);
    const at = y => { const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; return `${y}-${p2(mm)}-${p2(mm === 2 && dd === 29 && !leap ? 28 : dd)}`; };
    let k = at(y0); if (k < date) k = at(y0 + 1);
    const days = dn(k) - dn(date), yrs = x.year ? +k.slice(0, 4) - x.year : null;
    if (days !== 0 && days !== 7) continue;
    const name = short(x.name, 40);
    if (x.kind === "remembrance") out.push(days ? `🕯 ${name}'s day is in a week` : `🕯 Remembering ${name} today`);
    else if (x.kind === "birthday") out.push(days ? `🎂 ${name}'s birthday is in a week${yrs ? ` (turns ${yrs})` : ""}` : `🎂 ${name}${yrs ? ` turns ${yrs}` : "'s birthday is"} today`);
    else out.push(`${x.kind === "anniversary" ? "💍" : "⭐"} ${name}${x.kind === "anniversary" ? " anniversary" : ""} ${days ? "in a week" : "today"}${yrs ? ` · ${yrs} year${yrs === 1 ? "" : "s"}` : ""}`);
  }
  return out;
}
function nudgeMessage(rem, date, study, dl) {
  const d = rem && rem.days && rem.days[date];
  const sl = studyLine(study);
  dl = dl || [];
  if (!d && (sl || dl.length)) return {title: "Good morning 🌿", body: [...dl, sl].filter(Boolean).join("\n")};
  if (!d) return {title: "Good morning 🌿", body: "A fresh day in the forest. Take a minute with Steady Days when you can."};
  const lines = [...dl];
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
      const inWindow = late >= 0 && late < 120;
      const datesDoc = inWindow && (srv.lastNudge !== now.date || srv.lastDates !== now.date) ? await db.doc(`users/${uid}/docs/dates`).get() : null;
      const dl = datesDoc && datesDoc.exists ? dateLines(datesDoc.data().items, now.date) : [];
      if (st.nudgeOn !== false && inWindow && srv.lastNudge !== now.date) {
        const rem = await db.doc(`users/${uid}/docs/reminder__next`).get();
        const sd = await db.doc(`users/${uid}/docs/study`).get();
        await sendTo(uid, tokens, {...nudgeMessage(rem.exists ? rem.data() : null, now.date, sd.exists ? sd.data() : null, dl), tag: "nudge"});
        patch.lastNudge = now.date; patch.lastDates = now.date;
        await logServer(uid, {nudge_sent: 1});
      } else if (st.nudgeOn === false && inWindow && dl.length && srv.lastDates !== now.date) {
        /* morning nudge switched off: dates still get their own gentle notification */
        await sendTo(uid, tokens, {title: dl.length === 1 ? dl[0] : "Dates to remember", body: dl.length === 1 ? "From Steady Days" : dl.join("\n"), tag: "dates"});
        patch.lastDates = now.date;
        await logServer(uid, {dates_sent: 1});
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
          await logServer(uid, {reminder_sent: 1});
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
    await logServer(req.auth.uid, {claude_error: 1});
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
  await logServer(req.auth.uid, {[req.data && req.data.tier === "quick" ? "claude_quick" : "claude_call"]: 1});
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
    await logServer(uid, {mangabaka_error: 1});
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
  await logServer(uid, {mangabaka_sync: 1, mangabaka_added: stats.added, mangabaka_updated: stats.updated, mangabaka_moved: stats.moved});
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
  /* "today" in London: the date and the instant of local midnight */
  const tz = "Europe/London", nowD = new Date();
  const day = new Intl.DateTimeFormat("en-CA", {timeZone: tz}).format(nowD);
  const offset = Date.parse(nowD.toLocaleString("en-US", {timeZone: tz})) - Date.parse(nowD.toLocaleString("en-US", {timeZone: "UTC"}));
  const midnight = Date.parse(day + "T00:00:00Z") - offset;
  out.day = day;
  if (has(WANIKANI_TOKEN)) { try { out.wk = await fetchWaniKani(WANIKANI_TOKEN.value(), Date.now(), fetch, midnight); } catch (e) { out.errors.wk = e.code || "unavailable"; out.wk = cur.wk || null; } }
  else out.errors.wk = "no-token";
  /* known kanji change slowly: refresh twice a day */
  out.known = cur.known || "";
  out.knownAt = cur.knownAt || null;
  if (has(WANIKANI_TOKEN) && out.wk && (!cur.knownAt || Date.now() - Date.parse(cur.knownAt) > 12 * 3600e3 || (cur.errors && cur.errors.known))) {
    try { out.known = await fetchKnownKanji(WANIKANI_TOKEN.value(), out.wk.level); out.knownAt = out.at; }
    catch (e) { out.errors.known = e.code || "unavailable"; }
  }
  if (has(BUNPRO_TOKEN)) { try { out.bp = await fetchBunpro(BUNPRO_TOKEN.value()); } catch (e) { out.errors.bp = e.code || "unavailable"; out.bp = cur.bp || null; } }
  /* Bunpro has no history to ask, so notice the queue going down: each drop since the last check counts as reviews done today */
  if (out.bp && !out.errors.bp) {
    const prev = cur.bp && cur.day === day ? cur.bp : null;
    const drop = prev && typeof prev.reviews === "number" ? Math.max(0, prev.reviews - out.bp.reviews) : 0;
    out.bp.doneToday = (prev && prev.doneToday || 0) + drop;
  }
  else out.errors.bp = "no-token";
  await ref.set(JSON.parse(JSON.stringify(out)));
  await logServer(uid, {study_refresh: 1, study_error: (out.errors.wk && out.errors.wk !== "no-token" ? 1 : 0) + (out.errors.bp && out.errors.bp !== "no-token" ? 1 : 0), known_kanji: out.knownAt === out.at ? 1 : 0});
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
