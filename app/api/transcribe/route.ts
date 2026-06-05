import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

export async function POST(req: NextRequest) {
  const { audio_path, audio_url, language = "auto" } = await req.json();
  if (!audio_path && !audio_url) {
    return NextResponse.json({ error: "Provide audio_path or audio_url" }, { status: 400 });
  }

  // language: "auto" | "en" | "hi" | "hinglish"
  // "hinglish" = transcribe Hindi audio but output in Roman script
  const script = `
import ssl, json, sys, os, subprocess, tempfile
ssl._create_default_https_context = ssl._create_unverified_context

audio_src = sys.argv[1]   # file path or "URL:<url>"
language   = sys.argv[2]  # auto / en / hi / hinglish

tmp_file = None

# ── Download from URL if needed ───────────────────────────────────────
if audio_src.startswith("URL:"):
    url = audio_src[4:]
    tmp_file = tempfile.mktemp(suffix=".mp3")
    result = subprocess.run(
        ["yt-dlp", "-x", "--audio-format", "mp3", "-o", tmp_file, url],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(json.dumps({"error": "yt-dlp failed: " + result.stderr[-300:]}))
        sys.exit(0)
    audio_src = tmp_file

import whisper
model = whisper.load_model("small")

kwargs = {"word_timestamps": True, "verbose": False}

if language == "hinglish":
    # Prompt Whisper to write Hindi sounds in Roman/English letters
    kwargs["language"] = "hi"
    kwargs["initial_prompt"] = (
        "Transcribe exactly what is said. Write all Hindi words using Roman English "
        "letters (Hinglish), for example: 'Ankhon ka nasha gulabi' not Devanagari."
    )
elif language == "hi":
    kwargs["language"] = "hi"
elif language == "en":
    kwargs["language"] = "en"
# else auto-detect

result = model.transcribe(audio_src, **kwargs)

words = []
for seg in result["segments"]:
    for w in seg.get("words", []):
        words.append({
            "word":  w["word"].strip(),
            "start": round(w["start"], 3),
            "end":   round(w["end"],   3),
        })

print(json.dumps({
    "words":    words,
    "text":     result["text"].strip(),
    "language": result["language"],
}))

if tmp_file and os.path.exists(tmp_file):
    os.remove(tmp_file)
`;

  const src = audio_url ? `URL:${audio_url}` : audio_path;

  return new Promise<NextResponse>((resolve) => {
    const proc = spawn("python3", ["-c", script, src, language]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(NextResponse.json({ error: stderr.slice(-400) }, { status: 500 }));
        return;
      }
      try {
        const lastLine = stdout.trim().split("\n").pop()!;
        const data = JSON.parse(lastLine);
        if (data.error) {
          resolve(NextResponse.json({ error: data.error }, { status: 500 }));
        } else {
          resolve(NextResponse.json(data));
        }
      } catch {
        resolve(NextResponse.json({ error: "Parse error", raw: stdout.slice(-300) }, { status: 500 }));
      }
    });
  });
}
