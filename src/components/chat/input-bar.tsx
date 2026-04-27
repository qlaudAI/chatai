'use client';

import { useRef, useState } from 'react';
import type { ThreadMessage } from '@/lib/qlaud';

// Composes the user's message and runs the turn:
//   1. POST /api/chat with { threadId, message }
//   2. Await the JSON response — qlaud has already run any tool
//      dispatches in its own loop on the server side, so what comes
//      back is the FULL assistant turn (text + thinking + tool blocks).
//   3. Push the placeholder + final message up to ChatShell.
//
// Why no SSE: qlaud v1 doesn't yet support streaming + tools together.
// We chose tools (the substrate showcase) over the streaming cursor.
// The placeholder cursor still spins while we wait for the response.
export function InputBar({
  threadId,
  disabled,
  onTurnStart,
  onAssistantUpdate,
  onTurnEnd,
}: {
  threadId: string;
  disabled: boolean;
  onTurnStart: (userMsg: ThreadMessage) => void;
  onAssistantUpdate: (msg: ThreadMessage) => void;
  onTurnEnd: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';

    const now = Date.now();
    onTurnStart({
      seq: -1,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      request_id: null,
      created_at: now,
    });

    // Push an empty assistant placeholder so the streaming cursor
    // renders while qlaud thinks (can take several seconds when tools
    // fire, since each webhook round-trip is sequential within a turn).
    const errorMessage = (msg: string): ThreadMessage => ({
      seq: 1_000_000_000,
      role: 'assistant',
      content: [{ type: 'text', text: `⚠️ ${msg}` }],
      request_id: null,
      created_at: Date.now(),
    });
    onAssistantUpdate({
      seq: 1_000_000_000,
      role: 'assistant',
      content: [],
      request_id: null,
      created_at: now,
    });

    let res: Response;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, message: trimmed }),
      });
    } catch (e) {
      onAssistantUpdate(errorMessage(`network error: ${(e as Error).message}`));
      onTurnEnd();
      return;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let parsed: { error?: string; detail?: string } | null = null;
      try {
        parsed = detail ? JSON.parse(detail) : null;
      } catch {
        /* not JSON, fall through */
      }
      const msg =
        parsed?.detail || parsed?.error || detail.slice(0, 300) || `HTTP ${res.status}`;
      onAssistantUpdate(errorMessage(msg));
      onTurnEnd();
      return;
    }

    let json: { content?: unknown; seq?: number; created_at?: number };
    try {
      json = await res.json();
    } catch (e) {
      onAssistantUpdate(errorMessage(`invalid JSON from upstream: ${(e as Error).message}`));
      onTurnEnd();
      return;
    }

    const content = Array.isArray(json.content) ? json.content : [];
    onAssistantUpdate({
      seq: 1_000_000_000,
      role: 'assistant',
      content,
      request_id: null,
      created_at: typeof json.created_at === 'number' ? json.created_at : Date.now(),
    });
    onTurnEnd();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoSize(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  }

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto max-w-3xl px-4 py-4">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 focus-within:border-primary/60">
          <textarea
            ref={taRef}
            value={text}
            onChange={autoSize}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Message qlaud…"
            disabled={disabled}
            className="flex-1 resize-none bg-transparent py-1 text-sm placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={disabled || !text.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
            aria-label="Send"
          >
            <svg
              viewBox="0 0 24 24"
              width={16}
              height={16}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Powered by{' '}
          <a
            href="https://qlaud.ai"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            qlaud
          </a>{' '}
          · Threads, tools, and search built in.
        </p>
      </div>
    </div>
  );
}
