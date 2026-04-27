import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { qlaud } from '@/lib/qlaud';
import { ensureQlaudState } from '@/lib/user-state';

export const runtime = 'nodejs';

// GET /api/threads/:id?before_seq=N&limit=30 — paginated message list.
// MessageStream calls this with before_seq=<oldest visible> for "Load older".
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  let state;
  try {
    state = await ensureQlaudState(userId);
  } catch (e) {
    return NextResponse.json(
      { error: 'failed to provision', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      { status: 502 },
    );
  }
  const { id } = await params;
  const url = new URL(req.url);
  const beforeSeqRaw = url.searchParams.get('before_seq');
  const limitRaw = url.searchParams.get('limit');
  const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 30;

  const r = await qlaud.listThreadMessages({
    apiKey: state.qlaud_secret,
    threadId: id,
    order: 'desc',
    limit,
    beforeSeq,
  });
  return NextResponse.json(r);
}
