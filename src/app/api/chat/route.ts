import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { qlaud, QlaudError } from '@/lib/qlaud';
import { ensureQlaudState } from '@/lib/user-state';

export const runtime = 'nodejs';

// In-memory cache of the master account's registered tool ids. We pull
// once per worker boot and reuse — listing on every request would be
// wasteful and the set rarely changes (rotation requires a deploy).
let toolIdsCache: { ids: string[]; loadedAt: number } | null = null;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

async function getToolIds(): Promise<string[]> {
  const now = Date.now();
  if (toolIdsCache && now - toolIdsCache.loadedAt < TOOL_CACHE_TTL_MS) {
    return toolIdsCache.ids;
  }
  try {
    const r = await qlaud.listTools();
    const ids = r.data.map((t) => t.id);
    toolIdsCache = { ids, loadedAt: now };
    return ids;
  } catch {
    return toolIdsCache?.ids ?? [];
  }
}

// POST /api/chat
//
// Body: { threadId: string, message: string }
//
// Looks up the caller's qlaud per-user secret from Clerk privateMetadata,
// calls qlaud's threads endpoint with all registered tools attached,
// and returns the full assistant turn (text + thinking + tool blocks)
// as JSON.
//
// Why JSON not SSE: qlaud v1 doesn't yet support `stream: true` together
// with `tools`. We pick tools (the substrate showcase — web_search,
// generate_image dispatch loop) over the streaming cursor. Once qlaud
// lifts the restriction, this becomes a streaming proxy again.
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: { threadId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.threadId || !body.message) {
    return NextResponse.json(
      { error: 'threadId and message are required' },
      { status: 400 },
    );
  }

  let state;
  try {
    state = await ensureQlaudState(userId);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'failed to provision qlaud account',
        detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
      },
      { status: 502 },
    );
  }

  const tools = await getToolIds();

  let upstream: Response;
  try {
    upstream = await qlaud.sendMessage({
      apiKey: state.qlaud_secret,
      threadId: body.threadId,
      body: {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        content: body.message,
        ...(tools.length > 0 ? { tools } : {}),
      },
    });
  } catch (e) {
    const status = e instanceof QlaudError ? e.status : 502;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'upstream failed' },
      { status: status as 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503 },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return NextResponse.json(
      { error: `upstream ${upstream.status}`, detail: text.slice(0, 500) },
      { status: upstream.status as 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503 },
    );
  }

  // Pass the qlaud body through unchanged — it already has the shape
  // InputBar expects: { content: [...], stop_reason, usage, ... }.
  const json = await upstream.json();
  return NextResponse.json(json);
}
