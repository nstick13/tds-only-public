import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NewLeagueForm } from "./NewLeagueForm";

/**
 * /leagues/new — start a league.
 *
 * Outside /l/[slug] by necessity: there is no league to resolve yet. The
 * signed-in check therefore happens here rather than in a shared layout.
 */
export default async function NewLeaguePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/leagues/new")}`);
  }

  return (
    <main className="min-h-screen max-w-lg mx-auto px-4 py-10 flex flex-col gap-4">
      <NewLeagueForm />
      <Link
        href="/"
        className="font-mono text-base text-retro-offwhite/60 hover:text-retro-yellow w-fit"
      >
        &larr; Back to your leagues
      </Link>
    </main>
  );
}
