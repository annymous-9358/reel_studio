import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

export async function POST(req: NextRequest) {
  const { audio_path, audio_url, language = "auto", lyrics = "" } = await req.json();
  if (!audio_path && !audio_url) {
    return NextResponse.json({ error: "Provide audio_path or audio_url" }, { status: 400 });
  }

  const script = `
import ssl, json, sys, os, subprocess, tempfile
ssl._create_default_https_context = ssl._create_unverified_context

cfg       = json.loads(sys.stdin.read())
audio_src = cfg["audio_src"]
language  = cfg.get("language", "auto")
lyrics    = cfg.get("lyrics", "").strip()

tmp_file = None

# ── Download from URL if needed ───────────────────────────────────────────────
if audio_src.startswith("URL:"):
    url = audio_src[4:]
    tmp_file = tempfile.mktemp(suffix=".mp3")
    r = subprocess.run(
        ["yt-dlp", "-x", "--audio-format", "mp3", "-o", tmp_file, url],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        print(json.dumps({"error": "yt-dlp failed: " + r.stderr[-300:]}))
        sys.exit(0)
    audio_src = tmp_file

import whisper
model = whisper.load_model("small")

# ── Language kwargs (always transcribe, never translate) ──────────────────────
lang_kwargs = {"task": "transcribe"}

if language == "hinglish":
    lang_kwargs["language"] = "hi"
    # Strong Hinglish-style prompt so Whisper stays in Roman script
    lang_kwargs["initial_prompt"] = (
        "Yaar yeh Hinglish song hai. Har word Roman English mein likho, "
        "jaise: 'Ankhon ka nasha gulabi, Ab raha na jaaye zara bhi'. "
        "Devanagari mat use karo."
    )
elif language == "hi":
    lang_kwargs["language"] = "hi"
elif language == "en":
    lang_kwargs["language"] = "en"
# else: auto — let Whisper detect

# ─────────────────────────────────────────────────────────────────────────────
# MODE A: User provided correct lyrics → use Whisper only for TIMING
# We get word timestamps, then proportionally map the user's words onto them.
# This guarantees correct text + real audio timing even when Whisper's
# word recognition fails (e.g. Indian songs with heavy music).
# ─────────────────────────────────────────────────────────────────────────────
if lyrics:
    user_lines = [l.strip() for l in lyrics.split("\\n") if l.strip()]

    # Provide the user's lyrics as a guide so Whisper's segments align better
    guided_prompt = lang_kwargs.get("initial_prompt", "")
    lang_kwargs["initial_prompt"] = (guided_prompt + " " + lyrics).strip()

    result = model.transcribe(audio_src, word_timestamps=True, verbose=False, **lang_kwargs)

    # Collect all Whisper word timestamps (text may be wrong — only timing matters)
    w_times = []
    for seg in result["segments"]:
        for w in seg.get("words", []):
            if w["word"].strip():
                w_times.append({"start": w["start"], "end": w["end"]})

    # Fallback: distribute evenly over detected audio duration
    if not w_times:
        total = result["segments"][-1]["end"] if result["segments"] else 12.0
        n_total = sum(len(l.split()) for l in user_lines)
        pw = total / max(n_total, 1)
        t = 0.0
        for l in user_lines:
            for word in l.split():
                w_times.append({"start": round(t, 3), "end": round(t + pw, 3)})
                t += pw

    # Proportional mapping: user line word counts → whisper time ranges
    total_user_words = sum(len(l.split()) for l in user_lines)
    W = len(w_times)
    out_segments = []
    w_pos = 0
    for line in user_lines:
        line_words = line.split()
        n = len(line_words)
        # How many whisper words does this line span?
        n_ww = max(1, round(n / total_user_words * W))
        chunk = w_times[w_pos: w_pos + n_ww]
        w_pos = min(w_pos + n_ww, W)

        line_start = chunk[0]["start"] if chunk else (w_times[-1]["end"] if w_times else 0)
        line_end   = chunk[-1]["end"]  if chunk else line_start + 2.0
        pw = (line_end - line_start) / n

        seg_words = []
        for wi, word in enumerate(line_words):
            seg_words.append({
                "word":  word,
                "start": round(line_start + wi * pw, 3),
                "end":   round(line_start + (wi + 1) * pw, 3),
            })
        out_segments.append({
            "start": round(line_start, 3),
            "end":   round(line_end, 3),
            "words": seg_words,
        })

    print(json.dumps({
        "segments": out_segments,
        "text":     lyrics,
        "language": result["language"],
    }))

# ─────────────────────────────────────────────────────────────────────────────
# MODE B: Auto-transcription — Whisper extracts both text and timing
# ─────────────────────────────────────────────────────────────────────────────
else:
    result = model.transcribe(audio_src, word_timestamps=True, verbose=False, **lang_kwargs)

    words = []
    for seg in result["segments"]:
        for w in seg.get("words", []):
            clean = w["word"].strip()
            if clean:
                words.append({
                    "word":  clean,
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
  const cfg = JSON.stringify({ audio_src: src, language, lyrics });

  return new Promise<NextResponse>((resolve) => {
    const proc = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin.write(cfg);
    proc.stdin.end();

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
