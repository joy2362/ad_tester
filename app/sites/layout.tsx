import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Site Checks · ViewSense",
  description: "Visit publisher pages in a real browser and screenshot / record where an ad actually serves.",
};

export default function SitesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
