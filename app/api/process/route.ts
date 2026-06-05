import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// In-memory job store (fine for local use)
export const jobs: Record<string, { progress: number; status: string; output?: string; error?: string }> = {};

export async function POST(req: NextRequest) {
  const cfg = await req.json();
  const jobId = randomUUID();
  const outputDir = path.join("/tmp/reel_studio", jobId);
  await mkdir(outputDir, { recursive: true });

  jobs[jobId] = { progress: 0, status: "Starting…" };

  const fullCfg = { ...cfg, job_id: jobId, output_dir: outputDir };
  const scriptPath = path.join(process.cwd(), "lib", "processor.py");

  const proc = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.write(JSON.stringify(fullCfg));
  proc.stdin.end();

  proc.stdout.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.startsWith("PROGRESS:")) {
        jobs[jobId].progress = parseInt(line.slice(9));
      } else if (line.startsWith("STATUS:")) {
        jobs[jobId].status = line.slice(7);
      } else if (line.startsWith("DONE:")) {
        jobs[jobId].output = line.slice(5).trim();
        jobs[jobId].progress = 100;
        jobs[jobId].status = "Done";
      } else if (line.startsWith("ERROR:")) {
        jobs[jobId].error = line.slice(6);
        jobs[jobId].status = "Error";
      }
    }
  });

  proc.stderr.on("data", (data: Buffer) => {
    // silently ignore python warnings
    const msg = data.toString();
    if (!msg.includes("UserWarning") && !msg.includes("FP16")) {
      jobs[jobId].status = msg.slice(0, 100);
    }
  });

  proc.on("close", (code) => {
    if (code !== 0 && !jobs[jobId].output) {
      jobs[jobId].status = "Error";
      jobs[jobId].error = `Exit code ${code}`;
    }
  });

  return NextResponse.json({ job_id: jobId });
}
