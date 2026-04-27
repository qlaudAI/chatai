# chatai

> Open-source, production-quality chat app built on **qlaud** + **Clerk**.
> Two services. Fork it, fill in two env-var sets, deploy to Vercel.

## What it shows off

- **Per-user conversations** — each user has their own threads, no shared `messages` table you have to build
- **Tool integration** — the assistant calls real business logic (web search, image gen) via webhooks; qlaud handles the entire dispatch loop
- **Semantic search** — search every past conversation with natural language; no vector DB to provision
- **Streaming UX** — text appears word-by-word, like every modern chat
- **Per-user billing** — hard spend caps enforced gateway-side; pull usage at month-end and bill how you want

What you DON'T build:
Postgres `messages` table, context-window loader, tool-call state machine,
embedding pipeline, vector store, conversation search, per-user cost
attribution. **No database to provision at all** — Clerk holds the
two-string mapping per user (qlaud key + initial thread id) in
`privateMetadata`.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) |
| Styling | Tailwind CSS |
| Auth + per-user state | Clerk (`privateMetadata`) |
| AI (threads, tools, search, streaming, billing) | qlaud |

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/qlaudAI/chatai.git
cd chatai
npm install

# 2. Copy env template + fill in your two accounts:
#    - Clerk: clerk.com → API Keys + Webhooks
#    - qlaud: qlaud.ai/keys → Master key
cp .env.example .env.local
# (edit .env.local)

# 3. Verify your env actually works (live probes Clerk + qlaud)
npm run check

# 4. Register the demo tools with qlaud (one-time, after your first deploy
#    so the webhook URLs point at your live host)
npm run register-tools

# 5. Dev — `npm run check` runs automatically as predev; if any required
#    env var is missing or wrong, dev refuses to start with a clear error.
npm run dev
```

### Required env vars

| Var | Where to get it |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | dashboard.clerk.com → API Keys |
| `CLERK_SECRET_KEY` | same |
| `CLERK_WEBHOOK_SECRET` | dashboard.clerk.com → Webhooks → endpoint pointed at `/api/webhooks/clerk` (subscribe `user.created`) |
| `QLAUD_MASTER_KEY` | console.qlaud.ai/keys (mint with scope `admin`) |

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FqlaudAI%2Fchatai)

Or any other Next.js host (Railway, Cloudflare Pages with the Workers
adapter, Netlify, your own).

After your first deploy: re-run `npm run register-tools` against the
live `NEXT_PUBLIC_APP_URL` so the tool webhooks point at your live host,
copy the printed signing secrets into your env vars, redeploy.

## Adding a tool

Tools are defined in [`src/lib/tools/definitions.ts`](src/lib/tools/definitions.ts).
Add a new entry there + a corresponding route handler at
`src/app/api/tools/<your-tool>/route.ts`, then re-run the register script.
qlaud handles the dispatch loop, signature verification, retries, parallel
fan-out — your handler just runs the business logic and returns
`{ output: any }`.

## License

MIT. See [LICENSE](LICENSE).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — one-page diagram of how
Clerk + qlaud fit together, plus a file map of the whole codebase.
