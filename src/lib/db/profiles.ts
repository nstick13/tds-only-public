import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

/**
 * The signed-in user's own profile, or null if not authenticated.
 *
 * This is the ONLY profile read the app can make. `profiles` is owner-
 * readable (0006_rls.sql) because it holds email addresses and anyone can
 * sign up here — a getProfiles() would come back holding one row, and a
 * getManagers() built on global role flags has nothing left to read. Member
 * lists come from src/lib/db/members.ts instead.
 */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw new Error(`getMyProfile: ${error.message}`);
  return data as Profile | null;
}
