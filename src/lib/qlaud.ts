import 'server-only';
import { env } from './env';

// Typed wrapper over the qlaud REST API. Single source of truth for all
// qlaud calls in the app — handlers and server components import from
// here and don't touch fetch() directly.
//
// SECURITY: this module is server-only. The `import 'server-only'` line
// at the top makes Next.js refuse to bundle it for the browser — any
// client component that imports the runtime `qlaud` object (instead of
// just types) will fail the build. The master key (env.QLAUD_MASTER_KEY)
// and per-user secrets must never reach the browser; they grant the
// ability to mint new keys and burn the spend cap.
//
// Two auth patterns:
//   - Master key: used for /v1/keys, /v1/tools, /v1/usage.
//   - Per-user key: minted at signup, stashed in Clerk privateMetadata,
//     read via lib/user-state.ts. Used for /v1/threads/* and /v1/search.

const BASE = () => env.QLAUD_BASE_URL();
const MASTER = () => env.QLAUD_MASTER_KEY();

type Json = Record<string, unknown>;

async function call<T = Json>(
  path: string,
  init: RequestInit & { apiKey?: string } = {},
): Promise<T> {
  const apiKey = init.apiKey ?? MASTER();
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${BASE()}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new QlaudError(res.status, `${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export class QlaudError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'QlaudError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

type ApiKeyMintResult = {
  id: string;
  name: string;
  prefix: string;
  scope: 'standard' | 'admin';
  secret: string; // returned ONCE
  max_spend_usd: number | null;
};

export type Thread = {
  id: string;
  object: 'thread';
  end_user_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
  last_active_at: number;
};

export type ThreadMessage = {
  seq: number;
  role: 'user' | 'assistant';
  content: unknown;
  request_id: string | null;
  created_at: number;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  webhook_url: string;
  timeout_ms?: number;
};

type ToolRegisterResult = ToolDefinition & {
  id: string;
  secret: string; // returned ONCE
};

export type SearchHit = {
  thread_id: string;
  seq: number;
  role: string;
  snippet: string;
  score: number;
  created_at: number;
};

// ─── API surface ────────────────────────────────────────────────────────────

export const qlaud = {
  /** POST /v1/keys — mint a per-user key with a hard spend cap. */
  mintKey: (args: {
    name: string;
    scope?: 'standard' | 'admin';
    maxSpendUsd?: number | null;
  }) =>
    call<ApiKeyMintResult>('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: args.name,
        scope: args.scope ?? 'standard',
        max_spend_usd: args.maxSpendUsd ?? null,
      }),
    }),

  /** POST /v1/threads — create a new conversation. */
  createThread: (args: {
    apiKey: string;
    endUserId?: string;
    metadata?: Record<string, unknown>;
  }) =>
    call<Thread>('/v1/threads', {
      method: 'POST',
      apiKey: args.apiKey,
      body: JSON.stringify({
        end_user_id: args.endUserId,
        metadata: args.metadata,
      }),
    }),

  /** GET /v1/threads — list threads for the caller. */
  listThreads: (args: {
    apiKey: string;
    endUserId?: string;
    limit?: number;
  }) => {
    const url = new URL(`${BASE()}/v1/threads`);
    if (args.endUserId) url.searchParams.set('end_user_id', args.endUserId);
    url.searchParams.set('limit', String(args.limit ?? 20));
    return fetch(url, { headers: { 'x-api-key': args.apiKey } }).then(
      async (r) => {
        if (!r.ok) {
          throw new QlaudError(r.status, `listThreads → ${r.status}`);
        }
        return (await r.json()) as { object: 'list'; data: Thread[] };
      },
    );
  },

  /** GET /v1/threads/:id/messages — full history of a single thread. */
  listThreadMessages: (args: { apiKey: string; threadId: string; limit?: number }) => {
    const url = new URL(`${BASE()}/v1/threads/${args.threadId}/messages`);
    url.searchParams.set('limit', String(args.limit ?? 100));
    return fetch(url, { headers: { 'x-api-key': args.apiKey } }).then(
      async (r) => {
        if (!r.ok) {
          throw new QlaudError(r.status, `listThreadMessages → ${r.status}`);
        }
        return (await r.json()) as {
          object: 'list';
          data: ThreadMessage[];
          has_more: boolean;
          next_after_seq: number | null;
        };
      },
    );
  },

  /** POST /v1/threads/:id/messages — non-streaming. Returns the full
   *  assistant turn (text + thinking + tool_use/tool_result blocks)
   *  after qlaud has run the tool dispatch loop to completion.
   *
   *  Why not streaming: as of v1, qlaud doesn't allow `stream: true`
   *  combined with `tools`. We pick tools (the substrate showcase)
   *  over the streaming cursor. Once qlaud lifts that restriction,
   *  this becomes a streaming proxy again.
   */
  sendMessage: async (args: {
    apiKey: string;
    threadId: string;
    body: Record<string, unknown>;
  }): Promise<Response> => {
    return fetch(`${BASE()}/v1/threads/${args.threadId}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': args.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args.body),
    });
  },

  /** GET /v1/search — semantic search across the caller's threads. */
  search: async (args: {
    apiKey: string;
    query: string;
    endUserId?: string;
    threadId?: string;
    limit?: number;
  }) => {
    const url = new URL(
      args.threadId
        ? `${BASE()}/v1/threads/${args.threadId}/search`
        : `${BASE()}/v1/search`,
    );
    url.searchParams.set('q', args.query);
    if (args.endUserId) url.searchParams.set('end_user_id', args.endUserId);
    url.searchParams.set('limit', String(args.limit ?? 10));
    const r = await fetch(url, { headers: { 'x-api-key': args.apiKey } });
    if (!r.ok) throw new QlaudError(r.status, `search → ${r.status}`);
    return (await r.json()) as { object: 'list'; query: string; data: SearchHit[] };
  },

  /** DELETE /v1/keys/:id — revoke a per-user key. Master-scope only.
   *  Idempotent: 404 on an already-deleted key is treated as success
   *  so re-deliveries of user.deleted don't bounce the webhook. */
  revokeKey: async (keyId: string) => {
    const r = await fetch(`${BASE()}/v1/keys/${keyId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': MASTER() },
    });
    if (r.ok || r.status === 404) return;
    const text = await r.text().catch(() => '');
    throw new QlaudError(r.status, `revokeKey → ${r.status}: ${text.slice(0, 200)}`);
  },

  /** POST /v1/tools — register a tool. Master-scope only. */
  registerTool: (def: ToolDefinition) =>
    call<ToolRegisterResult>('/v1/tools', {
      method: 'POST',
      body: JSON.stringify(def),
    }),

  /** GET /v1/tools — list registered tools. */
  listTools: () =>
    call<{ object: 'list'; data: Array<ToolRegisterResult> }>('/v1/tools'),
};
