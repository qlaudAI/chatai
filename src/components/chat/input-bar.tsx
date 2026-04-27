'use client';

import { useRef, useState } from 'react';
import type { ThreadMessage } from '@/lib/qlaud';
import { parseChatStream } from '@/lib/qlaud-stream';

// Composes the user's message and runs the streaming turn.
//
// qlaud's streaming-with-tools handler emits one logical turn per
// tool-loop iteration (e.g. iter 1 = "let me search…" + tool_use,
// iter 2 = "here's what I found"). We render each iteration as its
// OWN assistant message so the conversation reads in order:
//
//   user:      "what's the weather in SF?"
//   assistant: "let me check the weather…  [web_search ✓]"
//   assistant: "It's 72°F and sunny in San Francisco."
//
// This matches how Claude.ai's UI renders multi-step tool use and
// keeps each iteration's blocks contained instead of stuffing them
// all into a single mega-bubble.
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
    // Unique negative seqs per turn so optimistic placeholders don't
    // collide with each other or with persisted positive seqs.
    const turnId = now;
    const userPlaceholderSeq = -turnId * 1000;
    const seqForIteration = (iter: number) => -turnId * 1000 - iter;

    const errorMessage = (msg: string, iter: number): ThreadMessage => ({
      seq: seqForIteration(iter),
      role: 'assistant',
      content: [{ type: 'text', text: `⚠️ ${msg}` }],
      request_id: null,
      created_at: Date.now(),
    });

    onTurnStart({
      seq: userPlaceholderSeq,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      request_id: null,
      created_at: now,
    });

    // First iteration's placeholder so the cursor renders immediately.
    onAssistantUpdate({
      seq: seqForIteration(1),
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
      onAssistantUpdate(errorMessage(`network error: ${(e as Error).message}`, 1));
      onTurnEnd();
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      let parsed: { error?: string; detail?: string } | null = null;
      try {
        parsed = detail ? JSON.parse(detail) : null;
      } catch {
        /* not JSON, fall through */
      }
      const msg =
        parsed?.detail || parsed?.error || detail.slice(0, 300) || `HTTP ${res.status}`;
      onAssistantUpdate(errorMessage(msg, 1));
      onTurnEnd();
      return;
    }

    // Per-iteration accumulator state. Each iteration starts fresh
    // (block indexes reset on every message_start from upstream).
    type Block =
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | {
          type: 'tool_use';
          id: string;
          name: string;
          input_json: string;
          input?: unknown;
          status?: 'running' | 'done' | 'error';
          output?: unknown;
        };

    const iterations = new Map<
      number,
      { blocks: Map<number, Block>; order: number[] }
    >();

    // Cross-iteration map: tool_use_id → { iteration, index } so a
    // qlaud.tool_dispatch_done event from iter 1 can update the right
    // tool_use block even after iter 2 has started streaming text.
    const toolUseLocations = new Map<
      string,
      { iteration: number; index: number }
    >();

    const ensureIteration = (iter: number) => {
      if (!iterations.has(iter)) {
        iterations.set(iter, { blocks: new Map(), order: [] });
      }
      return iterations.get(iter)!;
    };

    const buildIterationSnapshot = (iter: number): ThreadMessage => {
      const it = iterations.get(iter);
      const content = it
        ? it.order
            .map((i) => it.blocks.get(i))
            .filter((b): b is Block => Boolean(b))
            .flatMap((b): unknown[] => {
              if (b.type === 'tool_use') {
                let input: unknown = b.input;
                if (input === undefined && b.input_json) {
                  try {
                    input = JSON.parse(b.input_json);
                  } catch {
                    input = b.input_json;
                  }
                }
                const blocks: unknown[] = [
                  { type: 'tool_use', id: b.id, name: b.name, input },
                ];
                // Inline the tool_result as a sibling block when it
                // arrives, so MessageStream's existing renderer (which
                // pairs tool_use ↔ tool_result by tool_use_id) shows
                // status correctly.
                if (b.status === 'done' || b.status === 'error') {
                  blocks.push({
                    type: 'tool_result',
                    tool_use_id: b.id,
                    content:
                      typeof b.output === 'string' ? b.output : JSON.stringify(b.output),
                    is_error: b.status === 'error',
                  });
                }
                return blocks;
              }
              return [b];
            })
        : [];
      return {
        seq: seqForIteration(iter),
        role: 'assistant',
        content,
        request_id: null,
        created_at: Date.now(),
      };
    };

    const ensureBlock = (iter: number, idx: number, block: Block) => {
      const it = ensureIteration(iter);
      if (!it.blocks.has(idx)) {
        it.blocks.set(idx, block);
        it.order.push(idx);
      }
    };

    let sawAnyEvent = false;
    let lastEmittedIteration = 1;

    try {
      for await (const ev of parseChatStream(res.body)) {
        sawAnyEvent = true;

        if (ev.type === 'iteration_start') {
          // Push a fresh placeholder for this iteration so the cursor
          // shows while we wait for its first content_block.
          onAssistantUpdate({
            seq: seqForIteration(ev.iteration),
            role: 'assistant',
            content: [],
            request_id: null,
            created_at: Date.now(),
          });
          lastEmittedIteration = ev.iteration;
          continue;
        }

        if (ev.type === 'tool_dispatch_start') {
          const loc = toolUseLocations.get(ev.tool_use_id);
          if (loc) {
            const it = iterations.get(loc.iteration);
            const block = it?.blocks.get(loc.index);
            if (block && block.type === 'tool_use') block.status = 'running';
            onAssistantUpdate(buildIterationSnapshot(loc.iteration));
          }
          continue;
        }

        if (ev.type === 'tool_dispatch_done') {
          const loc = toolUseLocations.get(ev.tool_use_id);
          if (loc) {
            const it = iterations.get(loc.iteration);
            const block = it?.blocks.get(loc.index);
            if (block && block.type === 'tool_use') {
              block.status = ev.is_error ? 'error' : 'done';
              block.output = ev.output;
            }
            onAssistantUpdate(buildIterationSnapshot(loc.iteration));
          }
          continue;
        }

        if (ev.type === 'error') {
          onAssistantUpdate(errorMessage(ev.message, ev.iteration ?? lastEmittedIteration));
          continue;
        }

        if (ev.type === 'done' || ev.type === 'message_stop') {
          continue;
        }

        // Standard Anthropic content events — applied to the matching
        // iteration's accumulator.
        const iter = ev.iteration;
        switch (ev.type) {
          case 'message_start':
            ensureIteration(iter);
            break;
          case 'text_delta': {
            const it = ensureIteration(iter);
            const existing = it.blocks.get(ev.index);
            if (existing && existing.type === 'text') {
              existing.text += ev.text;
            } else {
              ensureBlock(iter, ev.index, { type: 'text', text: ev.text });
            }
            break;
          }
          case 'thinking_delta': {
            const it = ensureIteration(iter);
            const existing = it.blocks.get(ev.index);
            if (existing && existing.type === 'thinking') {
              existing.thinking += ev.text;
            } else {
              ensureBlock(iter, ev.index, { type: 'thinking', thinking: ev.text });
            }
            break;
          }
          case 'tool_use_start': {
            ensureBlock(iter, ev.index, {
              type: 'tool_use',
              id: ev.tool_use_id,
              name: ev.name,
              input_json: '',
            });
            toolUseLocations.set(ev.tool_use_id, { iteration: iter, index: ev.index });
            break;
          }
          case 'tool_use_input_delta': {
            const it = ensureIteration(iter);
            const existing = it.blocks.get(ev.index);
            if (existing && existing.type === 'tool_use') {
              existing.input_json += ev.partial_json;
            }
            break;
          }
          case 'content_block_stop':
            break;
        }
        lastEmittedIteration = iter;
        onAssistantUpdate(buildIterationSnapshot(iter));
      }
    } catch (e) {
      onAssistantUpdate(
        errorMessage(`stream interrupted: ${(e as Error).message}`, lastEmittedIteration),
      );
    } finally {
      if (!sawAnyEvent) {
        onAssistantUpdate(
          errorMessage(
            'upstream returned no events. Check Vercel function logs for /api/chat.',
            1,
          ),
        );
      }
      onTurnEnd();
    }
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
