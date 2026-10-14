// Small server that talks to YouTube for your site, so the API key stays secret on the server.
// The key is read from the environment variable YOUTUBE_API_KEY (set it in Netlify, never in the code).

const API = "https://www.googleapis.com/youtube/v3/";

const reply = (status, body, cache) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    // Cache good answers so repeated searches don't use up the daily YouTube limit
    ...(cache
      ? {
          "Cache-Control": "public, max-age=1800",
          "Netlify-CDN-Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400",
        }
      : { "Cache-Control": "no-store" }),
  },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

exports.handler = async (event) => {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return reply(500, { error: "YOUTUBE_API_KEY is not set on the server." });
  if (event.httpMethod !== "GET") return reply(405, { error: "GET only." });

  const p = event.queryStringParameters || {};

  // Only two fixed kinds of request are allowed, with checked inputs, so the key cannot be used for anything else.
  const params = new URLSearchParams({ part: "snippet", videoCategoryId: "10", maxResults: "20", key });

  if (p.pageToken) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(p.pageToken)) return reply(400, { error: "Bad pageToken." });
    params.set("pageToken", p.pageToken);
  }

  let endpoint;
  if (p.kind === "search") {
    const q = (p.q || "").trim().slice(0, 100);
    if (!q) return reply(400, { error: "Missing q." });
    params.set("type", "video");
    params.set("videoEmbeddable", "true");
    params.set("q", q);
    endpoint = "search";
  } else if (p.kind === "trending") {
    const region = (p.region || "US").toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) return reply(400, { error: "Bad region." });
    params.set("chart", "mostPopular");
    params.set("regionCode", region);
    endpoint = "videos";
  } else {
    return reply(400, { error: "kind must be search or trending." });
  }

  try {
    const res = await fetch(API + endpoint + "?" + params.toString());
    const text = await res.text();
    return reply(res.status, text, res.ok);
  } catch (e) {
    return reply(502, { error: "Could not reach YouTube." });
  }
};
