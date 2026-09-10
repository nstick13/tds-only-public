/**
 * Bye-week logic. PURE — no I/O, no Supabase client, so this is safe to import
 * from client components. That is the whole reason it is not in
 * src/lib/db/players.ts: that module imports the server Supabase client, which
 * pulls in `next/headers`, which cannot be bundled for the browser.
 *
 * See the NflTeamBye comment in src/lib/types.ts for why a bye is not a column
 * on `players`.
 */
import type { Player, StagePlayer } from "@/lib/types";

/**
 * Attaches `on_bye` to each player for one stage's week.
 *
 * A player with no `nfl_team_id` (rare, but Tank01 does emit them) is treated
 * as NOT on bye — refusing to let someone draft a player because we could not
 * identify their team would be a worse failure than the reverse.
 */
export function decorateWithByes(
  players: Player[],
  byeTeamIds: Set<string>,
): StagePlayer[] {
  return players.map((p) => ({
    ...p,
    on_bye: p.nfl_team_id != null && byeTeamIds.has(p.nfl_team_id),
  }));
}
