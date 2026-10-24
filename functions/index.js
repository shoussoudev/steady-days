/* Steady Days server side (Firebase Functions, London region).
   - tick: every 5 minutes, sends the morning nudge at each person's chosen time and any task reminders that are due.
   - claude: a signed-in owner asks Claude (prettify, sorting a vision); the API key never leaves the server. */
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {defineSecret, defineString} from "firebase-functions/params";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";

initializeApp();
const db = getFirestore();
const REGION = "europe-west2";
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ALLOWED_EMAILS = defineString("ALLOWED_EMAILS", {default: ""});
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", {default: "claude-sonnet-5-5"});
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

function nudgeMessage(rem, date) {
  const d = rem && rem.days && rem.days[date];
  if (!d) return {title: "Good morning 🌿", body: "A fresh day in the forest. Take a minute with Steady Days when you can."};
  const lines = [];
  if (d.pointer && d.pointer.text) lines.push(short(d.pointer.text, 140));
  if (Array.isArray(d.top3) && d.top3.length) lines.push("★ " + d.top3.slice(0, 5).map(t => short(t, 40)).join(" · "));
  if (Array.isArray(d.meals) && d.meals.length) lines.push("🍲 " + d.meals.map(m => short(String(m).replace(/^(Breakfast|Lunch|Dinner|Snack): /, ""), 30)).join(", "));
  return {title: `Good morning 🌿${d.dayCount ? ` Day ${d.dayCount}` : ""}`, body: lines.join("\n") || "Take a minute with Steady Days when you can."};
}

export const tick = onSchedule({schedule: "every 5 minutes", region: REGION, timeZone: "Europe/London", retryCount: 0, memory: "256MiB"}, async () => {
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
        await sendTo(uid, tokens, {...nudgeMessage(rem.exists ? rem.data() : null, now.date), tag: "nudge"});
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
    body: JSON.stringify({model: CLAUDE_MODEL.value(), max_tokens: 4000, messages: [{role: "user", content: prompt}]})
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
