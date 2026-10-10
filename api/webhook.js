import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";

const GRAPH = "https://graph.instagram.com/v23.0";
const { VERIFY_TOKEN, IG_TOKEN, APP_SECRET, GEMINI_API_KEY } = process.env;
const { FB_PAGE_TOKEN, IG_BUSINESS_ID } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

// ---------- Memory (Upstash Redis via Vercel) ----------
// Remembers answers per reel, creators' post lists for a few hours, and a log of every result.
// If the database isn't set up or is down, everything still works, just without memory.
const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
export async function redis(...cmd) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return null;
  try {
    const res = await fetch(KV_REST_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    if (body.error) { console.log("Redis error:", body.error); return null; }
    return body.result;
  } catch (e) {
    console.log("Redis unavailable:", e.message);
    return null;
  }
}
const getJSON = async key => { const v = await redis("GET", key); try { return v ? JSON.parse(v) : null; } catch { return null; } };
const setJSON = (key, value, ttlSec) => redis("SET", key, JSON.stringify(value), "EX", String(ttlSec));

// Meta calls this once when you click "Verify and save"
export function GET(request) {
  const p = new URL(request.url).searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === VERIFY_TOKEN) {
    return new Response(p.get("hub.challenge"), { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// Meta sends every DM here
export async function POST(request) {
  const raw = await request.text();

  // Make sure the request really came from Meta
  const sig = request.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return new Response("Bad signature", { status: 401 });
  }

  const body = JSON.parse(raw);
  // Reply 200 to Meta right away (it retries slow webhooks, causing double replies); work continues in background
  waitUntil(handleEvents(body).catch(e => console.log("Handler error:", e.message)));
  return new Response("EVENT_RECEIVED", { status: 200 });
}


async function handleEvents(body) {
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;
      if (!msg || msg.is_echo) continue; // skip the bot's own replies

      const senderId = event.sender.id;
      const reel = (msg.attachments || []).find(a => a.type === "ig_reel" || a.type === "share");

      const reply = reel
        ? await buildReply(reel.payload, () => sendText(senderId, "Looking for part 2..."))
        : "Send me a reel and I'll find part 2.";
      await sendText(senderId, reply);
    }
  }
}

// The reply for a shared reel (exported so the test endpoint can check the exact DM text)
// How long to remember each kind of answer (seconds). Unsure answers aren't remembered long,
// because part 2 may come out later.
const ANSWER_TTL = { found: 180 * 86400, personal: 86400, too_old: 86400, not_out: 1800, no_match: 3600 };

export async function buildReply(payload, onSlow) {
  const t0 = Date.now();
  console.log("Reel received:", JSON.stringify(payload));
  const code = payload.url?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  let answer = code ? await getJSON(`ans:${code}`) : null;
  if (answer) {
    console.log("Remembered answer:", JSON.stringify(answer));
  } else {
    const info = await getCreator(payload.url); // { username, postedAt }
    console.log("Creator:", JSON.stringify(info));
    if (!info?.username) {
      await logResult({ code, result: "no_creator", ms: Date.now() - t0 });
      return "Couldn't open this reel (it might be age-restricted or private). Try a different one.";
    }
    const { post, reason } = await findPartTwo(payload, info, onSlow);
    answer = { user: info.username, post: post?.shortcode || null, reason: post ? "found" : reason };
    const ttl = ANSWER_TTL[answer.reason];
    if (code && ttl) await setJSON(`ans:${code}`, answer, ttl);
  }
  console.log("Result:", answer.post || answer.reason);
  await logResult({ code, user: answer.user, result: answer.reason, post: answer.post, ms: Date.now() - t0 });
  return replyText(answer.user, answer.post, answer.reason);
}

// Keep the last 5,000 results so we can see how the bot is doing
async function logResult(entry) {
  await redis("LPUSH", "log", JSON.stringify({ t: new Date().toISOString(), ...entry }));
  await redis("LTRIM", "log", "0", "4999");
}

function replyText(username, post, reason) {
  const u = `@${username}`;
  if (post) return `Here's part 2: https://www.instagram.com/reel/${post}/`;
  return {
    personal: `${u} is a personal account, so I can't see their other reels. Check their page for part 2.`,
    not_out: `${u} hasn't posted anything since this reel, so part 2 isn't out yet.`,
    ai_down: `I'm a bit overloaded right now. Send the reel again in a minute.`,
    busy: `I'm getting a lot of requests right now. Send the reel again in a few minutes.`,
    too_old: `${u} posts so much that this reel is too far back for me to search. Check their page for part 2.`,
  }[reason] || `Couldn't find part 2 yet. Check ${u}'s page, it might not be out yet.`;
}

