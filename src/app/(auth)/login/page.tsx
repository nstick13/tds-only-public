"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { PixelButton } from "@/components/ui/PixelButton";
import { PixelPanel } from "@/components/ui/PixelPanel";

/**
 * Sole sign-in page. Auth is Google OAuth via Supabase — no passwords are
 * stored anywhere, and there's no email-confirmation step to get wrong.
 * Clicking the button hands off to Google; Supabase brings the visitor back
 * to /auth/callback (src/app/auth/callback/route.ts), which exchanges the
 * code for a session and redirects onward.
 *
 * Signup and login are the same action with OAuth. The first authorization
 * creates the profile row via the on_auth_user_created trigger — and nothing
 * else. Seats and leagues come later, from create_league or an invite.
 */
function LoginForm() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "Sign-in failed. Please try again." : null,
  );
  const [loading, setLoading] = useState(false);

  // Where to land afterwards. Only app-relative paths, and never one starting
  // "//" — that is a protocol-relative URL, so honouring it would turn this
  // page into an open redirect to any host an attacker put in the link.
  const nextParam = searchParams.get("next");
  const next =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/";

  async function signInWithGoogle() {
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        // Send Google back to our server callback on whatever host the app is
        // currently running on (localhost in dev, the Vercel domain in prod).
        // This must also be listed in Supabase's Redirect URLs.
        //
        // `next` rides along in the callback's query string because it has to
        // survive a round trip through Google and Supabase, neither of which
        // will carry app state for us. This is what makes an invite link work
        // for someone who wasn't signed in when they opened it.
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    // On success the browser is already navigating to Google, so we only
    // reach here (with loading still true) on an immediate failure.
    if (oauthError) {
      setError(oauthError.message);
      setLoading(false);
    }
  }

  const joining = next.startsWith("/join/");

  return (
    <PixelPanel raised className="w-full max-w-sm flex flex-col gap-6">
      <h1 className="font-pixel text-lg text-retro-yellow">Sign In</h1>

      <p className="font-mono text-lg text-retro-offwhite">
        {joining
          ? "Sign in with Google and we'll take you back to your invite."
          : "Sign in with Google to start a league or open one you're in. First time? This same button signs you up."}
      </p>

      {error ? (
        <p className="font-mono text-retro-red text-base">{error}</p>
      ) : null}

      <PixelButton type="button" onClick={signInWithGoogle} disabled={loading}>
        {loading ? "Redirecting..." : "Continue with Google"}
      </PixelButton>
    </PixelPanel>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
