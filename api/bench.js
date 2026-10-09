// Automatic benchmark: /api/bench?key=<VERIFY_TOKEN>&users=a,b,c&max=8&offset=0&blind=1
// Builds test cases from creators' own labeled series (part N -> part N+1), then runs the real finder.
// blind=1 hides the "part N" labels from captions, so the bot has to find part 2 from covers/video.
import { getRecentPosts, findPartTwo, partNumber, similarity, stripPart } from "./webhook.js";

const { VERIFY_TOKEN } = process.env;

function buildPairs(username, posts) {
  const pairs = [];
  for (const a of posts) {
    const n = partNumber(a.caption);
    if (!n) continue;
    const next = posts
      .filter(b => b.takenAt > a.takenAt && partNumber(b.caption) === n + 1 &&
                   similarity(stripPart(a.caption), stripPart(b.caption)) >= 0.6)
      .sort((x, y) => x.takenAt - y.takenAt)[0];
    if (next) pairs.push({ username, sent: a, expected: next });
  }
  return pairs;
}

export async function GET(request) {
  const p = new URL(request.url).searchParams;
  if (![VERIFY_TOKEN, process.env.TEST_KEY].filter(Boolean).includes(p.get("key"))) return new Response("Forbidden", { status: 403 });
  const users = (p.get("users") || "").split(",").map(s => s.trim()).filter(Boolean);
  const max = Number(p.get("max") || 8), offset = Number(p.get("offset") || 0), blind = p.get("blind") === "1";

  // 1. Build ground-truth pairs from each creator's labeled series
  let pairs = [];
  const found = {};
  for (const u of users) {
    const { posts, personal } = await getRecentPosts(u, Date.now() - Number(p.get("days") || 365) * 864e5);
    const ps = personal ? [] : buildPairs(u, posts);
    found[u] = personal ? "personal account" : `${posts.length} posts, ${ps.length} series pairs`;
    pairs.push(...ps.slice(0, Number(p.get("per") || 3))); // at most 3 per creator so one account doesn't dominate
  }
  if (max === 0) {
    return Response.json({ creators: found, totalPairs: pairs.length,
      sample: pairs.slice(0, Number(p.get("n") || 30)).map(c => `${c.username} ${c.sent.shortcode}>${c.expected.shortcode} | ${c.sent.caption.replace(/\s+/g, " ").slice(0, 45)} -> ${c.expected.caption.replace(/\s+/g, " ").slice(0, 35)}`) });
  }
  const batch = pairs.slice(offset, offset + max);

  // 2. Run the finder on each (2 at a time)
  const results = [];
  for (let i = 0; i < batch.length; i += 2) {
    results.push(...(await Promise.all(batch.slice(i, i + 2).map(async c => {
      const t0 = Date.now();
      const { post, reason } = await findPartTwo(
        { url: `https://www.instagram.com/reel/${c.sent.shortcode}/`, title: c.sent.caption },
        { username: c.username, postedAt: c.sent.takenAt, blind }
      );
      return {
        creator: c.username,
        sent: c.sent.shortcode, sentCaption: c.sent.caption.slice(0, 60),
        expected: c.expected.shortcode, got: post?.shortcode || null, reason: reason || null,
        correct: post?.shortcode === c.expected.shortcode, ms: Date.now() - t0,
      };
    }))));
  }
  const score = results.filter(r => r.correct).length;
  return Response.json({ blind, creators: found, totalPairs: pairs.length, ran: `${offset}-${offset + batch.length}`,
                         score: `${score}/${results.length}`, results });
}