// ---------- Part 2 finder ----------

// Get a creator's posts, newest first. Uses Meta's official Business Discovery API when set up,
// otherwise the public web endpoint (often blocked from servers).
// Short in-memory cache (per warm server instance) so repeat reels from the same creator
// don't burn Business Discovery calls (Meta rate-limits them per hour).
const postCache = new Map(); // username -> { at, sinceMs, result }
const CACHE_MS = 10 * 60 * 1000;

export async function getRecentPosts(username, sinceMs) {
  const key = username.toLowerCase();
  const hit = postCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && (!sinceMs || !hit.sinceMs || hit.sinceMs <= sinceMs)) {
    console.log(`Post cache hit for @${username}`);
    return hit.result;
  }
  const saved = await getJSON(`posts:${key}`);
  if (saved && (!sinceMs || !saved.sinceMs || saved.sinceMs <= sinceMs)) {
    console.log(`Saved post list hit for @${username}`);
    postCache.set(key, { at: Date.now(), sinceMs: saved.sinceMs, result: saved.result });
    return saved.result;
  }
  let result;
  if (FB_PAGE_TOKEN && IG_BUSINESS_ID) {
    const posts = await businessDiscovery(username, sinceMs);
    if (posts === "not_found") result = { posts: [], personal: true };
    else if (posts === "rate_limited") return { posts: [], busy: true };
    else if (posts) result = { posts };
  }
  if (!result) result = { posts: await webProfilePosts(username) };
  if (result.personal || result.posts.length) {
    postCache.set(key, { at: Date.now(), sinceMs, result });
    if (postCache.size > 200) postCache.delete(postCache.keys().next().value);
    // Save for other server instances too: personal accounts for a day, post lists for 3 hours
    // (video links from Instagram expire, so post lists can't be kept much longer)
    // The database takes up to ~1MB per entry: trim captions, and drop the oldest posts if still too big
    let posts = result.posts.map(p => ({ ...p, caption: p.caption.slice(0, 300) }));
    while (posts.length && JSON.stringify(posts).length > 900000) posts = posts.slice(Math.ceil(posts.length * 0.2));
    const keptSince = posts.length < result.posts.length ? posts[0]?.takenAt : sinceMs;
    await setJSON(`posts:${key}`, { sinceMs: keptSince, result: { ...result, posts } }, result.personal ? 86400 : 3 * 3600);
  }
  return result;
}

const BD_FIELDS_FULL = "id,caption,timestamp,permalink,media_type,media_product_type,thumbnail_url,media_url";
const BD_FIELDS_MIN = "id,caption,timestamp,permalink,media_type,media_url";

