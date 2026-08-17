/**
 * Home — the landing page (root `/`).
 *
 * Presents every supported Event as a non-sequential map, followed by the
 * primary documentation destinations. Server-rendered with no client JS.
 */

import owlAvatar from '../assets/owl_avatar.png';

const REFERENCE_TASKS = [
  { glyph: '⚠', title: 'Block a dangerous command', href: '/getting-started/first-hook', kind: 'tutorial' as const },
  { glyph: '⌘', title: 'Subscribe to the right Event', href: '/reference/events', kind: 'reference' as const },
  { glyph: '▶', title: 'Pick an Action for an outcome', href: '/reference/configuration/action', kind: 'reference' as const },
  { glyph: '◈', title: 'Review the trust boundary', href: '/concepts/security', kind: 'concept' as const },
];

const TASK_KIND_LABEL: Record<(typeof REFERENCE_TASKS)[number]['kind'], string> = {
  tutorial: 'tutorial',
  reference: 'reference',
  concept: 'concept',
};

const BLURB =
  'A hook engine for Pi, the agent runtime you are reading this in. ' +
  'You define a Hook — a small policy that subscribes to a Pi Event. ' +
  'When the Event happens, HooKit runs your Hook’s shell decision and ' +
  'may deliver one outcome-selected Pi Action.';

const EVENTS = [
  { name: 'tool_call', hookOutcome: 'pass / block', source: 'Pi · before a tool runs' },
  { name: 'tool_result', hookOutcome: 'pass / patch', source: 'Pi · after a tool returns' },
  { name: 'turn_end', hookOutcome: 'pass / report', source: 'Pi · at the end of a turn' },
  { name: 'agent_end', hookOutcome: 'pass / report', source: 'Pi · after the agent loop ends' },
  { name: 'agent_settled', hookOutcome: 'pass / report', source: 'Pi · when the agent settles' },
  { name: 'session_before_switch', hookOutcome: 'pass / cancel', source: 'Pi · before a session switch' },
  { name: 'session_before_fork', hookOutcome: 'pass / cancel', source: 'Pi · before a session fork' },
  { name: 'hook_result', hookOutcome: 'pass / report', source: 'HooKit · once per originating result' },
];

const GETTING_STARTED = [
  {
    title: 'Installation',
    body: 'Install HooKit globally or for one trusted Pi project and verify that /hooks is available.',
    href: '/getting-started/installation',
  },
  {
    title: 'Write a hook',
    body: 'Build a dependency-free safety policy against a dummy .env, with an expected result at every step.',
    href: '/getting-started/first-hook',
  },
  {
    title: 'Explore the library',
    body: 'Find stable Core Hooks and specialized HooKit Extras.',
    href: '/getting-started/library',
  },
];

const SECURITY_NOTE =
  'Hook shells execute locally as trusted code with your Pi process ' +
  'permissions. A timeout is not a sandbox. Treat repository Hooks like any ' +
  'third-party code and review their Source before installation.';

