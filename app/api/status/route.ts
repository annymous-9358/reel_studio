import { NextRequest, NextResponse } from "next/server";
import { jobs } from "../process/route";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId || !jobs[jobId]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  return NextResponse.json(jobs[jobId]);
}
