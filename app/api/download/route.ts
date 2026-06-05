import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { jobs } from "../process/route";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId || !jobs[jobId]?.output) {
    return NextResponse.json({ error: "Not ready" }, { status: 404 });
  }
  const buf = await readFile(jobs[jobId].output!);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="reel_${jobId.slice(0,8)}.mp4"`,
    },
  });
}
