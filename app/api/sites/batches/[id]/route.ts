import { NextResponse } from "next/server";
import { deleteSiteBatch, getSiteBatch } from "@/lib/siteDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getSiteBatch(id);
  if (!record) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ record });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteSiteBatch(id);
  if (!ok) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
