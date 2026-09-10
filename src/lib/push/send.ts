import "server-only";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import { serviceRoleEnv } from "@/lib/supabase/env";

/**
 * Web Push sending. Server-only: the VAPID private key must never reach a
 * browser bundle, hence the "server-only" import guard.
 *
 * The app sends exactly two kinds of notification — a draft is open / you are
 * on the clock, and a week has been finalized. Both originate from server
 * actions the app already runs, so there is no cron job here.
 *
 * Subscriptions are keyed by `user_id` and are GLOBAL per user, not per
 * league: a browser subscribes once and every league that person is in sends
 * to the same endpoints. That is why the copy in notify.ts always names the
 * league — the device gives no other clue which one is talking.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should land. Relative to the app origin. */
  url?: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag?: string;
}

let configured = false;

/**
 * Returns true when VAPID keys are present. Sending is deliberately optional:
 * if the keys are not set the app must still draft and finalize normally, so
 * every send path degrades to a no-op rather than throwing.
 */
function configure(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return false;

  if (!configured) {
    // The subject must be a mailto: or https: URL identifying the sender —
    // push services reject a JWT without one.
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT?.trim() || "mailto:commish@tds-only.app",
      publicKey,
      privateKey,
    );
    configured = true;
  }
  return true;
}

/** Service-role client: the sender must read other users' subscriptions, which RLS hides. */
function adminClient() {
  const { url, serviceKey } = serviceRoleEnv();
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Sends a notification to every device belonging to the given users.
 *
 * Never throws: a failed notification must not roll back the draft pick or
 * finalize that triggered it. Callers get a count back and can ignore it.
 */
export async function sendToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  if (userIds.length === 0) return { sent: 0, failed: 0 };
  if (!configure()) return { sent: 0, failed: 0 };

  let supabase;
  try {
    supabase = adminClient();
  } catch {
    // serviceRoleEnv() throws when the key is unset — same no-op contract.
    return { sent: 0, failed: 0 };
  }

  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (error || !data || data.length === 0) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  const goneIds: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    data.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint as string,
            keys: { p256dh: row.p256dh as string, auth: row.auth as string },
          },
          body,
        );
        sent++;
      } catch (err) {
        failed++;
        // 404/410 mean the browser threw the subscription away (app deleted,
        // permission revoked, home-screen icon removed). Those rows are dead
        // forever, so drop them instead of retrying every week.
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) goneIds.push(row.id as string);
        else console.error("push send failed", status, String(err));
      }
    }),
  );

  if (goneIds.length > 0) {
    await supabase.from("push_subscriptions").delete().in("id", goneIds);
  }

  return { sent, failed };
}

/**
 * Everyone in one league — the audience for a league-wide announcement.
 *
 * Reads league_members with the service role rather than the caller's client
 * on purpose: this runs from inside an action that has ALREADY established
 * the caller's right to act on that league, and the caller may not be a
 * member of it at all (a cron-driven finalize, say). Spectators are included:
 * they came to watch, and a week going final is the thing to watch.
 */
export async function leagueUserIds(leagueId: string): Promise<string[]> {
  try {
    const supabase = adminClient();
    const { data, error } = await supabase
      .from("league_members")
      .select("user_id")
      .eq("league_id", leagueId);
    if (error || !data) return [];
    return data.map((r) => r.user_id as string);
  } catch {
    return [];
  }
}
