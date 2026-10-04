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
        const partTwo = await findPartTwo(reel.payload);
        reply = partTwo ? `Here's part 2: ${partTwo}` : "Couldn't find part 2 for this one yet 👀";
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
async function findPartTwo(payload) {
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
