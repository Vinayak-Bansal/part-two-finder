import crypto from "node:crypto";

const GRAPH = "https://graph.instagram.com/v23.0";
const { VERIFY_TOKEN, IG_TOKEN, APP_SECRET, GEMINI_API_KEY } = process.env;
const { FB_PAGE_TOKEN, IG_BUSINESS_ID } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

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
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;
      if (!msg || msg.is_echo) continue; // skip the bot's own replies

      const senderId = event.sender.id;
      const reel = (msg.attachments || []).find(a => a.type === "ig_reel" || a.type === "share");

      let reply;
      if (reel) {
        console.log("Reel received:", JSON.stringify(reel.payload));
        const info = await getCreator(reel.payload.url); // { username, postedAt }
        console.log("Creator:", JSON.stringify(info));
        if (!info?.username) {
          reply = "Couldn't tell who posted this reel. Try again in a bit.";
        } else {
          const p2 = await findPartTwo(reel.payload, info, () => sendText(senderId, "Looking for part 2..."));
          reply = p2
            ? `Here's part 2: https://www.instagram.com/reel/${p2.shortcode}/`
            : `Couldn't find part 2 yet. Check @${info.username}'s page, it might not be out yet.`;
        }
      } else {
        reply = "Send me a reel and I'll find part 2.";
      }
      await sendText(senderId, reply);
    }
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// ---------- Part 2 finder ----------

// Get a creator's posts, newest first. Uses Meta's official Business Discovery API when set up,
// otherwise the public web endpoint (often blocked from servers).
async function getRecentPosts(username, sinceMs) {
  if (FB_PAGE_TOKEN && IG_BUSINESS_ID) {
    const posts = await businessDiscovery(username, sinceMs);
    if (posts) return posts;
  }
  return webProfilePosts(username);
}

const BD_FIELDS_FULL = "id,caption,timestamp,permalink,media_type,media_product_type,thumbnail_url,media_url";
const BD_FIELDS_MIN = "id,caption,timestamp,permalink,media_type,media_url";

async function businessDiscovery(username, sinceMs) {
  const all = [];
  let after = null;
  let fields = BD_FIELDS_FULL;
  // Page back until we pass the original reel's date (max 4 pages × 50 posts)
  for (let page = 0; page < 4; page++) {
    const media = `media${after ? `.after(${after})` : ""}.limit(50){${fields}}`;
    const url =
      `https://graph.facebook.com/v23.0/${IG_BUSINESS_ID}` +
      `?fields=${encodeURIComponent(`business_discovery.username(${username}){${media}}`)}` +
      `&access_token=${FB_PAGE_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      // Retry once with fewer fields in case some aren't allowed
      if (fields === BD_FIELDS_FULL && data.error.code === 100) {
        console.log("Business Discovery: retrying with fewer fields:", data.error.message);
        fields = BD_FIELDS_MIN;
        page--;
        continue;
      }
      console.log("Business Discovery failed:", JSON.stringify(data.error).slice(0, 300));
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
      });
    }
    after = m?.paging?.cursors?.after;
    const oldest = all[all.length - 1]?.takenAt;
    if (!after || !sinceMs || (oldest && oldest < sinceMs)) break;
  }
  console.log(`Business Discovery: ${all.length} posts for @${username}`);
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
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function partNumber(text) {
  const m = text.match(/\b(?:part|pt)\.?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b|\bp(\d{1,2})\b|\b(\d{1,2})\/\d{1,2}\b/i);
  if (!m) return null;
  const v = (m[1] || m[2] || m[3]).toLowerCase();
  return NUM_WORDS[v] ?? parseInt(v, 10);
}

function words(text) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !w.startsWith("http")));
}
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

async function findPartTwo(payload, info, onSlow) {
  const code = payload.url?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  const caption = payload.title || "";
  const posts = await getRecentPosts(info.username, info.postedAt);
  if (!posts.length) return null;

  // When was the original posted? Use the list if it's there, else the date from the page.
  const original = posts.find(p => p.shortcode === code);
  const after = original?.takenAt ?? info.postedAt ?? 0;
  const candidates = posts.filter(p => p.shortcode !== code && p.takenAt > after);
  if (!candidates.length) return null;

  // If the reel you sent is part N, look for part N+1 (default: part 1 → find part 2)
  const sentPart = partNumber(caption);
  const want = (sentPart || 1) + 1;

  // 1) Fast path: caption clearly says the next part and matches the series → no AI needed
  let best = null;
  for (const p of candidates) {
    const sim = similarity(caption, p.caption);
    const n = partNumber(p.caption);
    const clear = n === want && (sim >= 0.2 || sentPart);
    console.log(`Candidate ${p.shortcode} part=${n} sim=${sim.toFixed(2)} clear=${clear} "${p.caption.slice(0, 50)}"`);
    if (clear && (!best || p.takenAt < best.takenAt)) best = p; // earliest matching
  }
  if (best) {
    console.log("Matched by caption:", best.shortcode);
    return best;
  }

  // 2) AI path: let Gemini look at the covers + captions
  if (!GEMINI_API_KEY) return null;
  await onSlow?.();
  const pick = await askGemini({ caption, thumb: original?.thumb || info.thumb }, candidates.slice(0, 10), want);
  return pick;
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

async function askGemini(sent, candidates, want) {
  const [sentImg, ...candImgs] = await Promise.all([sent.thumb, ...candidates.map(c => c.thumb)].map(imagePart));

  const parts = [
    {
      text:
        `You help people find the next part of an Instagram reel series.\n` +
        `The user sent a reel. Below are reels the same creator posted AFTER it.\n` +
        `Decide which one (if any) is part ${want} of the SAME series/story as the sent reel.\n` +
        `Use on-screen text in the covers (e.g. "Part ${want}", "pt ${want}"), same people/outfits/setting, ` +
        `and captions that continue the same story. A different topic is NOT a match even if it says "part ${want}".\n` +
        `If nothing is clearly the next part, answer null.\n` +
        `Reply ONLY with JSON: {"match": <candidate number or null>, "confidence": <0-1>, "reason": "<short>"}`,
    },
    { text: `SENT REEL. Caption: ${JSON.stringify(sent.caption.slice(0, 500))}` },
  ];
  if (sentImg) parts.push(sentImg);
  candidates.forEach((c, i) => {
    const date = new Date(c.takenAt).toISOString().slice(0, 10);
    parts.push({ text: `CANDIDATE ${i + 1} (posted ${date}). Caption: ${JSON.stringify(c.caption.slice(0, 300))}` });
    if (candImgs[i]) parts.push(candImgs[i]);
  });

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.log("Gemini error:", res.status, JSON.stringify(data).slice(0, 300));
      return null;
    }
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    console.log("Gemini says:", JSON.stringify(out));
    const i = Number(out.match);
    if (!Number.isInteger(i) || i < 1 || i > candidates.length || (out.confidence ?? 1) < 0.6) return null;
    return candidates[i - 1];
  } catch (e) {
    console.log("Gemini call failed:", e.message);
    return null;
  }
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
async function getCreator(url) {
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