let lastUsage = null;
async function businessDiscovery(username, sinceMs) {
  const all = [];
  let after = null;
  let fields = BD_FIELDS_FULL;
  // Page back until we pass the original reel's date (max 25 + 2×500 posts)
  // Meta counts calls, not posts: one big page is far cheaper than many small ones.
  // First a small page (most reels people send are recent), then up to 2 pages of 500.
  let big = 500;
  for (let page = 0; page < 3; page++) {
    // Small first page (most reels people send are recent); bigger pages only if we need to go back further.
    // Meta rate-limits this API by call count AND processing time, so don't over-fetch.
    const media = `media${after ? `.after(${after})` : ""}.limit(${page ? big : 25}){${fields}}`;
    const url =
      `https://graph.facebook.com/v23.0/${IG_BUSINESS_ID}` +
      `?fields=${encodeURIComponent(`business_discovery.username(${username}){${media}}`)}` +
      `&access_token=${FB_PAGE_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();
    lastUsage = res.headers.get("x-app-usage");
    if (data.error) {
      // Retry once with fewer fields in case some aren't allowed
      if (page && big > 100 && /reduce the amount of data/i.test(data.error.message || "")) {
        console.log("Business Discovery: page too big, retrying with 100");
        big = 100;
        page--;
        continue;
      }
      if (fields === BD_FIELDS_FULL && data.error.code === 100) {
        console.log("Business Discovery: retrying with fewer fields:", data.error.message);
        fields = BD_FIELDS_MIN;
        page--;
        continue;
      }
      console.log("Business Discovery failed:", JSON.stringify(data.error).slice(0, 300),
        "usage:", res.headers.get("x-app-usage"), res.headers.get("x-business-use-case-usage")?.slice(0, 300));
      if (data.error.code === 110) return "not_found"; // personal (non-creator) account
      // Token blocked/expired (e.g. Facebook security checkpoint on the account): we can't look anything up
      if (data.error.code === 190) { console.error("FB TOKEN PROBLEM - log in to facebook.com:", data.error.message); return "rate_limited"; }
      // Rate limited. A partial list that doesn't reach back to the sent reel gives wrong answers, so
      // only use it if it already covers that far.
      if ([4, 17, 32, 613].includes(data.error.code)) {
        const oldest = all.length ? Math.min(...all.map(x => x.takenAt)) : null;
        return oldest && sinceMs && oldest <= sinceMs ? all.sort((a, b) => a.takenAt - b.takenAt) : "rate_limited";
      }
      return all.length ? all : null;
    }
    const m = data.business_discovery?.media;
    for (const item of m?.data || []) {
      all.push({
        shortcode: item.permalink?.match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/)?.[1] || item.id,
        takenAt: Date.parse(item.timestamp),
        caption: item.caption || "",
        isVideo: item.media_type === "VIDEO",
        thumb: item.thumbnail_url || (item.media_type === "IMAGE" ? item.media_url : null),
        video: item.media_type === "VIDEO" ? item.media_url : null,
      });
    }
    after = m?.paging?.cursors?.after;
    const oldest = all[all.length - 1]?.takenAt;
    if (!after || !sinceMs || (oldest && oldest < sinceMs)) break;
  }
  console.log(`Business Discovery: ${all.length} posts for @${username}`, "usage:", lastUsage);
  return all.sort((a, b) => a.takenAt - b.takenAt); // oldest → newest
}

// Public web endpoint (no login; ~12 latest). Instagram often blocks this from servers.
async function webProfilePosts(username) {
  const res = await fetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    { headers: { "User-Agent": BROWSER_UA, "x-ig-app-id": "936619743392459", "Accept-Language": "en-US,en" } }
  );
  if (!res.ok) {
    console.log("Profile fetch failed:", res.status, (await res.text()).slice(0, 200));
    return [];
  }
  const user = (await res.json())?.data?.user;
  const edges = [
    ...(user?.edge_owner_to_timeline_media?.edges || []),
    ...(user?.edge_felix_video_timeline?.edges || []),
  ];
  const seen = new Set();
  const posts = [];
  for (const { node } of edges) {
    if (!node?.shortcode || seen.has(node.shortcode)) continue;
    seen.add(node.shortcode);
    posts.push({
      shortcode: node.shortcode,
      takenAt: node.taken_at_timestamp * 1000,
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || "",
      isVideo: !!node.is_video,
      thumb: node.thumbnail_src || node.display_url || null,
    });
  }
  console.log(`Got ${posts.length} posts for @${username}`);
  return posts.sort((a, b) => a.takenAt - b.takenAt);
}

// Detect "part 3", "pt.3", "p3", "3/5" → 3
const NUMW = "\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|dos|tres|dois|três";
const LABEL = "part|pt|parte|episode|episodio|episódio|ep|chapter|cap[ií]tulo|भाग";
// "Follow for part 2", "Part 2 coming soon", "Comment PART 2" -> this reel is the part BEFORE that number
const TEASER = new RegExp(
  `(?:follow|wait|comment|like|subscribe|stay tuned|want)\\s+(?:for\\s+|to\\s+see\\s+)?(?:the\\s+)?(?:[A-Za-z"]+\\s+){0,2}\\(?(?:${LABEL})\\.?\\s*(${NUMW})\\b` +
  `|\\b(?:${LABEL})\\.?\\s*(${NUMW})\\s*(?:coming|soon|tomorrow|next|dekhne|के\\s*लिए|ke\\s*liye|loading)`, "i");
const MAIN = new RegExp(`(?:^|[^\\p{L}])(?:${LABEL})\\.?\\s*[-#:|]?\\s*(${NUMW})\\b|\\bp(\\d{1,2})\\b|\\b(\\d{1,2})\\s*\\/\\s*(\\d{1,2})\\b(?!\\s*(?:cups?|tsp|tbsp|oz|lb|kg|g)\\b)`, "iu");
const NUMV = { one: 1, two: 2, dos: 2, dois: 2, three: 3, tres: 3, "três": 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = v => NUMV[v.toLowerCase()] ?? parseInt(v, 10);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function shortcodeTime(code) {
  if (!code || !/^[A-Za-z0-9_-]{6,12}$/.test(code)) return null;
  try {
    const id = [...code].reduce((n, c) => n * 64n + BigInt(B64.indexOf(c)), 0n);
    const t = Number(id >> 23n) + 1314220021721; // Instagram's ID epoch
    return t > 1.3e12 && t < Date.now() + 864e5 ? t : null;
  } catch { return null; }
}

export function stripPart(text) {
  return (text || "")
    .replace(new RegExp(TEASER.source, "giu"), " ")
    .replace(new RegExp(`(?:${LABEL})\\.?\\s*[-#:|]?\\s*(?:${NUMW})\\b`, "giu"), " ")
    .replace(/\bp\d{1,2}\b|\b\d{1,2}\s*\/\s*\d{1,3}\b/gi, " ")
    .replace(/\s+/g, " ").trim();
}

export function partNumber(text) {
  text = text || "";
  const teaser = text.match(TEASER);
  const rest = teaser ? text.replace(new RegExp(TEASER.source, "giu"), " ") : text;
  // "Part 2 - Episode 6": the episode number is the running count
  const ep = rest.match(new RegExp(`\\b(?:episode|episodio|episódio|ep)\\.?\\s*[-#:]?\\s*(${NUMW})\\b`, "iu"));
  if (ep) return toNum(ep[1]);
  const m = rest.match(MAIN);
  // "1/3" counts as a part only if it looks like a series count (not "24/7" or a "3/10" rating)
  if (m && m[3] && !(+m[3] <= +m[4] && +m[4] >= 2 && +m[4] <= 30 && +m[4] !== 10)) return teaserNum(teaser);
  if (m) return toNum(m[1] || m[2] || m[3]);
  return teaserNum(teaser);
}
function teaserNum(teaser) {
  if (!teaser) return null;
  const n = toNum(teaser[1] || teaser[2]);
  return n > 1 ? n - 1 : null;
}

function words(text) {
  text = text.replace(/[#@][\p{L}\p{N}_.]+/gu, " "); // hashtags/mentions are shared by every post
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !w.startsWith("http")));
}
export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

// Similarity that ignores a creator's boilerplate: words that show up in lots of their captions
// ("FIRST AMENDMENT AUDIT", "follow for more", channel names) count for little; distinctive words
// (story titles, names, places) count for a lot. Part labels are ignored.
export function creatorSimilarity(posts) {
  const docs = posts.map(p => words(stripPart(p.caption)));
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const N = Math.max(docs.length, 1);
  const idf = w => Math.log((N + 1) / ((df.get(w) || 0) + 0.5));
  return (a, b) => {
    const A = words(stripPart(a)), B = words(stripPart(b));
    if (!A.size || !B.size) return 0;
    let hit = 0, sa = 0, sb = 0;
    for (const w of A) { sa += idf(w); if (B.has(w)) hit += idf(w); }
    for (const w of B) sb += idf(w);
    return hit / Math.min(sa, sb);
  };
}

export async function findPartTwo(payload, info, onSlow) {
  const trace = [];
  const r = await findPartTwoInner(payload, info, onSlow, trace);
  console.log("Trace:", trace.join(" | "));
  return { ...r, trace };
}

async function findPartTwoInner(payload, info, onSlow, trace) {
  const code = payload.url?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  let caption = payload.title || "";
  // Instagram shortcodes encode the post time, so we know when the sent reel was posted even if
  // the page didn't say.
  const postedAt = shortcodeTime(code) || info.postedAt;
  let { posts, personal, busy } = await getRecentPosts(info.username, postedAt);
  if (busy) return { reason: "busy" };
  // Benchmark "blind" mode: hide "part N" labels from captions so the bot must use covers/video
  if (info.blind) {
    posts = posts.map(p => ({ ...p, caption: stripPart(p.caption) }));
    caption = stripPart(caption);
  }
  if (personal) return { reason: "personal" };
  if (!posts.length) return { reason: "no_posts" };

  // When was the original posted? Use the list if it's there, else the date from the page.
  const original = posts.find(p => p.shortcode === code);
  if (!caption && original?.caption) caption = original.caption;
  const after = original?.takenAt ?? postedAt ?? 0;
  const candidates = posts.filter(p => p.shortcode !== code && p.takenAt > after);
  trace.push(`${posts.length} posts, ${candidates.length} after sent reel, original ${original ? "found" : "missing"}${original?.video ? " +video" : ""}`);
  if (!candidates.length) return { reason: "not_out" };

  // If the reel you sent is part N, look for part N+1 (default: part 1 → find part 2)
  const sentPart = partNumber(caption);
  const want = (sentPart || 1) + 1;
  trace.push(`sentPart=${sentPart} want=${want}`);

  // 1) Fast path, only when it's unambiguous: the sent reel says "part N" (or captions nearly match)
  //    AND exactly one later post says "part N+1". Otherwise let the AI verify.
  const wsim = creatorSimilarity(posts);
  const labeled = [];
  for (const p of candidates) {
    const sim = wsim(caption, p.caption);
    const n = partNumber(p.caption);
    const ok = n === want && ((sentPart && sim >= 0.2) || sim >= 0.5);
    if ((n !== null || sim >= 0.5) && trace.length < 14) trace.push(`cand ${p.shortcode} part=${n} sim=${sim.toFixed(2)}${ok ? " OK" : ""}`);
    if (ok) labeled.push(p);
  }
  // One labeled match whose caption clearly shares the story's distinctive words: take it.
  // A weaker one still goes first in line for the AI to verify.
  if (labeled.length === 1 && wsim(caption, labeled[0].caption) >= 0.35) {
    trace.push("fast path");
    return { post: labeled[0] };
  }
  if (labeled.length > 1) {
    // Template captions make similarity useless when a creator runs many series ("Part 2" every day).
    // Structure is more reliable: the first "part N+1" after the sent reel, before the creator starts
    // a new series (another "part 1"/"part N"), is the one.
    const byTime = [...candidates].sort((a, b) => a.takenAt - b.takenAt);
    const boundary = sentPart ? byTime.find(p => { const n = partNumber(p.caption); return n !== null && n <= sentPart; }) : null;
    const first = [...labeled].sort((a, b) => a.takenAt - b.takenAt)[0];
    if (boundary && first.takenAt < boundary.takenAt && wsim(caption, first.caption) >= 0.3) {
      trace.push(`fast path (first before new series ${boundary.shortcode})`);
      return { post: first };
    }
    const ranked = labeled.map(p => ({ p, sim: wsim(caption, p.caption) })).sort((a, b) => b.sim - a.sim);
    if (ranked[0].sim - ranked[1].sim >= 0.2) {
      trace.push("fast path (closest)");
      return { post: ranked[0].p };
    }
  }

  // 2) AI path: Gemini looks at covers + captions (part-labeled posts first, then nearest in time)
  if (!GEMINI_API_KEY) return { reason: "no_match" };
  await onSlow?.();
  // Order for the AI: part-labeled first, then the most similar captions, then nearest in time
  const bySim = candidates.filter(c => !labeled.includes(c))
    .map(c => ({ c, sim: wsim(caption, c.caption) }))
    .sort((a, b) => b.sim - a.sim).slice(0, 10).map(x => x.c);
  const ordered = [...new Set([...labeled, ...bySim, ...candidates])].slice(0, 20);
  // Captions like "Man" / "Smh" carry no info → go straight to watching the videos
  const vagueCaption = words(caption).size < 4;
  let ai = null;
  // (if we can't watch the video, covers are all we have, so use them anyway)
  if (!vagueCaption || !original?.video) {
    ai = await askGemini({ caption, thumb: original?.thumb || info.thumb }, ordered, want);
    trace.push(`covers: ${ai === "down" ? "down" : ai?.shortcode || "none"}`);
    if (ai && ai !== "down") return { post: preferEarlier(ai, candidates, caption) };
  }
  // Video pass: watch the sent reel + the next few reels the creator posted
  if (!original?.video) console.log(`No video URL for the sent reel (original ${original ? "found" : "not in list"})`);
  if (original?.video) {
    const nearest = [...candidates].sort((a, b) => a.takenAt - b.takenAt);
    const withVid = candidates.filter(c => c.video).length;
    console.log(`Video pass pool: ${withVid}/${candidates.length} candidates have a video URL; sent reel video: ${!!original.video}`);
    const pool = [...new Set([...labeled, ...nearest])].filter(c => c.video).slice(0, 6);
    const vid = await askGeminiVideo({ caption, video: original.video }, pool, want);
    trace.push(`video(${pool.length}): ${vid === "down" ? "down" : vid?.shortcode || "none"}`);
    if (vid && vid !== "down") return { post: preferEarlier(vid, candidates, caption) };
    if (vid === "down" && (ai === "down" || vagueCaption)) return { reason: "ai_down" };
    // Covers were skipped (vague caption) and the videos didn't settle it: covers are the last try
    if (vagueCaption && ai === null) {
      const last = await askGemini({ caption, thumb: original?.thumb || info.thumb }, ordered, want);
      trace.push(`covers (last try): ${last === "down" ? "down" : last?.shortcode || "none"}`);
      if (last && last !== "down") return { post: preferEarlier(last, candidates, caption) };
    }
  } else if (ai === "down") {
    return { reason: "ai_down" };
  }
  // We never got back as far as the sent reel (creator posts a lot): say so instead of a vague "not found"
  const oldest = posts.length ? Math.min(...posts.map(p => p.takenAt)) : 0;
  if (!original && postedAt && oldest > postedAt) return { reason: "too_old" };
  return { reason: "no_match" };
}

// Download an image and return it base64-encoded for Gemini
async function imagePart(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { inline_data: { mime_type: res.headers.get("content-type")?.split(";")[0] || "image/jpeg", data: buf.toString("base64") } };
  } catch {
    return null;
  }
}

const RULES = want =>
  `Decide which reel(s), if any, continue the SAME series/story as the sent reel (i.e. are part ${want} or its direct follow-up).\n` +
  `Signals: on-screen text like "Part ${want}"/"pt ${want}", the same people/characters/outfits/setting, the same specific subject, ` +
  `a recap of the sent reel, or the payoff of a cliffhanger ("wait until the end", "follow for part 2", "I'm going to try this" → later result/update/reveal).\n` +
  `Many follow-ups are NOT labeled "part ${want}". A different topic is NOT a match even if it says "part ${want}".\n` +
  `Creators sometimes post parts out of order, so if a candidate explicitly shows or says "part ${want}" (cover, on-screen text or audio), that one wins over dates.\n` +
  `Reply ONLY with JSON: {"labeled": <candidate number explicitly marked part ${want}, or null>, "matches": [<candidate numbers that continue it, or empty>], "confidence": <0-1>, "reason": "<short>"}`;

// Call Gemini with fallbacks; returns parsed JSON, or "down" if every model failed
async function callGemini(parts, timeoutMs = 20000) {
  const models = [...new Set([GEMINI_MODEL, "gemini-flash-latest", "gemini-3.8-flash", "gemini-flash-lite-latest"])];
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      });
      const body = await res.json();
      if (res.ok) {
        console.log("Gemini model used:", model);
        const text = body.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      }
      console.log(`Gemini error (${model}):`, res.status, JSON.stringify(body).slice(0, 200));
      if (![429, 500, 503, 404].includes(res.status)) return null;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.log(`Gemini call failed (${model}):`, e.message);
    }
  }
  return "down";
}

