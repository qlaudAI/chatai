import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function LandingPage() {
  // Already signed in? Skip the marketing page.
  const { userId } = await auth();
  if (userId) redirect('/chat');

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
          <Logo />
          chatai
          <span className="ml-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            demo
          </span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <a
            href="https://github.com/qlaudAI/chatai"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            GitHub
          </a>
          <Link href="/sign-in" className="text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Sign up
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col justify-center py-16">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Open-source AI chat,
          <br />
          built on{' '}
          <a href="https://qlaud.ai" className="text-primary hover:underline">
            qlaud
          </a>
          .
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Per-user threads, tool integration via webhooks, semantic search,
          streaming UX, per-user billing — everything a real chat product
          needs. Fork the repo, swap three env-var sets, deploy.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try the demo →
          </Link>
          <a
            href="https://github.com/qlaudAI/chatai"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border px-5 py-3 text-sm font-medium hover:border-primary/40"
          >
            View source on GitHub
          </a>
        </div>

        <ul className="mt-12 grid gap-4 text-sm text-muted-foreground sm:grid-cols-2">
          <Feature title="Threads" detail="qlaud loads conversation history server-side." />
          <Feature title="Tools" detail="Webhook URL → qlaud handles the dispatch loop." />
          <Feature title="Search" detail="Semantic search across every past conversation." />
          <Feature title="Streaming" detail="Token-by-token reveal, persisted on close." />
        </ul>

        <p className="mt-12 text-xs text-muted-foreground">
          Built with Next.js, Clerk, and qlaud. MIT licensed.
        </p>
      </main>
    </div>
  );
}

function Feature({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="font-medium text-foreground">{title}</div>
      <div>{detail}</div>
    </li>
  );
}

function Logo() {
  // Dark square + white "q" + red dot accent, matching qlaud's monogram.
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-foreground text-[12px] font-bold text-background"
      aria-hidden
    >
      q<span className="text-primary">.</span>
    </span>
  );
}
