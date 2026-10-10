// Private accuracy test: /api/test?key=<VERIFY_TOKEN>&cases=<reelURL>><part2URL or none>|<reelURL>><...>
// Runs the real finder on each reel (no DMs sent) and scores it against the known answer.
import { getCreator, findPartTwo, getRecentPosts, buildReply, redis } from "./webhook.js";

const { VERIFY_TOKEN } = process.env;
const code = u => u?.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/)?.[1] || null;

async function runCase(reel, expected, blind) {
  const t0 = Date.now();
  try {
    const info = await getCreator(reel);
    if (!info?.username) return { reel, expected, got: null, reason: "no_creator", ms: Date.now() - t0 };
    const { post, reason, trace } = await findPartTwo({ url: reel, title: "" }, { ...info, blind });
    return { reel, creator: info.username, expected, got: post?.shortcode || null, reason: reason || null, ms: Date.now() - t0, trace };
  } catch (e) {
    return { reel, expected, got: null, reason: "error: " + e.message, ms: Date.now() - t0 };
  }
}

export async function GET(request) {
  const p = new URL(request.url).searchParams;
  if (![VERIFY_TOKEN, process.env.TEST_KEY].filter(Boolean).includes(p.get("key"))) return new Response("Forbidden", { status: 403 });
  const blind = p.get("blind") === "1";
  // ?stats=1 : how the bot has been doing (from the saved result log)
  if (p.get("stats")) {
    const rows = ((await redis("LRANGE", "log", "0", String(Number(p.get("n") || 500) - 1))) || []).map(r => JSON.parse(r));
    const counts = {};
    for (const r of rows) counts[r.result] = (counts[r.result] || 0) + 1;
    return Response.json({ total: rows.length, counts, recent: rows.slice(0, Number(p.get("show") || 20)) });
  }
  // ?dm=<shortcode>&title=<caption> : the exact DM reply the bot would send (nothing is sent)
  if (p.get("dm")) {
    const t0 = Date.now();
    let slow = false;
    const reply = await buildReply({ url: `https://www.instagram.com/reel/${p.get("dm")}/`, title: p.get("title") || "" }, () => { slow = true; });
    return Response.json({ reply, sentLookingMessage: slow, ms: Date.now() - t0 });
  }
  // ?peek=<username>&codes=a,b : show captions/dates of specific posts (uses the cached post list)
  if (p.get("peek")) {
    const { posts } = await getRecentPosts(p.get("peek"), Date.now() - Number(p.get("days") || 365) * 864e5);
    const codes = (p.get("codes") || "").split(",");
    const pick = p.get("codes") ? posts.filter(x => codes.includes(x.shortcode)) : posts.slice(-Number(p.get("n") || 30));
    const len = Number(p.get("len") || 300);
    return Response.json(pick.map(x => `${x.shortcode} ${new Date(x.takenAt).toISOString().slice(0, 16)}${x.video ? " v" : ""} | ${x.caption.replace(/\s+/g, " ").slice(0, len)}`));
  }
  const cases = (p.get("cases") || "").split("|").filter(Boolean).map(c => {
    const [reel, ans] = c.split(">");
    const full = x => x.includes("/") ? x : `https://www.instagram.com/reel/${x}/`;
    return { reel: full(reel.trim()), expected: ans && ans.trim() !== "none" ? code(full(ans.trim())) : null };
  });

  // Run 3 at a time to stay under rate limits
  const results = [];
  const par = Number(p.get("par") || 3);
  for (let i = 0; i < cases.length; i += par) {
    results.push(...(await Promise.all(cases.slice(i, i + par).map(c => runCase(c.reel, c.expected, blind)))));
  }
  // Infrastructure failures (rate limit, no data) aren't scored either way
  const INVALID = ["busy", "no_posts", "no_creator"];
  for (const r of results) {
    r.invalid = !r.got && (INVALID.includes(r.reason) || r.reason?.startsWith("error"));
    r.correct = !r.invalid && r.got === r.expected;
  }
  const valid = results.filter(r => !r.invalid);
  const score = valid.filter(r => r.correct).length;
  // brief=1: only show details for wrong/invalid cases
  if (p.get("brief")) for (const r of results) if (r.correct) { delete r.trace; delete r.reel; }
  return Response.json({
    blind,
    score: `${score}/${valid.length}`,
    invalid: results.length - valid.length,
    falseMatches: results.filter(r => r.got && r.got !== r.expected).length,
    missed: results.filter(r => !r.got && r.expected).length,
    results,
  });
}