// If an EARLIER post covers the same subject about as closely as the AI's pick, that earlier one is the real part 2
function preferEarlier(pick, candidates, caption) {
  if (pick.explicit) return pick;
  const pickSim = similarity(caption, pick.caption);
  const earlier = candidates
    .filter(c => c.takenAt < pick.takenAt)
    .map(c => ({ c, sim: similarity(caption, c.caption) }))
    .filter(x => x.sim >= 0.5 && x.sim >= pickSim - 0.1)
    .sort((a, b) => a.c.takenAt - b.c.takenAt)[0];
  if (earlier) console.log(`Preferring earlier ${earlier.c.shortcode} (sim ${earlier.sim.toFixed(2)}) over ${pick.shortcode} (sim ${pickSim.toFixed(2)})`);
  return earlier ? earlier.c : pick;
}

// From Gemini's list of matches, return the EARLIEST one (the real part 2, not a later recap)
function pickEarliest(out, candidates, label) {
  if (!out || out === "down") return out;
  console.log(`Gemini (${label}) says:`, JSON.stringify(out));
  const lab = Number(out.labeled);
  if (Number.isInteger(lab) && lab >= 1 && lab <= candidates.length) {
    return { ...candidates[lab - 1], explicit: true }; // explicitly marked as the next part
  }
  const nums = (Array.isArray(out.matches) ? out.matches : [out.match]).map(Number)
    .filter(i => Number.isInteger(i) && i >= 1 && i <= candidates.length);
  if (!nums.length || (out.confidence ?? 1) < 0.6) return null;
  return nums.map(i => candidates[i - 1]).sort((a, b) => a.takenAt - b.takenAt)[0];
}

