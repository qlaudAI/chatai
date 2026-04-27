// Parses qlaud's SSE stream into a typed event stream the React UI
// can consume. Used by the client InputBar component; the API route
// is a pure passthrough that pipes the upstream SSE straight to the
// browser without parsing.
//
// qlaud emits two flavours of events:
//   1. Standard Anthropic events (message_start, content_block_*,
//      message_delta, message_stop) for the actual model output.
//   2. qlaud-injected events (qlaud.iteration_start,
//      qlaud.tool_dispatch_start, qlaud.tool_dispatch_done, qlaud.done,
//      qlaud.error) for the multi-iteration tool loop progress.
//
// One stream may contain MULTIPLE message_start...message_stop brackets
// — one per tool-loop iteration. Block indexes reset per iteration, so
// the consumer must track which iteration each block belongs to (or
// use stable tool_use_ids to match results to uses).

export type StreamEvent =
  | { type: 'message_start'; iteration: number; messageId: string }
  | { type: 'text_delta'; iteration: number; index: number; text: string }
  | { type: 'thinking_delta'; iteration: number; index: number; text: string }
  | {
      type: 'tool_use_start';
      iteration: number;
      index: number;
      tool_use_id: string;
      name: string;
    }
  | {
      type: 'tool_use_input_delta';
      iteration: number;
      index: number;
      partial_json: string;
    }
  | { type: 'content_block_stop'; iteration: number; index: number }
  | { type: 'message_stop'; iteration: number; stop_reason: string | null }
  | {
      type: 'tool_dispatch_start';
      iteration: number;
      tool_use_id: string;
      name: string;
    }
  | {
      type: 'tool_dispatch_done';
      iteration: number;
      tool_use_id: string;
      name: string;
      is_error: boolean;
      output: unknown;
    }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'done'; iterations: number; hit_max_iterations: boolean }
  | { type: 'error'; message: string; status?: number; iteration?: number };

/** Async generator that reads the chat-API SSE response and yields
 *  typed events. */
export async function* parseChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  // Track current iteration so events reference the right turn. Starts
  // at 1 (the implicit first iteration); qlaud.iteration_start for 2+
  // bumps it.
  const state = { iteration: 1, lastStopReason: null as string | null };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const events = parseEvent(raw, state);
        for (const e of events) yield e;
      }
    }
    if (buffer.length > 0) {
      const events = parseEvent(buffer, state);
      for (const e of events) yield e;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(
  raw: string,
  state: { iteration: number; lastStopReason: string | null },
): StreamEvent[] {
  let dataLine = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      dataLine = line.slice(6);
      break;
    }
  }
  if (!dataLine || dataLine === '[DONE]') return [];

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLine);
  } catch {
    return [];
  }
  const type = payload.type as string | undefined;
  if (!type) return [];

  switch (type) {
    case 'qlaud.iteration_start': {
      const iter = (payload.iteration as number) ?? state.iteration + 1;
      state.iteration = iter;
      return [{ type: 'iteration_start', iteration: iter }];
    }
    case 'qlaud.tool_dispatch_start': {
      return [
        {
          type: 'tool_dispatch_start',
          iteration: (payload.iteration as number) ?? state.iteration,
          tool_use_id: String(payload.tool_use_id),
          name: String(payload.name),
        },
      ];
    }
    case 'qlaud.tool_dispatch_done': {
      return [
        {
          type: 'tool_dispatch_done',
          iteration: (payload.iteration as number) ?? state.iteration,
          tool_use_id: String(payload.tool_use_id),
          name: String(payload.name),
          is_error: Boolean(payload.is_error),
          output: payload.output,
        },
      ];
    }
    case 'qlaud.done': {
      return [
        {
          type: 'done',
          iterations: (payload.iterations as number) ?? state.iteration,
          hit_max_iterations: Boolean(payload.hit_max_iterations),
        },
      ];
    }
    case 'qlaud.error': {
      return [
        {
          type: 'error',
          message: String(payload.message ?? 'unknown error'),
          status: typeof payload.status === 'number' ? payload.status : undefined,
          iteration:
            typeof payload.iteration === 'number' ? payload.iteration : undefined,
        },
      ];
    }
    case 'message_start': {
      const msg = payload.message as { id?: string } | undefined;
      return [
        {
          type: 'message_start',
          iteration: state.iteration,
          messageId: msg?.id ?? '',
        },
      ];
    }
    case 'content_block_start': {
      const index = (payload.index as number) ?? 0;
      const cb = payload.content_block as Record<string, unknown> | undefined;
      if (!cb) return [];
      if (cb.type === 'tool_use') {
        return [
          {
            type: 'tool_use_start',
            iteration: state.iteration,
            index,
            tool_use_id: String(cb.id),
            name: String(cb.name),
          },
        ];
      }
      // text/thinking blocks open without payload — deltas carry content.
      return [];
    }
    case 'content_block_delta': {
      const index = (payload.index as number) ?? 0;
      const delta = payload.delta as Record<string, unknown> | undefined;
      if (!delta) return [];
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        return [
          { type: 'text_delta', iteration: state.iteration, index, text: delta.text },
        ];
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return [
          {
            type: 'thinking_delta',
            iteration: state.iteration,
            index,
            text: delta.thinking,
          },
        ];
      }
      if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        return [
          {
            type: 'tool_use_input_delta',
            iteration: state.iteration,
            index,
            partial_json: delta.partial_json,
          },
        ];
      }
      return [];
    }
    case 'content_block_stop': {
      return [
        {
          type: 'content_block_stop',
          iteration: state.iteration,
          index: (payload.index as number) ?? 0,
        },
      ];
    }
    case 'message_delta': {
      const delta = payload.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) state.lastStopReason = delta.stop_reason;
      return [];
    }
    case 'message_stop': {
      return [
        {
          type: 'message_stop',
          iteration: state.iteration,
          stop_reason: state.lastStopReason,
        },
      ];
    }
    default:
      return [];
  }
}
