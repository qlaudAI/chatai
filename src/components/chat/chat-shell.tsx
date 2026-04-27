'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Thread, ThreadMessage } from '@/lib/qlaud';
import { ThreadList } from './thread-list';
import { MessageStream } from './message-stream';
import { InputBar } from './input-bar';
import { SearchBar } from './search-bar';

// The single live container for /chat/[threadId]. Owns:
//   - the in-memory list of threads (so creating a new one is instant)
//   - the in-memory list of messages for the current thread (history +
//     anything we've streamed during this session)
//   - the streaming state (used by InputBar to know if it should disable
//     itself, and by MessageStream to render the cursor)
export function ChatShell({
  threadId,
  initialMessages,
  threads,
  hasOlder: initialHasOlder,
  oldestLoadedSeq: initialOldestSeq,
}: {
  threadId: string;
  initialMessages: ThreadMessage[];
  threads: Thread[];
  hasOlder: boolean;
  oldestLoadedSeq: number | null;
}) {
  const router = useRouter();
  const [threadsState, setThreads] = useState<Thread[]>(threads);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState(false);
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  const [oldestSeq, setOldestSeq] = useState<number | null>(initialOldestSeq);
  const [loadingOlder, setLoadingOlder] = useState(false);

  async function handleNewThread() {
    const r = await fetch('/api/threads', { method: 'POST' });
    if (!r.ok) return;
    const t = (await r.json()) as Thread;
    setThreads((prev) => [t, ...prev]);
    router.push(`/chat/${t.id}`);
  }

  // Load the next page of older messages from qlaud (server-side
  // backward pagination via before_seq cursor).
  async function loadOlder() {
    if (loadingOlder || !hasOlder || oldestSeq == null) return;
    setLoadingOlder(true);
    try {
      const r = await fetch(
        `/api/threads/${threadId}?before_seq=${oldestSeq}&limit=30`,
      );
      if (!r.ok) return;
      const j = (await r.json()) as {
        data: ThreadMessage[];
        has_more: boolean;
        next_before_seq: number | null;
      };
      const olderChrono = [...j.data].reverse();
      setMessages((prev) => [...olderChrono, ...prev]);
      setHasOlder(j.has_more);
      setOldestSeq(j.next_before_seq);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-muted/40 md:flex">
        <div className="flex items-center justify-between px-4 py-3">
          <a href="/" className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
              q.
            </span>
            <span className="text-sm font-semibold">chatai</span>
          </a>
          <button
            onClick={handleNewThread}
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            + New
          </button>
        </div>
        <div className="px-3 pb-2">
          <SearchBar />
        </div>
        <ThreadList threads={threadsState} activeId={threadId} />
      </aside>

      <main className="flex flex-1 flex-col">
        <MessageStream
          messages={messages}
          streaming={streaming}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
        />
        <InputBar
          threadId={threadId}
          disabled={streaming}
          onTurnStart={(userMsg) => {
            setStreaming(true);
            setMessages((prev) => [...prev, userMsg]);
          }}
          onAssistantUpdate={(msg) => {
            setMessages((prev) => {
              const i = prev.findIndex((m) => m.seq === msg.seq);
              if (i === -1) return [...prev, msg];
              const next = prev.slice();
              next[i] = msg;
              return next;
            });
          }}
          onTurnEnd={() => setStreaming(false)}
        />
      </main>
    </div>
  );
}
