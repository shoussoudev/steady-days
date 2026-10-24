/* Japanese study counts for Today: WaniKani (official API v2) and Bunpro (the API its own website uses).
   Read-only: nothing is ever changed on either site. */
export async function fetchWaniKani(token, now = Date.now(), fetchImpl = fetch) {
  const h = {Authorization: `Bearer ${token}`, "Wanikani-Revision": "20170710"};
  const get = async path => {
    const r = await fetchImpl(`https://api.wanikani.com/v2/${path}`, {headers: h});
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("WaniKani refused the token"), {code: "bad-token"});
    if (!r.ok) throw Object.assign(new Error(`WaniKani ${r.status}`), {code: "unavailable"});
    return (await r.json()).data || {};
  };
  const [sum, user] = await Promise.all([get("summary"), get("user")]);
  /* recent mistakes ≈ items whose last answer (in the past 24 h) was wrong: an incorrect answer resets the streak to 1 */
  let mistakes = 0;
  try {
    let url = `review_statistics?updated_after=${new Date(now - 24 * 3600e3).toISOString()}`;
    for (let i = 0; url && i < 4; i++) {
      const r = await fetchImpl(url.startsWith("http") ? url : `https://api.wanikani.com/v2/${url}`, {headers: h});
      if (!r.ok) break;
      const j = await r.json();
      for (const x of j.data || []) {
        const d = x.data || {};
        const wrongM = d.meaning_current_streak === 1 && d.meaning_incorrect > 0;
        const wrongR = d.reading_current_streak === 1 && d.reading_incorrect > 0;
        if (!d.hidden && (wrongM || wrongR)) mistakes++;
      }
      url = j.pages && j.pages.next_url;
    }
  } catch (_) { mistakes = null; }
  const count = (buckets, upTo) => (buckets || []).filter(b => Date.parse(b.available_at) <= upTo).reduce((a, b) => a + (b.subject_ids || []).length, 0);
  return {
    reviews: count(sum.reviews, now), lessons: count(sum.lessons, now),
    soon: count(sum.reviews, now + 24 * 3600e3) - count(sum.reviews, now),
    next: sum.next_reviews_at || null, level: user.level || null,
    vacation: !!user.current_vacation_started_at, mistakes
  };
}

/* Bunpro's due endpoint isn't documented, so read whatever counts it returns */
export function parseBunproDue(j) {
  const d = j && typeof j === "object" && !Array.isArray(j) && j.data && typeof j.data === "object" ? j.data : j;
  if (Array.isArray(d)) return {reviews: d.length};
  const out = {reviews: 0};
  let found = false;
  for (const [k, v] of Object.entries(d || {})) {
    if (typeof v === "number" && /due/i.test(k)) {
      found = true;
      if (/grammar/i.test(k)) out.grammar = v; else if (/vocab/i.test(k)) out.vocab = v;
      if (!/total/i.test(k) || !Object.keys(d).some(x => /total/i.test(x) && x !== k)) out.reviews += v;
    } else if (Array.isArray(v) && /due|review/i.test(k)) { found = true; out.reviews += v.length; }
  }
  if (!found) for (const v of Object.values(d || {})) if (typeof v === "number") out.reviews += v;
  if (out.grammar != null || out.vocab != null) out.reviews = (out.grammar || 0) + (out.vocab || 0);
  return out;
}

export async function fetchBunpro(token, fetchImpl = fetch) {
  /* the site sends "Token token=…"; accept the whole header, just the value, or a Bearer token */
  const t = String(token).trim().replace(/^Bearer\s+/i, "");
  const tries = /^Token\s/i.test(t) ? [t] : /^token=/i.test(t) ? [`Token ${t}`] : [`Token token=${t}`, `Bearer ${t}`];
  let r;
  for (const auth of tries) {
    r = await fetchImpl("https://api.bunpro.jp/api/frontend/user/due", {headers: {Authorization: auth, accept: "application/json"}});
    if (r.status !== 401 && r.status !== 403) break;
  }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Bunpro refused the token"), {code: "bad-token"});
  if (!r.ok) throw Object.assign(new Error(`Bunpro ${r.status}`), {code: "unavailable"});
  const j = await r.json();
  const d = j && j.data && typeof j.data === "object" ? j.data : j;
  return {...parseBunproDue(j), shape: d && typeof d === "object" ? Object.keys(d).slice(0, 12) : []};
}
