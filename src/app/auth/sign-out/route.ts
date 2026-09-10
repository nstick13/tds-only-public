import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Sign-out route handler. POST /auth/sign-out from a <form> (or fetch)
 * to clear the session, then redirect home. Kept as a route handler
 * (rather than a client-only supabase.auth.signOut() call) so cookies
 * are cleared server-side consistently with the SSR auth pattern.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/", request.url), { status: 302 });
}
