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
  if (p.get("key") !== VERIFY_TOKEN) return new Response("Forbidden", { status: 403 });
  const u = p.get("u") || "instagram";
  const G = "https://graph.facebook.com/v23.0";
  const t = `access_token=${FB_PAGE_TOKEN}`;
  const q = s => encodeURIComponent(s);

  const results = await Promise.all([
    call("token scopes", `${G}/debug_token?input_token=${FB_PAGE_TOKEN}&${t}`),
    call("page me", `${G}/me?fields=id,name&${t}`),
    call("ig account", `${G}/${IG_BUSINESS_ID}?fields=id,username&${t}`),
    call("page's ig link", `${G}/me?fields=instagram_business_account&${t}`),
    call("bd basic", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){id,username,followers_count,media_count}`)}&${t}`),
    call("bd media", `${G}/${IG_BUSINESS_ID}?fields=${q(`business_discovery.username(${u}){media.limit(3){id,caption,timestamp,permalink,media_type}}`)}&${t}`),
    call("ig-login token bd", `https://graph.instagram.com/v23.0/me?fields=${q(`business_discovery.username(${u}){id,username}`)}&access_token=${IG_TOKEN}`),
  ]);
  return Response.json({ hasPageToken: !!FB_PAGE_TOKEN, igBusinessId: IG_BUSINESS_ID, results });
}
