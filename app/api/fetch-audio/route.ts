import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url) return NextResponse.json({ error: "No URL provided" }, { status: 400 });

  const dir = "/tmp/reel_studio/audio";
  await mkdir(dir, { recursive: true });

  const id = randomUUID();
  // %(ext)s lets yt-dlp decide the real extension after conversion
  const outTemplate = path.join(dir, `audio_${id}.%(ext)s`);

  return new Promise<NextResponse>((resolve) => {
    const proc = spawn("yt-dlp", [
      "-x", "--audio-format", "mp3",
      "-o", outTemplate,
      // after_move:filepath prints the actual final path once done
      "--print", "after_move:filepath",
      "--no-simulate",
      url,
    ]);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(NextResponse.json({ error: "Download failed: " + stderr.slice(-400) }, { status: 500 }));
        return;
      }

      // yt-dlp prints the actual path as the last non-empty line
      const lines = stdout.trim().split("\n").map(l => l.trim()).filter(Boolean);
      const actualPath = lines[lines.length - 1];

      if (!actualPath) {
        resolve(NextResponse.json({ error: "Could not determine output path", raw: stdout }, { status: 500 }));
        return;
      }

      // Derive a friendly title from the path (filename without extension)
      const title = path.basename(actualPath, path.extname(actualPath)).replace(/^audio_[a-f0-9-]+$/, "Downloaded audio");

      resolve(NextResponse.json({ path: actualPath, title }));
    });
  });
}