// Pass 1: covers + captions (fast)
async function askGemini(sent, candidates, want) {
  const [sentImg, ...candImgs] = await Promise.all([sent.thumb, ...candidates.map(c => c.thumb)].map(imagePart));
  const parts = [
    { text: `You help people find the next part of an Instagram reel series.\nThe user sent a reel. Below are reels the same creator posted AFTER it (cover image + caption).\n` + RULES(want) },
    { text: `SENT REEL. Caption: ${JSON.stringify(sent.caption.slice(0, 500))}` },
  ];
  if (sentImg) parts.push(sentImg);
  candidates.forEach((c, i) => {
    const date = new Date(c.takenAt).toISOString().slice(0, 10);
    parts.push({ text: `CANDIDATE ${i + 1} (posted ${date}). Caption: ${JSON.stringify(c.caption.slice(0, 300))}` });
    if (candImgs[i]) parts.push(candImgs[i]);
  });
  // ~20 cover images take the full model a while; a short timeout pushed us onto the weaker "lite" model
  return pickEarliest(await callGemini(parts, 45000), candidates, "covers");
}

// Download a video and upload it to Gemini's Files API (inline requests cap at ~20MB; reels are ~8-11MB each)
const GFILES = "https://generativelanguage.googleapis.com";
async function videoPart(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    // Stream the video straight through to Gemini when we know its size (keeps memory low);
    // otherwise buffer it.
    let len = Number(res.headers.get("content-length")) || 0;
    let body = res.body;
    if (!len) { body = Buffer.from(await res.arrayBuffer()); len = body.length; }
    if (len > 100e6) { res.body?.cancel?.(); return null; }
    const buf = { length: len };
    // 1) start a resumable upload
    const start = await fetch(`${GFILES}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(buf.length),
        "X-Goog-Upload-Header-Content-Type": "video/mp4",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "reel" } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) { console.log("Files API start failed:", start.status, (await start.text()).slice(0, 150)); return null; }
    // 2) send the bytes
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(len) },
      body,
      duplex: "half",
    });
    let file = (await up.json())?.file;
    if (!file?.uri) { console.log("Files API upload failed:", up.status); return null; }
    // 3) wait until Gemini has processed the video
    for (let i = 0; i < 30 && file.state === "PROCESSING"; i++) {
      await new Promise(r => setTimeout(r, 1000));
      file = await (await fetch(`${GFILES}/v1beta/${file.name}`, { headers: { "x-goog-api-key": GEMINI_API_KEY } })).json();
    }
    if (file.state !== "ACTIVE") { console.log("Video not ready:", file.state); return null; }
    return { bytes: buf.length, part: { file_data: { mime_type: file.mimeType || "video/mp4", file_uri: file.uri } } };
  } catch (e) {
    console.log("videoPart error:", e.message);
    return null;
  }
}

async function askGeminiVideo(sent, candidates, want) {
  const t0 = Date.now();
  const urls = [sent.video, ...candidates.map(c => c.video)];
  const got = new Array(urls.length);
  let next = 0;
  await Promise.all([0, 1, 2].map(async () => { while (next < urls.length) { const i = next++; got[i] = await videoPart(urls[i]); } }));
  const [sentVid, ...candVids] = got;
  if (!sentVid) { console.log("Video pass: couldn't download the sent reel"); return null; }
  const kept = [];
  candidates.forEach((c, i) => { if (candVids[i]) kept.push({ c, v: candVids[i] }); });
  const sizes = candVids.map((v, i) => candidates[i].video ? (v ? Math.round(v.bytes / 1e5) / 10 + "MB" : "failed") : "no-url");
  console.log(`Video pass: watching sent reel (${Math.round(sentVid.bytes / 1e5) / 10}MB) + ${kept.length}/${candidates.length} candidates [${sizes.join(", ")}] (downloads ${Date.now() - t0}ms)`);
  if (!kept.length) return null;
  const parts = [
    { text: `You help people find the next part of an Instagram reel series. WATCH and LISTEN to each video ` +
            `(on-screen text, spoken words, people, setting, storyline).\nThe user sent the first video. The others were posted AFTER it by the same creator.\n` + RULES(want) },
    { text: `SENT REEL. Caption: ${JSON.stringify(sent.caption.slice(0, 300))}` },
    sentVid.part,
  ];
  kept.forEach(({ c, v }, i) => {
    const date = new Date(c.takenAt).toISOString().slice(0, 10);
    parts.push({ text: `CANDIDATE ${i + 1} (posted ${date}). Caption: ${JSON.stringify(c.caption.slice(0, 200))}` });
    parts.push(v.part);
  });
  const out = await callGemini(parts, 60000);
  console.log(`Video pass took ${Date.now() - t0}ms`);
  return pickEarliest(out, kept.map(k => k.c), "video");
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
// Link-preview bots get simple pages with og: tags (that's how iMessage shows "username on Instagram")
const BOT_UAS = ["facebookexternalhit/1.1", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0"];

const U = "([A-Za-z0-9._]{1,30})";
const PATTERNS = [
  // og:description: "123 likes, 4 comments - username on October 1, 2026: ..."
  new RegExp(`comments? - ${U} on [A-Z][a-z]+ \\d`),
  new RegExp(`likes?, \\d[\\d,.KM]* comments? - ${U}`),
  new RegExp(`og:description" content="${U} on [A-Z][a-z]+ \\d{1,2}, \\d{4}`),
  new RegExp(`content="${U} on [A-Z][a-z]+ \\d{1,2}, \\d{4}[^"]*" property="og:description`),
  // og:title / title: "Name (@username) • Instagram" or "@username on Instagram"
  new RegExp(`\\(@${U}\\)`),
  new RegExp(`@${U} on Instagram`),
  // embed page
  new RegExp(`class="UsernameText"[^>]*>${U}<`),
  new RegExp(`instagram\\.com/${U}/?\\?utm_source=ig_embed`),
  // JSON blobs (plain or escaped): owner first, then any username
  new RegExp(`\\\\?"owner\\\\?":\\{[^}]*?\\\\?"username\\\\?":\\\\?"${U}`),
  new RegExp(`\\\\?"username\\\\?":\\\\?"${U}\\\\?"`),
];

