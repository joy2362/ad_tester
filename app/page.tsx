import AdTester from "@/components/AdTester";

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/viewsense-mark.svg" alt="ViewSense" className="mt-0.5 h-9 w-9 shrink-0" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="brand-gradient-text">ViewSense</span>{" "}
              <span className="font-semibold text-muted">Ad Tester</span>
            </h1>
            <p className="mt-1 text-sm text-muted">
              Paste an ad tag or script, run it in a real headless Chromium sandbox, and inspect every
              request, cookie, error and creative it produces.
            </p>
          </div>
        </div>
        <a
          href="https://playwright.dev"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted hover:text-foreground"
        >
          headless engine: Chromium via Playwright
        </a>
      </header>
      <AdTester />
    </main>
  );
}
