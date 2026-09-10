import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth / PKCE callback. Supabase redirects the browser here after a
 * successful "Sign in with Google" (the `redirectTo` set in the login page
 * points at this route). We exchange the one-time `?code=` for a real
 * session — this is what writes the auth cookies server-side — then send
 * the manager on to the app.
 *
 * IMPORTANT: the redirect is built from the *incoming request's* host, not
 * a hard-coded URL, so it works identically in local dev and on Vercel. On
 * Vercel the real host arrives in `x-forwarded-host`; behind that proxy
 * `origin` can be the internal address, so prefer the forwarded host in
 * production. This is the piece that was missing when confirmation links
 * bounced everyone back to localhost.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Where to land after auth. Only app-relative paths, and never one starting
  // "//" — that is a protocol-relative URL, and honouring it would make this
  // callback an open redirect to any host someone put in the link.
  const nextParam = searchParams.get("next");
  const next =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // `next` is honoured verbatim, including for a brand-new account. The
      // single-league app diverted first-time sign-ins to a display-name
      // form, which cannot work here: display names are per-league, and a new
      // account has no league to name themselves in yet. The home page's
      // "create a league" / "your leagues" split is the right first screen,
      // and an invite link in `next` is a first screen that matters more than
      // either.
      const dest = next;

      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";

      if (!isLocalEnv && forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${dest}`);
      }
      return NextResponse.redirect(`${origin}${dest}`);
    }
  }

  // No code, or the exchange failed — bounce back to the sign-in page with
  // a flag the page can surface to the user.
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
