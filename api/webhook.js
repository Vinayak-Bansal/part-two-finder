import crypto from "node:crypto";

const GRAPH = "https://graph.instagram.com/v23.0";
const { VERIFY_TOKEN, IG_TOKEN, APP_SECRET } = process.env;

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
        const creator = await getCreator(reel.payload.url);
        console.log("Creator:", creator);
        const partTwo = await findPartTwo(reel.payload, creator);
        reply = partTwo
          ? `Here's part 2: ${partTwo}`
          : `Creator: ${creator ? "@" + creator : "unknown"}. Part 2 search coming soon 👀`;
      } else {
        reply = "Send me a reel and I'll find part 2.";
      }
      await sendText(senderId, reply);
    }
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// TODO: the real part-two lookup goes here.
// payload usually has { reel_video_id, title, url }.
async function findPartTwo(payload, creator) {
  return null;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

// Find the creator's username from the reel's public pages (free, no API)
async function getCreator(url) {
  const code = url?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (!code) return null;

  const tries = [
    // 1. Public embed page (what websites use to embed posts; no login wall)
    {
      name: "embed",
      url: `https://www.instagram.com/reel/${code}/embed/captioned/`,
      patterns: [
        /class="UsernameText"[^>]*>([A-Za-z0-9._]+)</,
        /"username":"([A-Za-z0-9._]+)"/,
        /instagram\.com\/([A-Za-z0-9._]+)\/?\?utm_source=ig_embed/,
      ],
    },
    // 2. Normal reel page metadata (og tags)
    {
      name: "page",
      url: `https://www.instagram.com/reel/${code}/`,
      patterns: [
        /\(@([A-Za-z0-9._]+)\)/,
        /- ([A-Za-z0-9._]+) on [A-Z][a-z]+ \d/,
        /"username":"([A-Za-z0-9._]+)"/,
      ],
    },
  ];

  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
      const html = await res.text();
      for (const p of t.patterns) {
        const m = html.match(p);
        if (m && m[1] !== "whereispart2") {
          console.log(`Creator found via ${t.name}`);
          return m[1];
        }
      }
      console.log(`No creator via ${t.name} (status ${res.status}, ${html.length} bytes)`);
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
