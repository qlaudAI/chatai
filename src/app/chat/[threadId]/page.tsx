import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { ensureQlaudState } from '@/lib/user-state';
import { qlaud } from '@/lib/qlaud';
import { ChatShell } from '@/components/chat/chat-shell';

export const dynamic = 'force-dynamic';

// /chat/[threadId] — server-rendered shell with prior history baked in.
// The streaming response for new turns is handled client-side; this page
// is only responsible for the first paint.
export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  // Provisions inline if missing — handled in /chat for the OnboardingPending
  // screen, but if a user lands directly on a thread URL with no state we
  // bounce to /chat which renders the friendly retry.
  let state;
  try {
    state = await ensureQlaudState(userId);
  } catch {
    redirect('/chat');
  }

  const { threadId } = await params;

  // Fetch the latest 30 messages newest-first, then reverse for
  // chronological display. Cursor for "Load older" is the seq of the
  // oldest message we just received.
  const PAGE_SIZE = 30;
  const [history, threadList] = await Promise.all([
    qlaud.listThreadMessages({
      apiKey: state.qlaud_secret,
      threadId,
      order: 'desc',
      limit: PAGE_SIZE,
    }),
    qlaud.listThreads({
      apiKey: state.qlaud_secret,
      endUserId: userId,
      limit: 50,
    }),
  ]);

  const initialMessages = [...history.data].reverse();
  const oldestSeq = initialMessages.length > 0 ? initialMessages[0]!.seq : null;

  return (
    <ChatShell
      threadId={threadId}
      initialMessages={initialMessages}
      threads={threadList.data}
      hasOlder={history.has_more}
      oldestLoadedSeq={oldestSeq}
    />
  );
}
