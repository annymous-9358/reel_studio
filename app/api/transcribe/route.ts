import { NextRequest, NextResponse } from "next/server";
import { readFile, stat, unlink, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

// Get audio/video duration via ffprobe (no API needed)
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ]);
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("close", () => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) ? 12 : dur);
    });
  });
}

// Extract compressed mono audio (needed for Groq's 25MB limit and video files)
async function extractAudio(filePath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  await mkdir("/tmp/reel_studio", { recursive: true });
  const tmp = `/tmp/reel_studio/groq_${randomUUID()}.mp3`;
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y", "-i", filePath,
      "-vn",           // audio only
      "-ac", "1",      // mono
      "-ar", "16000",  // 16 kHz (enough for speech)
      "-b:a", "64k",
      tmp,
    ]);
    let errLog = "";
    p.stderr.on("data", (d) => { errLog += d.toString(); });
    p.on("close", (c) => {
      if (c === 0) {
        resolve({ path: tmp, cleanup: () => unlink(tmp).catch(() => {}) });
      } else {
        reject(new Error(`ffmpeg failed: ${errLog.slice(-300)}`));
      }
    });
  });
}

export async function POST(req: NextRequest) {
  const { audio_path, language = "auto", lyrics = "" } = await req.json();
  if (!audio_path) return NextResponse.json({ error: "audio_path required" }, { status: 400 });

  // ── GUIDED MODE: user provided correct lyrics ──────────────────────────────
  // No AI API needed — just get real duration via ffprobe, then distribute
  // the user's words evenly. Works for any file, any language, any genre.
  if (lyrics.trim()) {
    const duration = await getAudioDuration(audio_path);
    const userLines = lyrics.split("\n").map((l) => l.trim()).filter(Boolean);
    const totalWords = userLines.reduce((s, l) => s + l.split(/\s+/).length, 0);
    const secPerWord = duration / Math.max(totalWords, 1);

    let cursor = 0;
    const outSegs = userLines.map((line) => {
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

    return NextResponse.json({ segments: outSegs, text: lyrics, language: "guided" });
  }

  // ── AUTO MODE: use Groq Whisper to extract text + timing ──────────────────
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY not configured — add it in Render environment variables." },
      { status: 500 }
    );
  }

  // Always extract audio first: fixes video codec issues and keeps file small
  const { path: audioFile, cleanup } = await extractAudio(audio_path);

  try {
    const buf = await readFile(audioFile);

    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");

    if (language === "hinglish" || language === "hi") form.append("language", "hi");
    else if (language === "en") form.append("language", "en");

    const prompt =
      language === "hinglish"
        ? "Yaar yeh Hinglish song hai. Har word Roman English mein likho. Devanagari mat use karo."
        : "";
    if (prompt) form.append("prompt", prompt);

    // 60-second timeout for Groq call
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    let res: Response;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Groq error: ${err.slice(0, 300)}` }, { status: 500 });
    }

    const result = await res.json();
    type GroqSeg = { start: number; end: number; text: string };
    const groqSegs: GroqSeg[] = result.segments ?? [];

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
      language: result.language ?? language,
    });
  } finally {
    await cleanup();
  }
}
