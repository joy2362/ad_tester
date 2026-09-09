"use client";

import { useMemo } from "react";
import { buildSandboxDocument, resolveInputType } from "@/lib/input";
import type { InputMode } from "@/lib/types";

export default function SandboxPreview({
  script,
  mode,
  width,
  height,
}: {
  script: string;
  mode: InputMode;
  width: number;
  height: number;
}) {
  const srcDoc = useMemo(() => {
    const resolved = resolveInputType(script, mode);
    return buildSandboxDocument(script, resolved);
  }, [script, mode]);

  return (
    <div className="rounded-lg border bg-white p-3">
      <p className="mb-2 text-[11px] text-neutral-500">
        Live re-run in a sandboxed iframe (client-side). Network capture and checks come from the
        headless run.
      </p>
      <div className="overflow-auto">
        <iframe
          title="Live ad sandbox"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          style={{ width, height, border: "1px solid #e5e5e5", background: "#fff" }}
        />
      </div>
    </div>
  );
}
