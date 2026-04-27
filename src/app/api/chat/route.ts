import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { qlaud, QlaudError } from '@/lib/qlaud';
import { getQlaudState } from '@/lib/user-state';

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
// calls qlaud's streaming threads endpoint with all registered tools
// attached, and pipes the SSE response back to the browser verbatim.
// The browser parses the events via lib/qlaud-stream.
//
// We never re-buffer the stream — the upstream Response.body goes
// straight into the new Response. Token-by-token latency on the wire
// matches what qlaud itself produces.
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

  const state = await getQlaudState(userId);
  if (!state) {
    return NextResponse.json(
      { error: 'user not provisioned — Clerk webhook may not have fired yet' },
      { status: 425 },
    );
  }

  const tools = await getToolIds();

  let upstream: Response;
  try {
    upstream = await qlaud.streamMessage({
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

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return NextResponse.json(
      { error: `upstream ${upstream.status}: ${text.slice(0, 500)}` },
      { status: upstream.status as 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-qlaud-thread-id':
        upstream.headers.get('x-qlaud-thread-id') ?? body.threadId,
      'x-qlaud-assistant-seq':
        upstream.headers.get('x-qlaud-assistant-seq') ?? '',
    },
  });
}
