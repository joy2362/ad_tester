import { NextResponse } from "next/server";
import { deleteRun, getRun } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = getRun(id);
  if (!record) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ record });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteRun(id);
  if (!ok) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
