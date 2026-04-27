'use client';

import { useEffect, useRef, useState } from 'react';
import type { ThreadMessage } from '@/lib/qlaud';
import { Markdown } from './markdown';
import { ThinkingBlock } from './thinking-block';
import { ToolExecution, type ToolBlock } from './tool-execution';
import { StreamingCursor } from './streaming-cursor';

const INITIAL_VISIBLE = 30;
const PAGE_SIZE = 20;

// Renders the conversation as a sequence of message bubbles. Each
// assistant turn may contain text, thinking, and tool_use/tool_result
// blocks — we walk the content array and render each block in order.
//
// Pagination: shows the most recent INITIAL_VISIBLE messages. Older
// messages are loaded but hidden until the user clicks "Load older",
// which reveals PAGE_SIZE more. Avoids paint-blocking on long threads.
//
// Why client-windowed not server-paginated: qlaud v1's pagination is
// forward-only (after_seq). For a chat UI we want to lazy-load
// backwards. Until qlaud supports before_seq, we fetch the full
// (capped) history server-side and slice client-side.
export function MessageStream({
  messages,
  streaming,
}: {
  messages: ThreadMessage[];
  streaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  // Auto-grow visible window so freshly-sent messages always render.
  // Without this, a long-running session that hits >INITIAL_VISIBLE
  // turns would clip its own latest replies.
  useEffect(() => {
    if (messages.length > visibleCount) {
      const newTurns = messages.length - visibleCount;
      // Only grow when new messages arrive at the tail (turn happened),
      // not when we're paginating backwards.
      if (newTurns <= 4) setVisibleCount(messages.length);
    }
  }, [messages.length, visibleCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const hasOlder = messages.length > visibleCount;
  const visible = hasOlder ? messages.slice(-visibleCount) : messages;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8">
        {messages.length === 0 && !streaming && <EmptyState />}
        {hasOlder && (
          <div className="mb-6 text-center">
            <button
              onClick={() =>
                setVisibleCount((v) => Math.min(v + PAGE_SIZE, messages.length))
              }
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Load older messages ({messages.length - visibleCount} more)
            </button>
          </div>
        )}
        <div className="space-y-6">
          {visible.map((m, i) => (
            <MessageRow
              key={`${m.seq}-${i}`}
              message={m}
              streaming={streaming && i === visible.length - 1 && m.role === 'assistant'}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
        q.
      </div>
      <h2 className="text-lg font-semibold">Start a conversation</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Ask anything. The assistant has access to web search and image
        generation — try{' '}
        <span className="text-foreground">
          &ldquo;search the web for the latest Mars rover news&rdquo;
        </span>
        .
      </p>
    </div>
  );
}

function MessageRow({
  message,
  streaming,
}: {
  message: ThreadMessage;
  streaming: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <Avatar role={message.role} />
      <div
        className={`min-w-0 flex-1 ${
          isUser ? 'flex justify-end' : ''
        }`}
      >
        <div
          className={
            isUser
              ? 'inline-block max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground'
              : 'max-w-full'
          }
        >
          <ContentBlocks
            content={message.content}
            isUser={isUser}
            streaming={streaming}
          />
        </div>
      </div>
    </div>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  if (role === 'user') {
    return (
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
        you
      </div>
    );
  }
  return (
    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
      q.
    </div>
  );
}

type RawBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

function ContentBlocks({
  content,
  isUser,
  streaming,
}: {
  content: unknown;
  isUser: boolean;
  streaming: boolean;
}) {
  const blocks = normalize(content);

  // For user messages we just want the text — no thinking/tool blocks.
  if (isUser) {
    const text = blocks
      .filter((b): b is RawBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return <p className="whitespace-pre-wrap break-words">{text}</p>;
  }

  // Pair up tool_use with its tool_result (which may live in a sibling
  // message for non-streaming history; during streaming the parser
  // synthesizes both into the same assistant message).
  const toolResults = new Map<string, RawBlock & { type: 'tool_result' }>();
  for (const b of blocks) {
    if (b.type === 'tool_result') toolResults.set(b.tool_use_id, b);
  }

  const rendered: React.ReactNode[] = [];
  let textBuffer = '';
  let i = 0;

  const flushText = (key: string, withCursor: boolean) => {
    if (!textBuffer && !withCursor) return;
    rendered.push(
      <div key={key}>
        {textBuffer && <Markdown>{textBuffer}</Markdown>}
        {withCursor && <StreamingCursor />}
      </div>,
    );
    textBuffer = '';
  };

  for (const b of blocks) {
    if (b.type === 'text') {
      textBuffer += b.text;
    } else if (b.type === 'thinking') {
      flushText(`t-${i++}`, false);
      rendered.push(<ThinkingBlock key={`th-${i++}`} text={b.thinking} />);
    } else if (b.type === 'tool_use') {
      flushText(`t-${i++}`, false);
      const result = toolResults.get(b.id);
      const block: ToolBlock = {
        tool_use_id: b.id,
        name: b.name,
        input: b.input,
        status: result ? (result.is_error ? 'error' : 'done') : 'running',
        output: result?.content,
      };
      rendered.push(<ToolExecution key={`tu-${b.id}`} block={block} />);
    }
  }
  flushText(`t-end`, streaming);

  if (rendered.length === 0 && streaming) {
    return <StreamingCursor />;
  }
  return <>{rendered}</>;
}

function normalize(content: unknown): RawBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map((b): RawBlock | null => {
      if (!b || typeof b !== 'object') return null;
      const obj = b as Record<string, unknown>;
      const t = obj.type as string | undefined;
      if (t === 'text' && typeof obj.text === 'string') {
        return { type: 'text', text: obj.text };
      }
      if (t === 'thinking' && typeof obj.thinking === 'string') {
        return { type: 'thinking', thinking: obj.thinking };
      }
      if (t === 'tool_use') {
        return {
          type: 'tool_use',
          id: String(obj.id ?? ''),
          name: String(obj.name ?? ''),
          input: obj.input,
        };
      }
      if (t === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: String(obj.tool_use_id ?? ''),
          content: obj.content,
          is_error: Boolean(obj.is_error),
        };
      }
      return null;
    })
    .filter((b): b is RawBlock => b !== null);
}
