"use client";

import { useState, useRef, useCallback } from "react";
import {
  Upload, Music, Wand2, Download, Loader2,
  ChevronDown, X, Plus, Trash2, Link, FileAudio,
  AlignCenter, PanelTop, PanelBottom, Sparkles,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface WordEntry { word: string; start: number; end: number }
interface Segment { start: number; end: number; words: WordEntry[] }
interface StyleConfig {
  font: "great_vibes" | "poppins" | "impact";
  font_size: number;
  position: "top" | "center" | "bottom";
  color: string;
  animation: "word_by_word" | "fade" | "none";
  stroke: number;
}

const FONTS = [
  { key: "great_vibes", label: "Great Vibes",  sample: "Elegant" },
  { key: "poppins",     label: "Poppins",       sample: "Modern"  },
  { key: "impact",      label: "Impact",        sample: "BOLD"    },
] as const;

const ANIMATIONS = [
  { key: "word_by_word", label: "Word by Word", desc: "Each word pops in on beat" },
  { key: "fade",         label: "Fade In",      desc: "Whole line fades in" },
  { key: "none",         label: "Static",       desc: "No animation" },
] as const;

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border p-5 ${className}`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: "var(--muted)" }}>{children}</p>;
}

function Btn({ children, onClick, disabled, variant = "primary", full = false, className = "" }:
  { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "ghost"; full?: boolean; className?: string }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${full ? "w-full justify-center" : ""} ${className}`}
      style={variant === "primary"
        ? { background: "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff" }
        : { background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}>
      {children}
    </button>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function ReelStudio() {
  const [videoPath, setVideoPath]     = useState<string | null>(null);
  const [videoName, setVideoName]     = useState("");
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [audioPath, setAudioPath]     = useState<string | null>(null);
  const [audioName, setAudioName]     = useState("");
  const [audioMode, setAudioMode]     = useState<"original" | "upload" | "url">("original");
  const [audioURL, setAudioURL]       = useState("");
  const [segments, setSegments]       = useState<Segment[]>([]);
  const [lyrics, setLyrics]           = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");
  const [transcribeLang, setTranscribeLang] = useState<"auto" | "en" | "hi" | "hinglish">("hinglish");
  const [style, setStyle]             = useState<StyleConfig>({
    font: "great_vibes", font_size: 26, position: "center",
    color: "#ffffff", animation: "word_by_word", stroke: 2,
  });
  const [jobId, setJobId]             = useState<string | null>(null);
  const [jobStatus, setJobStatus]     = useState<{ progress: number; status: string; output?: string; error?: string } | null>(null);
  const [processing, setProcessing]   = useState(false);

  const videoRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File, type: string) => {
    const fd = new FormData(); fd.append("file", file); fd.append("type", type);
    return fetch("/api/upload", { method: "POST", body: fd }).then(r => r.json());
  };

  const handleVideo = useCallback(async (file: File) => {
    setVideoName(file.name);
    setVideoPreview(URL.createObjectURL(file));
    const { path } = await upload(file, "video");
    setVideoPath(path);
  }, []);

  const handleAudio = useCallback(async (file: File) => {
    setAudioName(file.name);
    const { path } = await upload(file, "audio");
    setAudioPath(path);
  }, []);

  // Parse manually-typed lyrics → evenly distribute over existing timing or 12s
  const parseLyrics = useCallback((text: string, existingSegs?: Segment[]) => {
    const lines = text.trim().split("\n").filter(Boolean);
    if (!lines.length) return;
    // Use last existing segment end as total duration when available
    const dur = existingSegs?.length
      ? existingSegs[existingSegs.length - 1].end
      : 12;
    const perLine = dur / lines.length;
    setSegments(lines.map((line, i) => {
      const words = line.trim().split(/\s+/);
      const s = i * perLine, e = (i + 1) * perLine;
      const pw = (e - s) / words.length;
      return { start: s, end: e, words: words.map((w, wi) => ({ word: w, start: s + wi * pw, end: s + (wi + 1) * pw })) };
    }));
  }, []);

  const applyWords = (words: WordEntry[]) => {
    const segs: Segment[] = [];
    let cur: WordEntry[] = [];
    words.forEach((w, idx) => {
      cur.push(w);
      const gap = (words[idx + 1]?.start ?? w.end + 99) - w.end;
      if (cur.length >= 6 || gap > 0.5 || idx === words.length - 1) {
        segs.push({ start: cur[0].start, end: cur[cur.length - 1].end + 0.05, words: [...cur] });
        cur = [];
      }
    });
    setSegments(segs);
    setLyrics(segs.map(s => s.words.map(w => w.word).join(" ")).join("\n"));
  };

  const transcribe = async (filePath?: string, lyricsHint?: string) => {
    // For URL mode: download audio first, then transcribe the local file
    let pathToUse = filePath ?? audioPath ?? (audioMode !== "url" ? videoPath : null);
    setTranscribing(true);
    try {
      if (audioMode === "url" && !filePath) {
        if (!audioURL) return;
        setTranscribeStatus("Downloading audio…");
        const dl = await fetch("/api/fetch-audio", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: audioURL }),
        }).then(r => r.json());
        if (dl.error) { setTranscribeStatus(""); alert(dl.error); return; }
        pathToUse = dl.path;
        setAudioPath(dl.path);
        setAudioName(dl.title);
      }
      if (!pathToUse) return;
      setTranscribeStatus(lyricsHint ? "Matching your lyrics to audio timing…" : "Extracting lyrics with Whisper…");
      const data = await fetch("/api/transcribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_path: pathToUse, language: transcribeLang, lyrics: lyricsHint ?? "" }),
      }).then(r => r.json());
      if (data.error) { alert("Transcription error: " + data.error); return; }
      if (data.segments?.length) {
        // Guided mode: backend already structured segments preserving user's line breaks
        setSegments(data.segments);
        setLyrics(data.segments.map((s: Segment) => s.words.map((w: WordEntry) => w.word).join(" ")).join("\n"));
      } else if (data.words?.length) {
        // Auto mode: group raw word list into segments
        applyWords(data.words);
      }
    } finally { setTranscribing(false); setTranscribeStatus(""); }
  };

  const startProcess = async () => {
    if (!videoPath || !segments.length) return;
    setProcessing(true);
    setJobStatus({ progress: 0, status: "Starting…" });
    const { job_id } = await fetch("/api/process", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_path: videoPath,
        // prefer locally-downloaded file; fall back to URL only if not yet fetched
        audio_path: audioPath ?? undefined,
        audio_url:  (!audioPath && audioMode === "url") ? audioURL : undefined,
        segments, ...style,
      }),
    }).then(r => r.json());
    setJobId(job_id);
    const iv = setInterval(async () => {
      const s = await fetch(`/api/status?id=${job_id}`).then(r => r.json());
      setJobStatus(s);
      if (s.progress >= 100 || s.error) { clearInterval(iv); setProcessing(false); }
    }, 800);
  };

  const isDone = jobStatus?.progress === 100 && !jobStatus.error;

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>

      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-6 py-4 border-b backdrop-blur-sm"
        style={{ borderColor: "var(--border)", background: "rgba(10,10,15,0.85)" }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
          <Sparkles size={15} className="text-white" />
        </div>
        <span className="font-bold text-lg">Reel Studio</span>
        <span className="text-xs px-2 py-0.5 rounded-full ml-1"
          style={{ background: "var(--surface2)", color: "var(--muted)" }}>beta</span>
      </header>

      {/* Body */}
      <div className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">

        {/* ── LEFT ── */}
        <div className="space-y-5">

          {/* Step 1 — Video */}
          <Card>
            <Label>Step 1 · Video</Label>
            {!videoPreview ? (
              <div onClick={() => videoRef.current?.click()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("video/")) handleVideo(f); }}
                onDragOver={e => e.preventDefault()}
                className="border-2 border-dashed rounded-xl flex flex-col items-center gap-3 py-14 cursor-pointer hover:opacity-80 transition-opacity"
                style={{ borderColor: "var(--border)" }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                  style={{ background: "var(--surface2)" }}>
                  <Upload size={22} style={{ color: "#a855f7" }} />
                </div>
                <div className="text-center">
                  <p className="font-semibold">Drop your video here</p>
                  <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>MP4, MOV — up to 500 MB</p>
                </div>
                <input ref={videoRef} type="file" accept="video/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleVideo(f); }} />
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <video src={videoPreview} className="w-20 h-36 object-cover rounded-xl" muted />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{videoName}</p>
                  <p className="text-sm mt-0.5" style={{ color: "var(--muted)" }}>Video loaded ✓</p>
                  <Btn variant="ghost" className="mt-3 text-xs !py-1.5"
                    onClick={() => { setVideoPath(null); setVideoPreview(null); setVideoName(""); }}>
                    <X size={12} /> Change
                  </Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Step 2 — Audio */}
          <Card>
            <Label>Step 2 · Audio</Label>
            <div className="flex gap-2 mb-4 p-1 rounded-xl" style={{ background: "var(--surface2)" }}>
              {(["original", "upload", "url"] as const).map(m => (
                <button key={m} onClick={() => setAudioMode(m)}
                  className="flex-1 py-2 rounded-lg text-xs font-medium transition-all"
                  style={audioMode === m
                    ? { background: "var(--accent)", color: "#fff" }
                    : { color: "var(--muted)" }}>
                  {m === "original" ? "Keep Original" : m === "upload" ? "Upload File" : "From URL"}
                </button>
              ))}
            </div>

            {audioMode === "original" && (
              <p className="text-sm py-1" style={{ color: "var(--muted)" }}>
                The video's original audio will be used in the output.
              </p>
            )}

            {audioMode === "upload" && (
              <div className="space-y-3">
                {!audioName ? (
                  <div onClick={() => audioRef.current?.click()}
                    className="flex items-center gap-3 border-2 border-dashed rounded-xl px-4 py-4 cursor-pointer"
                    style={{ borderColor: "var(--border)" }}>
                    <FileAudio size={20} style={{ color: "#a855f7" }} />
                    <span className="text-sm" style={{ color: "var(--muted)" }}>Upload MP3 / WAV / M4A</span>
                    <input ref={audioRef} type="file" accept="audio/*" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleAudio(f); }} />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2 rounded-lg"
                    style={{ background: "var(--surface2)" }}>
                    <FileAudio size={16} style={{ color: "#a855f7" }} />
                    <span className="text-sm flex-1 truncate">{audioName}</span>
                    <button onClick={() => { setAudioPath(null); setAudioName(""); }} style={{ color: "var(--muted)" }}><X size={14} /></button>
                  </div>
                )}
              </div>
            )}

            {audioMode === "url" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
                  <Link size={14} style={{ color: "var(--muted)" }} />
                  <input value={audioURL} onChange={e => { setAudioURL(e.target.value); setAudioPath(null); setAudioName(""); }}
                    placeholder="Paste YouTube URL… (Instagram may be blocked)"
                    className="flex-1 bg-transparent outline-none text-sm"
                    style={{ color: "var(--text)" }} />
                  {audioURL && <button onClick={() => { setAudioURL(""); setAudioPath(null); setAudioName(""); }} style={{ color: "var(--muted)" }}><X size={14} /></button>}
                </div>
                {audioName && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
                    style={{ background: "rgba(124,58,237,.12)", color: "#a855f7" }}>
                    <Music size={11} />
                    <span className="flex-1 truncate">{audioName}</span>
                    <span style={{ color: "var(--muted)" }}>downloaded ✓</span>
                  </div>
                )}
              </div>
            )}

            {/* Language selector + Transcribe — shown whenever there's a source */}
            {(videoPath || audioPath || audioURL) && (
              <div className="mt-4 space-y-3 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
                <div>
                  <p className="text-xs mb-2 font-medium" style={{ color: "var(--muted)" }}>Transcription language</p>
                  <div className="flex flex-wrap gap-1.5">
                    {([
                      { key: "hinglish", label: "Hinglish", desc: "Hindi in Roman letters" },
                      { key: "hi",       label: "Hindi",    desc: "देवनागरी" },
                      { key: "en",       label: "English",  desc: "" },
                      { key: "auto",     label: "Auto",     desc: "detect" },
                    ] as const).map(opt => (
                      <button key={opt.key} onClick={() => setTranscribeLang(opt.key)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
                        style={transcribeLang === opt.key
                          ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.18)", color: "#a855f7" }
                          : { borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
                        {opt.label}
                        {opt.desc && <span className="ml-1 opacity-60">{opt.desc}</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <Btn variant="ghost" onClick={() => transcribe()} disabled={transcribing} className="text-xs !py-2 w-full justify-center">
                  {transcribing ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {transcribing
                    ? (transcribeStatus || "Extracting lyrics…")
                    : audioMode === "url"
                      ? "Fetch audio + extract lyrics"
                      : "Extract lyrics from audio"}
                </Btn>
                {transcribing && (
                  <p className="text-xs text-center" style={{ color: "var(--muted)" }}>
                    {transcribeStatus || "Running Whisper…"}{audioMode === "url" ? " — may take a minute" : ""}
                  </p>
                )}
              </div>
            )}
          </Card>

          {/* Step 3 — Lyrics */}
          <Card>
            <Label>Step 3 · Lyrics & Timing</Label>

            {/* Tip for Hindi/Indian songs */}
            <div className="mb-3 px-3 py-2 rounded-lg text-xs leading-relaxed"
              style={{ background: "rgba(124,58,237,.1)", color: "#a855f7", borderLeft: "2px solid #7c3aed" }}>
              <strong>For Hindi / Indian songs:</strong> Auto-transcription often fails on songs with music.
              Paste the correct lyrics below (one line per subtitle), pick <strong>Hinglish</strong> in Step 2,
              then click <strong>Match timing to audio</strong> — Whisper will sync each word to the exact beat.
            </div>

            <textarea value={lyrics} onChange={e => { setLyrics(e.target.value); parseLyrics(e.target.value, segments); }} rows={6}
              placeholder={"Ankhon ka nasha gulabi\nAb raha na jaaye zara bhi\nTu de permission pee loon\nTere naam ka banu sharabi\nUtre na teri khumari\nBhulun main duniya saari"}
              className="w-full rounded-xl border px-3 py-2.5 text-sm resize-none outline-none transition-colors"
              style={{ background: "var(--surface2)", borderColor: "var(--border)", color: "var(--text)" }} />

            {/* Match timing button — key feature for Indian songs */}
            {lyrics.trim() && (videoPath || audioPath || audioURL) && (
              <div className="mt-2">
                <Btn variant="ghost" full
                  onClick={() => transcribe(audioPath ?? videoPath ?? undefined, lyrics.trim())}
                  disabled={transcribing}
                  className="text-xs !py-2">
                  {transcribing
                    ? <><Loader2 size={12} className="animate-spin" /> {transcribeStatus || "Matching…"}</>
                    : <><Wand2 size={12} /> Match timing to audio</>}
                </Btn>
                <p className="text-xs mt-1.5 text-center" style={{ color: "var(--muted)" }}>
                  Uses your lyrics as a guide — gives each word its real timestamp
                </p>
              </div>
            )}

            {segments.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                    {segments.length} segments · expand to edit timing
                  </p>
                  <button onClick={() => setSegments(s => [...s, {
                    start: s[s.length - 1]?.end ?? 0,
                    end: (s[s.length - 1]?.end ?? 0) + 3,
                    words: [{ word: "New text", start: s[s.length - 1]?.end ?? 0, end: (s[s.length - 1]?.end ?? 0) + 3 }]
                  }])}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg"
                    style={{ background: "var(--surface2)", color: "#a855f7" }}>
                    <Plus size={11} /> Add
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto space-y-1.5">
                  {segments.map((seg, si) => (
                    <SegmentRow key={si} seg={seg} index={si}
                      onChange={u => setSegments(s => s.map((x, i) => i === si ? u : x))}
                      onDelete={() => setSegments(s => s.filter((_, i) => i !== si))} />
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* ── RIGHT ── */}
        <div className="space-y-5 lg:sticky lg:top-24">

          {/* Step 4 — Style */}
          <Card>
            <Label>Step 4 · Style</Label>
            <div className="space-y-5">

              {/* Font */}
              <div>
                <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Font</p>
                <div className="grid grid-cols-3 gap-2">
                  {FONTS.map(f => (
                    <button key={f.key} onClick={() => setStyle(s => ({ ...s, font: f.key }))}
                      className="py-3 px-2 rounded-xl border text-center transition-all text-xs"
                      style={style.font === f.key
                        ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.15)", color: "#a855f7" }
                        : { borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
                      <span className="block font-semibold">{f.label}</span>
                      <span className="block opacity-60 mt-0.5">{f.sample}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Position */}
              <div>
                <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Text Position</p>
                <div className="flex gap-2">
                  {(["top", "center", "bottom"] as const).map(p => {
                    const Icon = p === "top" ? PanelTop : p === "center" ? AlignCenter : PanelBottom;
                    return (
                      <button key={p} onClick={() => setStyle(s => ({ ...s, position: p }))}
                        className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs transition-all"
                        style={style.position === p
                          ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.15)", color: "#a855f7" }
                          : { borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
                        <Icon size={15} />
                        <span className="capitalize">{p}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Animation */}
              <div>
                <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Animation</p>
                <div className="space-y-1.5">
                  {ANIMATIONS.map(a => (
                    <button key={a.key} onClick={() => setStyle(s => ({ ...s, animation: a.key }))}
                      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border text-left transition-all"
                      style={style.animation === a.key
                        ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.15)" }
                        : { borderColor: "var(--border)", background: "var(--surface2)" }}>
                      <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${style.animation === a.key ? "bg-purple-500" : "bg-gray-600"}`} />
                      <div>
                        <p className="text-sm font-medium" style={{ color: style.animation === a.key ? "#a855f7" : "var(--text)" }}>{a.label}</p>
                        <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{a.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Color + Size */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Color</p>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border"
                    style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
                    <input type="color" value={style.color} onChange={e => setStyle(s => ({ ...s, color: e.target.value }))}
                      className="w-7 h-7 rounded-lg cursor-pointer p-0 border-0" style={{ background: "transparent" }} />
                    <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>{style.color}</span>
                  </div>
                </div>
                <div>
                  <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Size · {style.font_size}px</p>
                  <div className="px-1 py-2">
                    <input type="range" min={14} max={52} step={2} value={style.font_size}
                      onChange={e => setStyle(s => ({ ...s, font_size: +e.target.value }))}
                      className="w-full" style={{ accentColor: "#7c3aed" }} />
                  </div>
                </div>
              </div>

            </div>
          </Card>

          {/* Step 5 — Export */}
          <Card>
            <Label>Step 5 · Export</Label>

            {!videoPath && (
              <p className="text-sm py-2 text-center" style={{ color: "var(--muted)" }}>Upload a video to get started ↑</p>
            )}
            {videoPath && !segments.length && (
              <p className="text-sm py-2 text-center" style={{ color: "var(--muted)" }}>Add lyrics in Step 3 ↑</p>
            )}

            {videoPath && segments.length > 0 && !processing && !isDone && (
              <Btn full onClick={startProcess} className="py-3 text-base">
                <Wand2 size={17} /> Generate Reel
              </Btn>
            )}

            {processing && jobStatus && (
              <div className="space-y-3">
                <div className="w-full rounded-full h-2" style={{ background: "var(--surface2)" }}>
                  <div className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${jobStatus.progress}%`, background: "linear-gradient(90deg,#7c3aed,#a855f7)" }} />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2" style={{ color: "var(--muted)" }}>
                    <Loader2 size={13} className="animate-spin" /> {jobStatus.status}
                  </span>
                  <span style={{ color: "#a855f7" }}>{jobStatus.progress}%</span>
                </div>
              </div>
            )}

            {isDone && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 py-1 text-sm font-medium" style={{ color: "#86efac" }}>
                  <span className="text-base">✓</span> Your reel is ready!
                </div>
                {/* Inline preview */}
                <div className="rounded-xl overflow-hidden" style={{ background: "#000" }}>
                  <video
                    key={jobId}
                    src={`/api/preview?id=${jobId}`}
                    controls
                    playsInline
                    className="w-full max-h-[480px] object-contain"
                    style={{ display: "block" }}
                  />
                </div>
                <Btn full onClick={() => window.open(`/api/download?id=${jobId}`, "_blank")} className="py-3 text-base">
                  <Download size={17} /> Download MP4
                </Btn>
                <Btn full variant="ghost" onClick={() => { setJobId(null); setJobStatus(null); setProcessing(false); }} className="text-xs !py-2">
                  Make another
                </Btn>
              </div>
            )}

            {jobStatus?.error && (
              <div className="rounded-xl p-3 text-xs" style={{ background: "#1a0808", color: "#fca5a5" }}>
                Error: {jobStatus.error}
              </div>
            )}
          </Card>

        </div>
      </div>
    </div>
  );
}

// ── Segment editor row ────────────────────────────────────────────────────────
function SegmentRow({ seg, index, onChange, onDelete }:
  { seg: Segment; index: number; onChange: (s: Segment) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const text = seg.words.map(w => w.word).join(" ");

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)", background: "var(--surface2)" }}>
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <span className="w-5 h-5 text-xs rounded flex items-center justify-center shrink-0"
          style={{ background: "#7c3aed", color: "#fff" }}>{index + 1}</span>
        <span className="flex-1 text-sm truncate">{text}</span>
        <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--muted)" }}>
          {seg.start.toFixed(1)}–{seg.end.toFixed(1)}s
        </span>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="shrink-0 hover:text-red-400 transition-colors"
          style={{ color: "var(--muted)" }}><Trash2 size={12} /></button>
        <ChevronDown size={12} className="shrink-0 transition-transform" style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "" }} />
      </div>

      {open && (
        <div className="px-3 pb-3 pt-2 space-y-2 border-t" style={{ borderColor: "var(--border)" }}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>Start (s)</label>
              <input type="number" step="0.1" value={seg.start}
                onChange={e => onChange({ ...seg, start: +e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg border text-sm outline-none"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>End (s)</label>
              <input type="number" step="0.1" value={seg.end}
                onChange={e => onChange({ ...seg, end: +e.target.value })}
                className="w-full px-2 py-1.5 rounded-lg border text-sm outline-none"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }} />
            </div>
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>Words (space separated)</label>
            <input type="text" value={text}
              onChange={e => {
                const words = e.target.value.split(/\s+/).filter(Boolean);
                const dur = seg.end - seg.start;
                const n = words.length || 1;
                onChange({ ...seg, words: words.map((w, i) => ({ word: w, start: seg.start + i * dur / n, end: seg.start + (i + 1) * dur / n })) });
              }}
              className="w-full px-2 py-1.5 rounded-lg border text-sm outline-none"
              style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }} />
          </div>
        </div>
      )}
    </div>
  );
}
