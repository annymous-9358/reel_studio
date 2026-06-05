import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdir, readdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

const TIMEOUT_MS = 90_000; // 90 seconds max

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url) return NextResponse.json({ error: "No URL provided" }, { status: 400 });

  const dir = "/tmp/reel_studio/audio";
  await mkdir(dir, { recursive: true });

  const id = randomUUID();
  // Use a unique prefix; %(ext)s lets yt-dlp pick the real extension
  const outTemplate = path.join(dir, `audio_${id}.%(ext)s`);

  return new Promise<NextResponse>((resolve) => {
    let settled = false;
    const finish = (r: NextResponse) => {
      if (!settled) { settled = true; resolve(r); }
    };

    const proc = spawn("yt-dlp", [
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "5",        // smaller file, faster
      "--socket-timeout", "20",      // fail fast if server is unresponsive
      "--retries", "2",
      "-o", outTemplate,
      url,
    ]);

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Hard timeout — kills yt-dlp if it hangs (Instagram blocks, slow server, etc.)
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(NextResponse.json(
        { error: "Download timed out (90s). Instagram often blocks server downloads — try uploading the audio file directly instead." },
        { status: 504 }
      ));
    }, TIMEOUT_MS);

    proc.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(NextResponse.json(
          { error: `yt-dlp failed (code ${code}). ${stderr.slice(-300)}` },
          { status: 500 }
        ));
        return;
      }

      // Find the file yt-dlp wrote — glob for audio_<id>.* in the dir
      try {
        const files = await readdir(dir);
        const match = files.find(f => f.startsWith(`audio_${id}`));
        if (!match) {
          finish(NextResponse.json({ error: "Download finished but file not found." }, { status: 500 }));
          return;
        }
        const actualPath = path.join(dir, match);
        const title = match.replace(/^audio_[a-f0-9-]+\./, "").replace(/\.\w+$/, "") || "Downloaded audio";
        finish(NextResponse.json({ path: actualPath, title: "Downloaded audio" }));
      } catch (e) {
        finish(NextResponse.json({ error: String(e) }, { status: 500 }));
      }
    });
  });
}
