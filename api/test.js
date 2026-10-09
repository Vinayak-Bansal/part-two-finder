// Private accuracy test: /api/test?key=<VERIFY_TOKEN>&cases=<reelURL>><part2URL or none>|<reelURL>><...>
// Runs the real finder on each reel (no DMs sent) and scores it against the known answer.
import { getCreator, findPartTwo } from "./webhook.js";

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
  const cases = (p.get("cases") || "").split("|").filter(Boolean).map(c => {
    const [reel, ans] = c.split(">");
    const full = x => x.includes("/") ? x : `https://www.instagram.com/reel/${x}/`;
    return { reel: full(reel.trim()), expected: ans && ans.trim() !== "none" ? code(full(ans.trim())) : null };
  });

  // Run 3 at a time to stay under rate limits
  const results = [];
  for (let i = 0; i < cases.length; i += 3) {
    results.push(...(await Promise.all(cases.slice(i, i + 3).map(c => runCase(c.reel, c.expected, blind)))));
  }
  // Infrastructure failures (rate limit, no data) aren't scored either way
  const INVALID = ["busy", "no_posts", "no_creator"];
  for (const r of results) {
    r.invalid = !r.got && (INVALID.includes(r.reason) || r.reason?.startsWith("error"));
    r.correct = !r.invalid && r.got === r.expected;
  }
  const valid = results.filter(r => !r.invalid);
  const score = valid.filter(r => r.correct).length;
  return Response.json({
    blind,
    score: `${score}/${valid.length}`,
    invalid: results.length - valid.length,
    falseMatches: results.filter(r => r.got && r.got !== r.expected).length,
    missed: results.filter(r => !r.got && r.expected).length,
    results,
  });
}
