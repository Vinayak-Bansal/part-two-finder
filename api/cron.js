// Daily job (see vercel.json): keeps the Instagram token from expiring.
import { renewIgToken } from "./webhook.js";

export async function GET(request) {
  // Vercel sends this header on scheduled runs when CRON_SECRET is set; also allow the test key.
  const auth = request.headers.get("authorization");
  const key = new URL(request.url).searchParams.get("key");
  const okKeys = [process.env.CRON_SECRET && `Bearer ${process.env.CRON_SECRET}`].filter(Boolean);
  const allowed = !process.env.CRON_SECRET || okKeys.includes(auth) || (key && key === process.env.TEST_KEY);
  if (!allowed) return new Response("Forbidden", { status: 403 });
  const force = new URL(request.url).searchParams.get("force") === "1" && key === process.env.TEST_KEY;
  return Response.json(await renewIgToken(force));
}
