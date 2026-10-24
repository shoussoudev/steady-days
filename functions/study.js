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
  const count = (buckets, upTo) => (buckets || []).filter(b => Date.parse(b.available_at) <= upTo).reduce((a, b) => a + (b.subject_ids || []).length, 0);
  return {
    reviews: count(sum.reviews, now), lessons: count(sum.lessons, now),
    soon: count(sum.reviews, now + 24 * 3600e3) - count(sum.reviews, now),
    next: sum.next_reviews_at || null, level: user.level || null,
    vacation: !!user.current_vacation_started_at
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
  const r = await fetchImpl("https://api.bunpro.jp/api/frontend/user/due", {headers: {Authorization: `Bearer ${token}`, accept: "application/json"}});
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Bunpro refused the token"), {code: "bad-token"});
  if (!r.ok) throw Object.assign(new Error(`Bunpro ${r.status}`), {code: "unavailable"});
  const j = await r.json();
  const d = j && j.data && typeof j.data === "object" ? j.data : j;
  return {...parseBunproDue(j), shape: d && typeof d === "object" ? Object.keys(d).slice(0, 12) : []};
}
