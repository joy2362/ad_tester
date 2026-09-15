import Link from "next/link";

const NAV = [
  { href: "/", label: "Ad Tag Taster", key: "tag" as const },
  { href: "/sites", label: "Site Checks", key: "sites" as const },
];

export default function BrandHeader({
  active,
  title,
  subtitle,
}: {
  active: "tag" | "sites";
  title: string;
  subtitle: string;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/viewsense-mark.svg" alt="ViewSense" className="mt-0.5 h-9 w-9 shrink-0" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="brand-gradient-text">ViewSense</span>{" "}
            <span className="font-semibold text-muted">{title}</span>
          </h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <nav className="mt-3 flex gap-1 text-xs">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`rounded-md px-2.5 py-1 ${
                  active === item.key
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-panel-2 hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
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
  );
}
