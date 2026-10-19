// Looks titles up in the IMDb catalog for the app. IMDb only accepts browser requests from its own sites,
// so the page calls this function and the function calls IMDb.
// Deploy: supabase functions deploy imdb   (or paste this file into Dashboard → Edge Functions → Deploy a new function)
// IMDb permits this for personal, non-commercial use only.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const KINDS: Record<string, "movie" | "series"> = {
  movie: "movie", tvMovie: "movie", short: "movie", video: "movie", tvSpecial: "movie",
  tvSeries: "series", tvMiniSeries: "series",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function search(q: string) {
  const first = /^[a-z0-9]/i.test(q) ? q[0].toLowerCase() : "x";
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(q.toLowerCase())}.json`);
  if (!res.ok) throw new Error(`IMDb search returned ${res.status}`);
  const { d = [] } = await res.json();
  return d
    .filter((x: any) => x.id?.startsWith("tt") && KINDS[x.qid])
    .slice(0, 8)
    .map((x: any) => ({
      imdbId: x.id, title: x.l, year: x.y ?? null, kind: KINDS[x.qid],
      cast: x.s ?? "", poster: x.i?.imageUrl ?? null, rating: null as number | null,
    }));
}

// Scores aren't in the search results; fetch them for all matches in one GraphQL call
async function ratings(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const res = await fetch("https://caching.graphql.imdb.com/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-imdb-client-name": "imdb-web-next" },
    body: JSON.stringify({
      query: "query($ids:[ID!]!){titles(ids:$ids){id ratingsSummary{aggregateRating}}}",
      variables: { ids },
    }),
  });
  if (!res.ok) return {};
  const { data } = await res.json();
  const out: Record<string, number> = {};
  for (const t of data?.titles ?? []) {
    if (t?.ratingsSummary?.aggregateRating != null) out[t.id] = t.ratingsSummary.aggregateRating;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { q } = await req.json().catch(() => ({}));
    const query = String(q ?? "").trim().slice(0, 100);
    if (query.length < 2) return json({ results: [] });
    const results = await search(query);
    // A missing score shouldn't hide the matches
    const scores = await ratings(results.map((r) => r.imdbId)).catch(() => ({} as Record<string, number>));
    for (const r of results) r.rating = scores[r.imdbId] ?? null;
    return json({ results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
