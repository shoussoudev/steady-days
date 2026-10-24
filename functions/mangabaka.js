/* MangaBaka → Steady Days. MangaBaka is the source of truth for what you follow digitally:
   new library entries are added, chapter progress is copied, and a change of state there
   (completed, dropped, paused…) moves the item here. Nothing is ever written back to MangaBaka. */
const API = "https://api.mangabaka.org";

export const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function titleOf(s) {
  if (s.title) return s.title;
  const T = Array.isArray(s.titles) ? s.titles : [];
  const pr = t => t.is_primary === true;
  const pick = T.find(t => pr(t) && t.language === "en") || T.find(t => t.language === "en") || T.find(t => pr(t) && /-Latn$/.test(t.language || "")) || T.find(pr) || T[0];
  return (pick && pick.title) || s.romanized_title || "";
}
const kindOf = type => /manhwa|manhua|webtoon/i.test(type || "") ? "webtoon" : /novel/i.test(type || "") ? "book" : "manga";
const day = v => (v && String(v).length >= 10 ? String(v).slice(0, 10) : "");

/* where a MangaBaka state puts the item here */
function place(state) {
  switch (state) {
    case "completed": return {status: "done"};
    case "dropped": return {status: "dropped"};
    case "paused": case "on_hold": return {status: "following", fState: "paused"};
    case "plan_to_read": case "considering": return {status: "following", fState: "plan"};
    default: return {status: "following"};
  }
}

export async function fetchLibrary(token, fetchImpl = fetch) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetchImpl(`${API}/v2/my/library?limit=100&page=${page}`, {headers: {"x-api-key": token, accept: "application/json"}});
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("MangaBaka refused the token"), {code: "bad-token"});
    if (!r.ok) throw Object.assign(new Error(`MangaBaka returned ${r.status}`), {code: "unavailable"});
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    out.push(...data);
    const P = j.pagination || {};
    if (!P.next || !data.length || (P.count && page * 100 >= P.count)) break;
  }
  return out;
}

/* pure merge so it can be tested; returns the new items and what changed */
export function mergeLibrary(items, lib, today, newId) {
  items = items.map(x => ({...x}));
  const st = {added: 0, updated: 0, moved: 0};
  for (const row of lib) {
    const e = row.entry || {}, s = row.series || {};
    const sid = String(e.series_id ?? s.id ?? "");
    const title = titleOf(s);
    if (!sid || !title) continue;
    const to = place(e.state);
    const fields = {
      mb: sid, mbType: s.type || undefined,
      ch: e.progress_chapter ?? undefined, total: s.total_chapters ?? undefined,
      pub: s.status || undefined, link: e.read_link || s.canonical_url || `https://mangabaka.org/${sid}`
    };
    let it = items.find(x => String(x.mb || "") === sid);
    if (!it) { const n = norm(title); it = items.find(x => !x.mb && ["manga", "webtoon", "book"].includes(x.type) && norm(x.title) === n); }
    if (!it) {
      it = {id: newId(), type: kindOf(s.type), title, by: (s.authors && s.authors[0]) || undefined, year: +day(s.published && s.published.start_date).slice(0, 4) || undefined,
        added: day(e.start_date) || today, source: "mangabaka", mbState: e.state, chAt: today, ...to, ...fields};
      if (to.status === "done") it.finished = day(e.finish_date) || today;
      if (to.status === "dropped") it.dropped = today;
      items.push(it); st.added++;
      continue;
    }
    if (fields.ch != null && +fields.ch !== +(it.ch || 0)) { it.chAt = today; st.updated++; }
    Object.assign(it, fields);
    /* move only when the state on MangaBaka actually changed, so changes made here stick */
    if (e.state && e.state !== it.mbState) {
      const keepPhysical = it.status === "now" && to.status === "following";
      if (!keepPhysical && (it.status !== to.status || (it.fState || "") !== (to.fState || ""))) {
        it.status = to.status;
        if (to.fState) it.fState = to.fState; else delete it.fState;
        delete it.next;
        if (to.status === "done") it.finished = day(e.finish_date) || today;
        if (to.status === "dropped") it.dropped = it.dropped || today;
        st.moved++;
      }
      it.mbState = e.state;
    }
  }
  /* Firestore rejects undefined */
  return {items: JSON.parse(JSON.stringify(items)), stats: st};
}