// Find the creator's username from the reel's public pages (free, no API)
// Instagram sometimes refuses page fetches for a moment, so try a few rounds before giving up
export async function getCreator(url) {
  for (let round = 0; round < 3; round++) {
    const info = await getCreatorOnce(url);
    if (info?.username || !url) return info;
    console.log(`Creator lookup round ${round + 1} failed, retrying`);
    await new Promise(r => setTimeout(r, 1500 * (round + 1)));
  }
  return null;
}

async function getCreatorOnce(url) {
  const code = url?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (!code) return null;

  const tries = [
    ...BOT_UAS.map(ua => ({ name: `page/${ua.split("/")[0]}`, url: `https://www.instagram.com/reel/${code}/`, ua })),
    { name: "embed", url: `https://www.instagram.com/reel/${code}/embed/captioned/`, ua: BROWSER_UA },
    { name: "page/browser", url: `https://www.instagram.com/reel/${code}/`, ua: BROWSER_UA },
  ];

  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: { "User-Agent": t.ua, "Accept-Language": "en-US,en" } });
      const html = await res.text();
      for (const p of PATTERNS) {
        const m = html.match(p);
        if (m && !["whereispart2", "instagram"].includes(m[1].toLowerCase())) {
          console.log(`Creator found via ${t.name} (pattern ${p.source.slice(0, 30)})`);
          // og:description has "... - username on October 1, 2026: ..." → posting date
          const d = html.match(/ on ([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
          const postedAt = d ? Date.parse(d) || null : null;
          const thumb = html.match(/property="og:image"[^>]+content="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") || null;
          return { username: m[1], postedAt, thumb };
        }
      }
      // Debug: show what the page actually contains so we can adjust
      const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1];
      const og = [...html.matchAll(/<meta[^>]+property="og:(title|description)"[^>]+content="([^"]{0,200})/g)]
        .map(m => `${m[1]}=${m[2]}`);
      const userCtx = [...html.matchAll(/username/g)].slice(0, 3)
        .map(m => html.slice(Math.max(0, m.index - 60), m.index + 80));
      console.log(`No creator via ${t.name}`, JSON.stringify({
        status: res.status, finalUrl: res.url, bytes: html.length, title, og, userCtx,
      }));
    } catch (e) {
      console.log(`Fetch ${t.name} failed:`, e.message);
    }
  }
  return null;
}

async function sendText(recipientId, text) {
  const res = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IG_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) console.error("Send failed:", res.status, await res.text());
}
