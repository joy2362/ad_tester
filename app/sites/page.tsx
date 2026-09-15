import BrandHeader from "@/components/BrandHeader";
import SiteChecker from "@/components/SiteChecker";

export default function SitesPage() {
  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
      <BrandHeader
        active="sites"
        title="Site Checks"
        subtitle="List the publisher pages a campaign should be live on, visit each one in a real browser, and screenshot (or record) what's actually there."
      />
      <SiteChecker />
    </main>
  );
}
