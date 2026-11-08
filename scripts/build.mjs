// Génère la page des affiches : lit le Google Sheet, trouve les affiches sur TMDB,
// et écrit site/index.html. Lancé chaque nuit par GitHub Actions.
// Usage : TMDB_KEY=xxxx node scripts/build.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHEET_ID = process.env.SHEET_ID || "130o3cSAhCDoCLibn58bqPJBqv2LKReXnk0lmDGX2q-w";
const GID = process.env.SHEET_GID || "0";
const TMDB_KEY = process.env.TMDB_KEY;
const CACHE_FILE = path.join(ROOT, "data/posters.json");
const OVERRIDES_FILE = path.join(ROOT, "data/overrides.json");
const MISS_RETRY_DAYS = 3;     // un film sans affiche est recherché à nouveau après 3 jours
const REFRESH_DAYS = 14;       // popularité / note rafraîchies toutes les 2 semaines


/* ---------------- Outils texte ---------------- */
export function normalize(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
const NUMS = { un: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9", dix: "10", cinquante: "50", cent: "100", one: "1", two: "2", three: "3", fifty: "50" };
const STOP = new Set(["le", "la", "les", "l", "un", "une", "des", "de", "du", "d", "the", "a", "an", "of", "et", "and"]);
const tokens = t => normalize(t).split(" ").filter(Boolean).map(w => NUMS[w] || w.replace(/(s|x)$/, "")).filter(w => !STOP.has(w));
export function titleSim(a, b) {
  const ca = normalize(a).replace(/ /g, ""), cb = normalize(b).replace(/ /g, "");
  if (ca && ca === cb) return 1;                                  // « Yiyi » = « Yi Yi »
  const A = tokens(a), B = tokens(b); if (!A.length || !B.length) return 0;
  const setB = new Set(B); const common = A.filter(w => setB.has(w)).length;
  return Math.max(2 * common / (A.length + B.length), (common / A.length) * 0.9);
}
export function cleanTitle(t) {
  return t.replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(ressortie|reprise|version restaur[ée]e|restaur[ée]|4k|r[ée][ée]dition|avant[- ]premi[eè]re|vost(fr)?|vf)\b/gi, " ")
    .replace(/[\s\-–—:]+$/, "").replace(/\s+/g, " ").trim() || t.trim();
}

/* ---------------- Lecture du tableau ---------------- */
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const sumCount = s => (s.match(/\d+/g) || []).reduce((a, b) => a + +b, 0);
export const keyOf = f => `${normalize(f.title)}|${f.year}`;

export function toFilms(rows) {
  const head = rows[0].map(h => normalize(h));
  const find = (re, def) => { const i = head.findIndex(h => re.test(h)); return i < 0 ? def : i; };
  const iName = find(/nom|film|titre/, 0), iSmall = find(/petite/, 1), iBig = find(/grande/, 2),
    iOther = find(/autre/, 3), iStore = find(/stockage/, 4), iReal = find(/real|annee/, 5);
  // colonne facultative « Affiche » : lien d'une image choisie à la main
  const iPoster = head.findIndex(h => /^(affiche|lien affiche|image)$/.test(h));
  const out = [];
  rows.slice(1).forEach(r => {
    const title = (r[iName] || "").trim();
    if (!title) return;
    const real = (r[iReal] || "").trim();
    // « Réalisateur (année) » ou « Réalisateur (1926 : ressortie 2026) » : 1re année = sortie d'origine
    const ym = real.match(/\b(1[89]|20)\d{2}\b/g);
    const year = ym ? ym[0] : "";
    const director = real.replace(/\(.*?\)/g, " ").replace(/\b(1[89]|20)\d{2}\b/g, " ")
      .replace(/[\s,\-–—/]+$/, "").replace(/^[\s,\-–—/]+/, "").replace(/\s+/g, " ").trim();
    const small = (r[iSmall] || "").trim(), big = (r[iBig] || "").trim(), other = (r[iOther] || "").trim();
    const manual = iPoster >= 0 ? (r[iPoster] || "").trim() : "";
    out.push({ title, director, year, real, small, big, other, store: (r[iStore] || "").trim(),
      total: sumCount(small) + sumCount(big), manual: /^https?:\/\//.test(manual) ? manual : "" });
  });
  return out;
}

async function fetchSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Lecture du tableau impossible (${r.status})`);
  return parseCSV(await r.text());
}

/* ---------------- TMDB ---------------- */
async function tmdb(p, params = {}) {
  const bearer = TMDB_KEY.startsWith("eyJ");
  const u = new URL("https://api.themoviedb.org/3" + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (!bearer) u.searchParams.set("api_key", TMDB_KEY);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u, bearer ? { headers: { Authorization: "Bearer " + TMDB_KEY } } : {});
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`TMDB ${r.status} ${p}`);
    return r.json();
  }
  throw new Error("TMDB : trop de requêtes");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rank(list, f) {
  const y = +f.year, ct = cleanTitle(f.title), out = [];
  list.forEach((m, i) => {
    if (!m.poster_path) return;
    const sim = Math.max(titleSim(ct, m.title || ""), titleSim(ct, m.original_title || ""));
    if (sim < 0.5) return;
    const my = +(m.release_date || "").slice(0, 4);
    const dy = y && my ? Math.abs(my - y) : null;
    out.push({ m, sim, dy, my, s: sim * 10 + (dy === 0 ? 3 : dy === 1 ? 1 : dy === null ? 0 : -2) - i * 0.3 });
  });
  return out.sort((a, b) => b.s - a.s);
}
function acceptByYear(c, f) {
  if (c.dy === null) return c.sim >= 0.85;
  if (c.dy <= 1) return true;
  return c.my < +f.year && c.sim >= 0.75;     // film plus ancien : ressortie
}
const dirCache = new Map();
function directors(id) {
  if (!dirCache.has(id)) dirCache.set(id, tmdb(`/movie/${id}/credits`)
    .then(d => (d.crew || []).filter(c => c.job === "Director").map(c => c.name)).catch(() => null));
  return dirCache.get(id);
}
function directorMatches(sheetDir, names) {
  const parts = sheetDir.split(/\s*(?:,|&|\bet\b|\band\b|\/)\s*/i).map(normalize).filter(Boolean);
  return names.some(n => {
    const nt = normalize(n).split(" "), last = nt[nt.length - 1];
    return parts.some(p => { const pt = p.split(" "); return pt.includes(last) || nt.includes(pt[pt.length - 1]); });
  });
}

async function byDirector(f) {
  const first = f.director.split(/\s*(?:,|&|\bet\b|\band\b|\/)\s*/i)[0];
  const ps = await tmdb("/search/person", { query: first });
  const nf = normalize(first);
  const person = (ps.results || []).find(x => normalize(x.name) === nf) || (ps.results || [])[0];
  if (!person) return null;
  const cr = await tmdb(`/person/${person.id}/movie_credits`, { language: "fr-FR" });
  const ct = cleanTitle(f.title), y = +f.year;
  const scored = (cr.crew || []).filter(c => c.job === "Director" && c.poster_path).map(m => {
    const sim = Math.max(titleSim(ct, m.title || ""), titleSim(ct, m.original_title || ""));
    const my = +(m.release_date || "").slice(0, 4);
    return { m, sim, dy: y && my ? Math.abs(my - y) : 99 };
  });
  const byTitle = scored.filter(c => c.sim >= 0.5).sort((a, b) => b.sim - a.sim || a.dy - b.dy)[0];
  if (byTitle) return byTitle.m;
  const sameYear = scored.filter(c => c.dy === 0);
  return sameYear.length === 1 ? sameYear[0].m : null;
}

async function findMovie(f) {
  const ct = cleanTitle(f.title);
  const words = normalize(ct).split(" ").filter(w => w && !STOP.has(w));
  const queries = [...new Set([ct, words.join(" "), ct.split(/\s*[:\-–—]\s*|\s+et\s+|\s+and\s+/i)[0], words.slice(0, 3).join(" ")]
    .filter(q => q && q.length > 1))];
  const hasDir = normalize(f.director || "").length > 1;
  for (const q of queries) {
    const seen = new Map();
    for (const withYear of [true, false]) {
      const params = { query: q, language: "fr-FR", include_adult: "false" };
      if (withYear && f.year) params.year = f.year;
      const d = await tmdb("/search/movie", params);
      rank(d.results || [], f).forEach(c => { if (!seen.has(c.m.id)) seen.set(c.m.id, c); });
    }
    const cands = [...seen.values()].sort((a, b) => b.s - a.s);
    if (!cands.length) continue;
    if (hasDir) {
      let anyKnown = false;
      for (const c of cands.slice(0, 8)) {
        const names = await directors(c.m.id);
        if (names && names.length) { anyKnown = true; if (directorMatches(f.director, names)) return c.m; }
      }
      const exact = cands.find(c => c.dy === 0);
      if (exact) return exact.m;
      if (anyKnown) continue;
    }
    const ok = cands.find(c => acceptByYear(c, f));
    if (ok) return ok.m;
  }
  return hasDir ? byDirector(f) : null;
}

async function frenchPoster(id) {
  const d = await tmdb(`/movie/${id}/images`, { include_image_language: "fr" });
  const fr = (d.posters || []).filter(x => x.iso_639_1 === "fr")
    .sort((a, b) => (b.vote_average - a.vote_average) || (b.vote_count - a.vote_count));
  return fr[0]?.file_path || null;
}

async function lookup(f) {
  const m = await findMovie(f);
  if (!m) return { found: false, t: Date.now() };
  const fr = await frenchPoster(m.id).catch(() => null);
  // popularité / note à jour depuis la fiche du film
  const det = await tmdb(`/movie/${m.id}`, { language: "fr-FR" }).catch(() => m);
  return {
    found: true, t: Date.now(), tmdb: m.id,
    poster: fr || m.poster_path, fr: !!fr,
    tmdbTitle: det.title || m.title, released: det.release_date || m.release_date || "",
    pop: det.popularity ?? m.popularity ?? 0, note: det.vote_average ?? m.vote_average ?? 0, votes: det.vote_count ?? m.vote_count ?? 0,
  };
}

/* ---------------- Allociné ----------------
   On ne passe PAS par la recherche d'Allociné (interdite aux robots par leur robots.txt).
   Le film est identifié via TMDB, son identifiant Allociné est lu dans Wikidata (propriété P1265),
   puis seule la fiche du film est consultée, lentement, une seule fois par film. */
const UA = "AffichesStella/1.0 (inventaire personnel d'affiches; une requete par film)";
let alloRobots = null;
async function allocineAllowed(pathname) {
  if (alloRobots === null) {
    try {
      const r = await fetch("https://www.allocine.fr/robots.txt", { headers: { "User-Agent": UA } });
      const txt = r.ok ? await r.text() : "";
      const rules = []; let inStar = false;   // règles du groupe « User-agent: * »
      for (const line of txt.split(/\r?\n/)) {
        const [k, ...v] = line.split(":"); const key = k.trim().toLowerCase(), val = v.join(":").trim();
        if (key === "user-agent") inStar = val === "*";
        else if (inStar && (key === "disallow" || key === "allow") && val) rules.push({ allow: key === "allow", path: val });
      }
      alloRobots = rules;
    } catch { alloRobots = [{ allow: false, path: "/" }]; }
  }
  const match = alloRobots.filter(r => pathname.startsWith(r.path.replace(/\*.*$/, "")))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return !match || match.allow;
}
async function allocineId(tmdbId) {
  const ext = await tmdb(`/movie/${tmdbId}/external_ids`);
  if (!ext.wikidata_id) return null;
  const r = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${ext.wikidata_id}.json`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const e = (await r.json()).entities?.[ext.wikidata_id];
  return e?.claims?.P1265?.[0]?.mainsnak?.datavalue?.value || null;
}
let lastAllo = 0;
async function allocinePoster(id) {
  const pathname = `/film/fichefilm_gen_cfilm=${id}.html`;
  if (!(await allocineAllowed(pathname))) return null;
  const wait = lastAllo + 3000 - Date.now(); if (wait > 0) await sleep(wait);   // 1 page toutes les 3 s au plus
  lastAllo = Date.now();
  const r = await fetch("https://www.allocine.fr" + pathname, { headers: { "User-Agent": UA, "Accept-Language": "fr-FR" } });
  if (!r.ok) throw new Error(`Allociné ${r.status}`);
  const html = await r.text();
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m || !/acsta\.net\/.*pictures\//.test(m[1]) || /empty|default|placeholder/i.test(m[1])) return null;
  return m[1].replace(/(acsta\.net)\/(?:[a-z]_[^/]+\/)?pictures\//, "$1/c_310_420/pictures/");
}
async function addAllocine(c) {
  try {
    const id = await allocineId(c.tmdb);
    c.allocine = id || null;
    if (id) c.alloPoster = await allocinePoster(id);
    c.alloChecked = Date.now();
  } catch (e) { console.warn(`! Allociné (${c.tmdbTitle}) : ${e.message}`); }
}

/* ---------------- Programme principal ---------------- */
async function readJSON(file, def) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return def; } }

async function main() {
  if (!TMDB_KEY) throw new Error("TMDB_KEY manquant (secret GitHub).");
  const films = toFilms(await fetchSheet());
  console.log(`${films.length} films dans le tableau`);
  const cache = await readJSON(CACHE_FILE, {});
  const overrides = await readJSON(OVERRIDES_FILE, {});
  const now = Date.now(), day = 86400000;

  const todo = [...new Map(films.map(f => [keyOf(f), f])).values()].filter(f => {
    const c = cache[keyOf(f)];
    if (!c) return true;
    if (!c.found) return now - c.t > MISS_RETRY_DAYS * day;
    return now - c.t > REFRESH_DAYS * day;
  });
  console.log(`${todo.length} films à rechercher sur TMDB`);

  let done = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const f = todo[i++];
      try {
        const k = keyOf(f), old = cache[k], fresh = await lookup(f);
        // même film qu'avant : on garde l'affiche Allociné déjà trouvée (pas de nouvelle visite)
        if (old && old.alloChecked && old.tmdb === fresh.tmdb) Object.assign(fresh, { allocine: old.allocine, alloPoster: old.alloPoster, alloChecked: old.alloChecked });
        cache[k] = fresh;
      }
      catch (e) { console.warn(`! ${f.title} : ${e.message}`); }
      if (++done % 25 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  // Allociné : une seule fois par film trouvé, à la suite (pas en parallèle)
  const keys = new Set(films.map(keyOf));
  const alloTodo = Object.entries(cache).filter(([k, c]) => keys.has(k) && c.found && c.tmdb && !c.alloChecked);
  console.log(`${alloTodo.length} films à vérifier sur Allociné`);
  for (const [, c] of alloTodo) await addAllocine(c);
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1) + "\n");

  // données publiées : rien de secret, uniquement ce que la page affiche
  const out = films.map(f => {
    const k = keyOf(f), c = cache[k] || {};
    const manual = f.manual || overrides[k] || overrides[f.title] || "";
    return {
      title: f.title, real: f.real, small: f.small, big: f.big, other: f.other, store: f.store, total: f.total, year: f.year,
      img: manual || c.alloPoster || (c.poster ? "https://image.tmdb.org/t/p/w500" + c.poster : ""),
      src: manual ? "manuel" : c.alloPoster ? "allocine" : c.found ? (c.fr ? "fr" : "vo") : "",
      allocine: c.allocine || null,
      tmdb: c.tmdb || null, pop: c.pop || 0, note: c.note || 0, votes: c.votes || 0,
    };
  });
  const found = out.filter(x => x.img).length, fr = out.filter(x => x.img && x.src !== "vo").length;
  console.log(`Affiches : ${found}/${out.length} trouvées, dont ${fr} françaises ou choisies à la main`);

  const tpl = await readFile(path.join(ROOT, "template/index.html"), "utf8");
  const payload = JSON.stringify({ updated: new Date().toISOString(), films: out }).replace(/</g, "\\u003c");
  await mkdir(path.join(ROOT, "site"), { recursive: true });
  await writeFile(path.join(ROOT, "site/index.html"), tpl.replace("/*__DATA__*/null", payload));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
