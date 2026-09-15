import AdTester from "@/components/AdTester";
import BrandHeader from "@/components/BrandHeader";

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
      <BrandHeader
        active="tag"
        title="Ad Tag Taster"
        subtitle="Paste an ad tag or script, run it in a real headless Chromium sandbox, and inspect every request, cookie, error and creative it produces."
      />
      <AdTester />
    </main>
  );
}
