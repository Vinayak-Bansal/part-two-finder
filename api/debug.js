// Private diagnostics endpoint: /api/debug?key=<VERIFY_TOKEN>&u=<username>
// Runs a few Graph API checks with the server's tokens and returns the results (never the tokens).
const { VERIFY_TOKEN, FB_PAGE_TOKEN, IG_BUSINESS_ID, IG_TOKEN } = process.env;

async function call(label, url) {
  try {
    const res = await fetch(url);
    const body = await res.json();
    return { label, status: res.status, body };
  } catch (e) {
    return { label, error: e.message };
  }
}

export async function GET(request) {
  const p = new URL(request.url).searchParams;
  if (![VERIFY_TOKEN, process.env.TEST_KEY].filter(Boolean).includes(p.get("key"))) return new Response("Forbidden", { status: 403 });
  const u = p.get("u") || "instagram";
  const G = "https://graph.facebook.com/v23.0";
  const t = `access_token=${FB_PAGE_TOKEN}`;
  const q = s => encodeURIComponent(s);

  // ?cost=light|heavy&u=<user>&n=5 : compare Meta usage of lightweight vs full lookups
  if (p.get("cost")) {
    const fields = p.get("cost") === "light" ? "caption,timestamp,permalink,media_type" : "id,caption,timestamp,permalink,media_type,media_product_type,thumbnail_url,media_url";
    const out = [];
    for (let i = 0; i < Number(p.get("n") || 5); i++) {
      const t0 = Date.now();
      const r = await fetch(`${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){media.limit(50){${fields}}}`)}&${t}`);
      await r.json();
      out.push({ ms: Date.now() - t0, usage: r.headers.get("x-app-usage") });
    }
    return Response.json({ cost: p.get("cost"), out });
  }
  // ?igbd=<user> : can the Instagram-Login app's token do Business Discovery? (separate rate limit)
  if (p.get("igbd")) {
    const r = await fetch(`https://graph.instagram.com/v23.0/me?fields=${q(`business_discovery.username(${p.get("igbd")}){username,media.limit(3){id,caption,timestamp,media_type,media_url,thumbnail_url,permalink}}`)}&access_token=${process.env.IG_TOKEN}`);
    return Response.json({ status: r.status, usage: r.headers.get("x-app-usage"), body: await r.json() });
  }
  const results = p.get("tag") || p.get("search") || p.get("cost") ? [] : await Promise.all([
    call("token scopes", `${G}/debug_token?input_token=${FB_PAGE_TOKEN}&${t}`),
    call("page me", `${G}/me?fields=id,name&${t}`),
    call("ig account", `${G}/${IG_BUSINESS_ID}?fields=id,username&${t}`),
    call("page's ig link", `${G}/me?fields=instagram_business_account&${t}`),
    call("bd basic", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){id,username,followers_count,media_count}`)}&${t}`),
    call("bd media", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){media.limit(3){id,caption,timestamp,permalink,media_type}}`)}&${t}`),
    call("ig-login token bd", `https://graph.instagram.com/v23.0/me?fields=${q(`business_discovery.username(${u}){id,username}`)}&access_token=${IG_TOKEN}`),
    ...(p.get("ut") ? [
      call("bd with user token", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){id,username,followers_count}`)}&access_token=${p.get("ut")}`),
      call("user token perms", `${G}/me/permissions?access_token=${p.get("ut")}`),
    ] : []),
  ]);
  // Optional: check each Gemini model responds (?gemini=1)
  if (p.get("gemini")) {
    const out = {};
    for (const m of ["gemini-flash-latest", "gemini-3.8-flash", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-pro-latest"]) {
      const t0 = Date.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word ok" }] }] }),
        });
        const b = await r.json();
        out[m] = { status: r.status, ms: Date.now() - t0, text: b.candidates?.[0]?.content?.parts?.[0]?.text?.trim(), error: b.error?.message?.slice(0, 120) };
      } catch (e) { out[m] = { error: e.message }; }
    }
    return Response.json(out);
  }
  // Optional: discover creators via hashtag (?tag=part2) -> recent + top media, with creator usernames
  if (p.get("tag")) {
    const hs = await call("hashtag", `${G}/ig_hashtag_search?user_id=${IG_BUSINESS_ID}&q=${encodeURIComponent(p.get("tag"))}&${t}`);
    const hid = hs.body?.data?.[0]?.id;
    if (!hid) return Response.json({ error: hs.body });
    const fields = "id,caption,permalink,timestamp,media_type";
    const [recent, top] = await Promise.all([
      call("recent", `${G}/${hid}/recent_media?user_id=${IG_BUSINESS_ID}&fields=${fields}&limit=${p.get("limit") || 25}&${t}`),
      call("top", `${G}/${hid}/top_media?user_id=${IG_BUSINESS_ID}&fields=${fields}&limit=${p.get("limit") || 25}&${t}`),
    ]);
    const items = [...(recent.body?.data || []), ...(top.body?.data || [])].filter(m => m.media_type === "VIDEO");
    const { getCreator } = await import("./webhook.js");
    const out = [];
    for (let i = 0; i < items.length; i += 8) {
      out.push(...await Promise.all(items.slice(i, i + 8).map(async m => {
        const c = await getCreator(m.permalink).catch(() => null);
        return { user: c?.username || null, link: m.permalink, caption: (m.caption || "").slice(0, 80) };
      })));
    }
    return Response.json({ tag: p.get("tag"), errors: [recent.body?.error, top.body?.error].filter(Boolean), count: out.length, items: out });
  }
  // Optional: inspect a reel page for a video URL (?reel=SHORTCODE)
  if (p.get("reel")) {
    const out = {};
    for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"]) {
      for (const path of [`reel/${p.get("reel")}/`, `reel/${p.get("reel")}/embed/`]) {
        try {
          const r = await fetch(`https://www.instagram.com/${path}`, { headers: { "User-Agent": ua } });
          const h = await r.text();
          out[`${ua.slice(0, 12)} ${path}`] = {
            status: r.status, bytes: h.length,
            ogVideo: h.match(/property="og:video(?::secure_url)?" content="([^"]+)"/)?.[1]?.slice(0, 120) || null,
            videoUrl: (h.match(/\\?"video_url\\?":\\?"([^"\\]+)/)?.[1] || null)?.slice(0, 120),
            mp4: (h.match(/https:[^"'\s]+?\.mp4[^"'\s]*/)?.[0] || null)?.slice(0, 120),
          };
        } catch (e) { out[path] = e.message; }
      }
    }
    return Response.json(out);
  }
  // Optional: search a creator's last ~200 posts for a word (?search=pixel)
  if (p.get("search")) {
    const term = p.get("search").toLowerCase();
    const hits = [];
    let after = null;
    for (let i = 0; i < 4; i++) {
      const media = `media${after ? `.after(${after})` : ""}.limit(50){caption,timestamp,permalink}`;
      const r = await call("page", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){${media}}`)}&${t}`);
      const m = r.body?.business_discovery?.media;
      for (const it of m?.data || []) if ((it.caption || "").toLowerCase().includes(term)) hits.push({ date: it.timestamp, link: it.permalink, caption: (it.caption || "").slice(0, 120) });
      after = m?.paging?.cursors?.after;
      if (!after) break;
    }
    return Response.json({ search: term, hits });
  }
  return Response.json({ hasPageToken: !!FB_PAGE_TOKEN, igBusinessId: IG_BUSINESS_ID, results });
}
