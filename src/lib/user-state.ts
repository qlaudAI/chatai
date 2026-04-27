import 'server-only';
import { clerkClient } from '@clerk/nextjs/server';

// Where we keep each user's qlaud footprint. Lives in Clerk's
// privateMetadata — server-only, ~8KB per user limit (we use ~200 bytes).
//
// SECURITY: this module is server-only. The qlaud_secret it returns
// grants access to the user's per-user key — anyone with it can spend
// against their cap. Never return it to the browser; route handlers
// that use it must call qlaud server-side and proxy results.
//
// Why not Supabase: with this much data per user, paying for a separate
// database (and the SDK + migrations + RLS policies that come with it)
// is overkill. Clerk already knows about every user; we're just bolting
// three extra fields onto the existing record.
//
// One round-trip per request to api.clerk.com on cold cache, served
// from in-memory cache for the next 60 seconds. The state changes
// once, at signup, so the cache is effectively forever.

export type QlaudUserState = {
  qlaud_key_id: string;
  qlaud_secret: string;
  qlaud_initial_thread_id: string;
};

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { state: QlaudUserState; loadedAt: number }>();

export async function getQlaudState(
  clerkUserId: string,
): Promise<QlaudUserState | null> {
  const hit = cache.get(clerkUserId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.state;

  const client = await clerkClient();
  const user = await client.users.getUser(clerkUserId);
  const md = (user.privateMetadata ?? {}) as Partial<QlaudUserState>;

  if (!md.qlaud_secret || !md.qlaud_key_id || !md.qlaud_initial_thread_id) {
    return null;
  }
  const state: QlaudUserState = {
    qlaud_key_id: md.qlaud_key_id,
    qlaud_secret: md.qlaud_secret,
    qlaud_initial_thread_id: md.qlaud_initial_thread_id,
  };
  cache.set(clerkUserId, { state, loadedAt: Date.now() });
  return state;
}

export async function setQlaudState(
  clerkUserId: string,
  state: QlaudUserState,
): Promise<void> {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUserId, {
    privateMetadata: state as unknown as Record<string, unknown>,
  });
  cache.set(clerkUserId, { state, loadedAt: Date.now() });
}