export function Home() {
  return (
    <div className="min-h-screen bg-[#f4f6f4] text-[#242621]">
      <header className="sticky top-0 z-20 border-b border-[#dde3dd] bg-[#f4f6f4]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="/" className="flex items-center gap-2 font-semibold tracking-tight text-[#26423a]">
            🦉 HooKit
          </a>
          <a href="/getting-started" className="text-sm text-[#556158] transition-colors hover:text-[#367867]">
            Documentation
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* hero — clay owl avatar on the left, pitch on the right */}
        <section className="pb-10 pt-12">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,300px)_1fr] lg:gap-16">
            <div className="mx-auto w-fit lg:mx-0">
              <img
                src={owlAvatar.src}
                alt="HooKit owl mascot — a small clay owl figurine"
                width={1192}
                height={1320}
                loading="eager"
                className="h-auto w-[230px] drop-shadow-[0_18px_28px_rgba(38,66,58,0.25)] sm:w-[270px] lg:w-full"
              />
            </div>
            <div className="text-center lg:text-left">
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-[#367867]">
                event → hook → outcome → action
              </p>
              <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-[#1f322b] sm:text-5xl lg:mx-0">
                Your policy plugs into the <span className="text-[#367867]">Pi lifecycle</span>.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-[#66706a] lg:mx-0">{BLURB}</p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
                <a
                  href="/getting-started"
                  className="rounded-lg bg-[#26423a] px-6 py-3 text-sm font-semibold text-[#f2f7f4] transition hover:bg-[#1f3831]"
                >
                  Getting Started
                </a>
                <a
                  href="/reference/events"
                  className="rounded-lg border border-[#c8d2cb] bg-white px-6 py-3 text-sm font-medium text-[#3d463f] transition hover:border-[#367867] hover:text-[#367867]"
                >
                  See every event
                </a>
              </div>
              <p className="mt-7 text-sm text-[#8a948d]">
                Config in{' '}
                <code className="rounded border border-[#ced8d1] bg-white px-1.5 py-0.5 font-mono text-[13px] text-[#367867]">
                  .pi/hookit.json
                </code>
                {' · '}managed from{' '}
                <a
                  href="/reference/hooks-panel"
                  className="font-medium text-[#367867] underline decoration-dotted underline-offset-4"
                >
                  /hooks
                </a>
              </p>
            </div>
          </div>
        </section>

        {/* supported Events — a map, not a sequence */}
        <section className="pb-14">
          <div className="grid gap-3 pb-4 sm:grid-cols-2 lg:grid-cols-4">
            {EVENTS.map((event) => (
              <div
                key={event.name}
                className="rounded-2xl border border-[#c8d2cb] bg-white/70 px-4 py-4 text-center shadow-sm"
              >
                <p className="font-mono text-sm font-semibold text-[#26423a]">{event.name}</p>
                <p className="mt-1.5 font-mono text-[11px] text-[#367867]">{event.hookOutcome}</p>
                <p className="mt-1.5 text-[11px] leading-snug text-[#8a948d]">{event.source}</p>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-[#c8d2cb] bg-[#eef3f0] px-6 py-5 text-center text-sm leading-relaxed text-[#4d5a53]">
            A <strong className="font-semibold text-[#26423a]">Hook</strong> subscribes to one Event. Pi emits the seven
            Native Events; HooKit projects <code className="font-mono text-[#26423a]">hook_result</code> once for each
            originating Hook Result. The Native Event Outcome is frozen before owned Actions and reactive Hooks run.{' '}
            <a
              href="/reference/events"
              className="font-medium text-[#367867] underline decoration-dotted underline-offset-2"
            >
              Events reference
            </a>
          </div>
        </section>

        {/* start + reference — both cards stretch to the same height */}
        <section className="grid items-stretch gap-10 pb-16 lg:grid-cols-2">
          <div className="flex h-full flex-col rounded-3xl border border-[#c8d2cb] bg-white p-8 shadow-sm">
            <h3 className="text-lg font-semibold text-[#1f322b]">Start here</h3>
            <div className="mt-5 space-y-3">
              {GETTING_STARTED.map((g, i) => (
                <a
                  key={g.href}
                  href={g.href}
                  className="group flex items-center gap-4 rounded-xl border border-[#e1e6e2] bg-[#fafbfa] px-4 py-3 transition hover:border-[#367867]"
                >
                  <span className="font-mono text-xs text-[#367867]">0{i + 1}</span>
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-[#26423a] group-hover:text-[#367867]">
                      {g.title}
                    </span>
                    <span className="block text-xs text-[#8a948d]">{g.body}</span>
                  </span>
                  <span className="text-[#367867] transition group-hover:translate-x-0.5">→</span>
                </a>
              ))}
            </div>
          </div>
          {/* reference card */}
          <div className="flex h-full flex-col rounded-3xl border border-[#c8d2cb] bg-white p-8 shadow-sm">
            <div className="flex items-baseline justify-between">
              <h3 className="text-lg font-semibold text-[#1f322b]">Reference</h3>
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#9aa49d]">
                field-by-field · schema-backed
              </span>
            </div>
            <p className="mt-2 text-sm leading-snug text-[#66706a]">
              The contract behind every field in{' '}
              <code className="rounded bg-[#f0f4f1] px-1 font-mono text-[12px] text-[#367867]">schema.json</code>.
            </p>
            <div className="mt-4 border-t border-[#e6eae6] pt-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-[#9aa49d]">
                what do you want to do?
              </span>
            </div>
            <div className="mt-1 space-y-0.5">
              {REFERENCE_TASKS.map((item) => (
                <a
                  key={item.title}
                  href={item.href}
                  className="group flex items-baseline gap-3 rounded-lg px-2 py-1.5 transition hover:bg-[#f2f6f3]"
                >
                  <span className="w-5 shrink-0 text-center text-sm text-[#367867]">{item.glyph}</span>
                  <span className="flex-1 text-sm text-[#26423a] group-hover:text-[#367867]">{item.title}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-[#a5aea9]">
                    {TASK_KIND_LABEL[item.kind]}
                  </span>
                  <span className="translate-x-0 text-[#367867] opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100">
                    →
                  </span>
                </a>
              ))}
            </div>
            <a
              href="/reference/configuration"
              className="group mt-auto flex items-center justify-between border-t border-[#e6eae6] pt-4 text-sm font-semibold text-[#367867]"
            >
              Browse the full Reference
              <span className="transition group-hover:translate-x-0.5">→</span>
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#dde3dd] bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-xs leading-relaxed text-[#8a948d]">
          <p className="max-w-2xl">
            <span className="font-mono font-semibold text-[#26423a]">security:</span> {SECURITY_NOTE}
          </p>
          <div className="font-mono text-[#26423a]">🦉 HooKit</div>
        </div>
      </footer>
    </div>
  );
}
