import { NextRequest, NextResponse } from "next/server";
import { readFile, stat, unlink, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// Groq limit is 25 MB. If file is larger, extract compressed mono audio first.
async function prepareAudio(filePath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const { size } = await stat(filePath);
  if (size <= 24 * 1024 * 1024) {
    return { path: filePath, cleanup: async () => {} };
  }
  await mkdir("/tmp/reel_studio", { recursive: true });
  const tmp = `/tmp/reel_studio/groq_${randomUUID()}.mp3`;
  await new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", [
      "-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", tmp,
    ]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg compress failed"))));
  });
  return { path: tmp, cleanup: () => unlink(tmp).catch(() => {}) };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export async function POST(req: NextRequest) {
  const { audio_path, language = "auto", lyrics = "" } = await req.json();
  if (!audio_path) return NextResponse.json({ error: "audio_path required" }, { status: 400 });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set. Add it to your .env.local file." },
      { status: 500 }
    );
  }

  const { path: audioFile, cleanup } = await prepareAudio(audio_path);

  try {
    const buf = await readFile(audioFile);
    const ext = path.extname(audioFile).slice(1).toLowerCase() || "mp3";
    const mime: Record<string, string> = {
      mp3: "audio/mpeg", mp4: "video/mp4", m4a: "audio/mp4",
      wav: "audio/wav",  webm: "audio/webm", ogg: "audio/ogg", flac: "audio/flac",
    };

    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime[ext] ?? "audio/mpeg" }), `audio.${ext}`);
    form.append("model", "whisper-large-v3-turbo"); // fast + multilingual, free tier
    form.append("response_format", "verbose_json");

    // Language
    if (language === "hinglish" || language === "hi") form.append("language", "hi");
    else if (language === "en") form.append("language", "en");
    // auto: omit — Whisper detects

    // Prompt (max ~224 tokens for Groq)
    let prompt = "";
    if (language === "hinglish") {
      prompt = lyrics.trim()
        ? `Hinglish song, Roman script only, no Devanagari: ${lyrics}`
        : "Yaar yeh Hinglish song hai. Har word Roman English mein likho. Devanagari mat use karo.";
    } else if (lyrics.trim()) {
      prompt = lyrics;
    }
    if (prompt) form.append("prompt", prompt.slice(0, 900));

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Groq API error: ${err.slice(0, 300)}` }, { status: 500 });
    }

    const result = await res.json();
    type GroqSeg = { start: number; end: number; text: string };
    const groqSegs: GroqSeg[] = result.segments ?? [];
    const totalDur: number =
      groqSegs.length ? groqSegs[groqSegs.length - 1].end : (result.duration ?? 12);

    // ── GUIDED MODE: user provided correct lyrics ────────────────────────────
    // Groq tells us WHEN the audio spans (start/end of detected speech).
    // We take the user's exact words and distribute them proportionally
    // across that detected audio window — correct text + real timing bounds.
    if (lyrics.trim()) {
      const userLines = lyrics
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);

      const audioStart = groqSegs[0]?.start ?? 0;
      const audioEnd   = groqSegs[groqSegs.length - 1]?.end ?? totalDur;
      const audioDur   = audioEnd - audioStart;

      const totalWords = userLines.reduce(
        (s: number, l: string) => s + l.split(/\s+/).length,
        0
      );
      const secPerWord = audioDur / Math.max(totalWords, 1);

      let cursor = audioStart;
      const outSegs = userLines.map((line: string) => {
        const words    = line.split(/\s+/);
        const lineDur  = words.length * secPerWord;
        const lineStart = cursor;
        const lineEnd   = cursor + lineDur;
        cursor = lineEnd;
        const pw = lineDur / words.length;
        return {
          start: round3(lineStart),
          end:   round3(lineEnd),
          words: words.map((w, i) => ({
            word:  w,
            start: round3(lineStart + i * pw),
            end:   round3(lineStart + (i + 1) * pw),
          })),
        };
      });

      return NextResponse.json({
        segments: outSegs,
        text: lyrics,
        language: result.language,
      });
    }

    // ── AUTO MODE: use Groq's transcribed text with segment timing ───────────
    // Groq gives segment-level timestamps (no per-word). We split each
    // segment's text into words and distribute them evenly within the segment.
    const words: Array<{ word: string; start: number; end: number }> = [];
    for (const seg of groqSegs) {
      const segWords = seg.text.trim().split(/\s+/).filter(Boolean);
      if (!segWords.length) continue;
      const pw = (seg.end - seg.start) / segWords.length;
      segWords.forEach((w, i) => {
        words.push({
          word:  w,
          start: round3(seg.start + i * pw),
          end:   round3(seg.start + (i + 1) * pw),
        });
      });
    }

    return NextResponse.json({
      words,
      text:     result.text?.trim() ?? "",
      language: result.language,
    });
  } finally {
    await cleanup();
  }
}
