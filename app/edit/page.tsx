"use client";

import { useState, useRef, useCallback } from "react";
import Link from "next/link";
import {
  Upload, ArrowLeft, Download, Loader2, Sparkles, X,
  Link as LinkIcon, Play, Pause, FlipHorizontal2, FlipVertical2,
  Film, Music, Plus, Trash2, ChevronDown, ChevronUp,
  Image as ImageIcon, Type, RotateCcw, Move,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface MediaItem {
  id: string;
  type: "video" | "image";
  name: string;
  localUrl: string;
  serverPath: string;
  duration: number;    // image: display secs; video: clip duration
  trimStart: number;
  trimEnd: number | null;
}

interface TextLayer {
  id: string;
  text: string;
  start: number;
  end: number;
  position_x: number;
  position_y: number;
  font: FontKey;
  size: number;
  color: string;
  stroke: number;
  stroke_color: string;
  shadow_blur: number;
}

interface AudioCfg {
  mode: "none" | "upload" | "url";
  path: string | null;
  name: string;
  url: string;
  volume: number;
}

interface Effects {
  brightness: number;
  contrast: number;
  saturation: number;
  speed: number;
  flip_h: boolean;
  flip_v: boolean;
}

type FontKey = "impact" | "bebas" | "oswald" | "poppins" | "great_vibes" | "pacifico";

const FONTS: { key: FontKey; label: string; sample: string; family: string }[] = [
  { key: "impact",      label: "Impact",     sample: "IMPACT",   family: "Impact,'Arial Black',sans-serif" },
  { key: "bebas",       label: "Bebas Neue", sample: "BEBAS",    family: "'Bebas Neue',Impact,sans-serif" },
  { key: "oswald",      label: "Oswald",     sample: "OSWALD",   family: "'Oswald',sans-serif" },
  { key: "poppins",     label: "Poppins",    sample: "Poppins",  family: "'Poppins',sans-serif" },
  { key: "great_vibes", label: "Script",     sample: "Script",   family: "'Great Vibes',cursive" },
  { key: "pacifico",    label: "Pacifico",   sample: "Pacifico", family: "'Pacifico',cursive" },
];

// 3×3 position grid (label, x%, y%)
const POS_GRID = [
  { label: "↖", x: 12, y: 12 }, { label: "↑",  x: 50, y: 12 }, { label: "↗", x: 88, y: 12 },
  { label: "←", x: 12, y: 50 }, { label: "·",  x: 50, y: 50 }, { label: "→", x: 88, y: 50 },
  { label: "↙", x: 12, y: 82 }, { label: "↓",  x: 50, y: 82 }, { label: "↘", x: 88, y: 82 },
];

const DEFAULT_EFFECTS: Effects = {
  brightness: 0, contrast: 0, saturation: 100, speed: 1, flip_h: false, flip_v: false,
};
const DEFAULT_AUDIO: AudioCfg = {
  mode: "none", path: null, name: "", url: "", volume: 100,
};

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Panel({ title, icon, children, defaultOpen = true }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left select-none"
        style={{ borderBottom: open ? "1px solid var(--border)" : "none" }}>
        <span style={{ color: "#a855f7" }}>{icon}</span>
        <span className="flex-1 text-sm font-semibold">{title}</span>
        {open
          ? <ChevronUp size={14} style={{ color: "var(--muted)" }} />
          : <ChevronDown size={14} style={{ color: "var(--muted)" }} />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

function RangeRow({ label, value, min, max, step = 1, neutral, onChange }: {
  label: string; value: number; min: number; max: number;
  step?: number; neutral?: number; onChange: (v: number) => void;
}) {
  const changed = neutral !== undefined && value !== neutral;
  return (
    <div>
      <div className="flex justify-between mb-1.5">
        <span className="text-xs" style={{ color: "var(--muted)" }}>{label}</span>
        <span className="text-xs font-mono"
          style={{ color: changed ? "#a855f7" : "var(--muted)" }}>
          {changed ? (value > (neutral ?? 0) ? `+${value}` : value) : "—"}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        className="w-full" style={{ accentColor: "#7c3aed" }} />
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function EditorPage() {
  const [mediaItems,  setMediaItems]  = useState<MediaItem[]>([]);
  const [selIdx,      setSelIdx]      = useState(0);
  const [effects,     setEffects]     = useState<Effects>(DEFAULT_EFFECTS);
  const [audio,       setAudio]       = useState<AudioCfg>(DEFAULT_AUDIO);
  const [textLayers,  setTextLayers]  = useState<TextLayer[]>([]);
  const [refURL,      setRefURL]      = useState("");
  const [analyzing,   setAnalyzing]   = useState(false);
  const [refMsg,      setRefMsg]      = useState("");
  const [processing,  setProcessing]  = useState(false);
  const [jobId,       setJobId]       = useState<string | null>(null);
  const [jobStatus,   setJobStatus]   = useState<{ progress: number; status: string; output?: string; error?: string } | null>(null);
  const [isDone,      setIsDone]      = useState(false);
  const [outputPath,  setOutputPath]  = useState<string | null>(null);
  const [playing,     setPlaying]     = useState(false);

  const fileInputRef  = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoRef      = useRef<HTMLVideoElement>(null);

  const selItem = mediaItems[Math.min(selIdx, mediaItems.length - 1)] ?? null;

  // Live CSS preview
  const cssFilter    = `brightness(${1 + effects.brightness / 100}) contrast(${1 + effects.contrast / 100}) saturate(${effects.saturation / 100})`;
  const cssTransform = [effects.flip_h && "scaleX(-1)", effects.flip_v && "scaleY(-1)"].filter(Boolean).join(" ") || undefined;

  // Total estimated output duration
  const totalDuration = mediaItems.reduce((sum, it) => {
    const eff = it.trimEnd != null ? it.trimEnd - it.trimStart : it.duration - it.trimStart;
    return sum + Math.max(0, eff);
  }, 0);

  // ── Upload ────────────────────────────────────────────────────────────────
  const uploadFile = async (file: File): Promise<MediaItem> => {
    const isImage  = file.type.startsWith("image/");
    const localUrl = URL.createObjectURL(file);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", isImage ? "image" : "video");
    const { path } = await fetch("/api/upload", { method: "POST", body: fd }).then(r => r.json());

    let duration = isImage ? 3 : 0;
    if (!isImage) {
      duration = await new Promise<number>(res => {
        const v = document.createElement("video");
        v.src = localUrl;
        v.onloadedmetadata = () => res(v.duration || 10);
        v.onerror          = () => res(10);
      });
    }

    return {
      id: crypto.randomUUID(), type: isImage ? "image" : "video",
      name: file.name, localUrl, serverPath: path,
      duration: Math.round(duration * 10) / 10,
      trimStart: 0, trimEnd: null,
    };
  };

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f =>
      f.type.startsWith("video/") || f.type.startsWith("image/"));
    if (!arr.length) return;
    const items = await Promise.all(arr.map(uploadFile));
    setMediaItems(prev => {
      const next = [...prev, ...items];
      if (prev.length === 0) setSelIdx(0);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reference video ───────────────────────────────────────────────────────
  const analyzeRef = async () => {
    if (!refURL) return;
    setAnalyzing(true); setRefMsg("Downloading reference video…");
    try {
      const data = await fetch("/api/analyze-style", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: refURL, transcribe: false }),
      }).then(r => r.json());
      if (data.error) { alert(data.error); return; }

      if (data.color_grade) {
        setEffects(e => ({ ...e,
          brightness: data.color_grade.brightness ?? e.brightness,
          contrast:   data.color_grade.contrast   ?? e.contrast,
          saturation: data.color_grade.saturation ?? e.saturation,
        }));
      }
      if (data.style) {
        const s = data.style;
        setTextLayers(prev => [...prev, {
          id: crypto.randomUUID(), text: "Your text here",
          start: 0, end: 5,
          position_x: s.position_x ?? 50, position_y: s.position_y ?? 80,
          font: (s.font as FontKey) ?? "impact", size: s.font_size ?? 36,
          color: s.color ?? "#ffffff", stroke: s.stroke ?? 2,
          stroke_color: s.stroke_color ?? "#000000", shadow_blur: s.shadow_blur ?? 4,
        }]);
      }
      setRefMsg("✓ Color grade applied! Text style added as a layer below.");
    } catch (e) { alert(String(e)); }
    finally { setAnalyzing(false); }
  };

  // ── Audio upload ──────────────────────────────────────────────────────────
  const handleAudioFile = async (file: File) => {
    const fd = new FormData(); fd.append("file", file); fd.append("type", "audio");
    const { path } = await fetch("/api/upload", { method: "POST", body: fd }).then(r => r.json());
    setAudio(a => ({ ...a, mode: "upload", path, name: file.name }));
  };

  // ── Media item helpers ────────────────────────────────────────────────────
  const updateItem = (id: string, patch: Partial<MediaItem>) =>
    setMediaItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));

  const removeItem = (id: string) =>
    setMediaItems(prev => {
      const next = prev.filter(it => it.id !== id);
      setSelIdx(i => Math.min(i, Math.max(0, next.length - 1)));
      return next;
    });

  const moveItem = (id: string, dir: -1 | 1) =>
    setMediaItems(prev => {
      const i = prev.findIndex(it => it.id === id);
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      setSelIdx(j);
      return next;
    });

  // ── Text layer helpers ────────────────────────────────────────────────────
  const addLayer = () =>
    setTextLayers(prev => [...prev, {
      id: crypto.randomUUID(), text: "",
      start: 0, end: Math.min(5, totalDuration || 5),
      position_x: 50, position_y: 82,
      font: "impact", size: 36,
      color: "#ffffff", stroke: 2, stroke_color: "#000000", shadow_blur: 4,
    }]);

  const updateLayer = (id: string, patch: Partial<TextLayer>) =>
    setTextLayers(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));

  // ── Export ────────────────────────────────────────────────────────────────
  const exportVideo = async () => {
    if (!mediaItems.length) return;
    setProcessing(true); setIsDone(false);
    setJobStatus({ progress: 0, status: "Starting…" });

    const { job_id } = await fetch("/api/process-edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_items: mediaItems.map(it => ({
          type: it.type, path: it.serverPath,
          duration: it.duration, trim_start: it.trimStart,
          trim_end: it.trimEnd ?? undefined,
        })),
        effects,
        audio: { mode: audio.mode, path: audio.path ?? undefined, url: audio.url, volume: audio.volume },
        text_layers: textLayers.map(l => ({
          text: l.text, start: l.start, end: l.end,
          position_x: l.position_x, position_y: l.position_y,
          font: l.font, size: l.size, color: l.color,
          stroke: l.stroke, stroke_color: l.stroke_color, shadow_blur: l.shadow_blur,
        })),
      }),
    }).then(r => r.json());
    setJobId(job_id);

    const iv = setInterval(async () => {
      const s = await fetch(`/api/status?id=${job_id}`).then(r => r.json());
      setJobStatus(s);
      if (s.output) setOutputPath(s.output);
      if (s.progress >= 100 || s.error) {
        clearInterval(iv); setProcessing(false);
        if (s.progress >= 100 && !s.error) setIsDone(true);
      }
    }, 900);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else { videoRef.current.play().catch(() => {}); setPlaying(true); }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--background)", color: "var(--foreground)" }}>

      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center gap-4 px-6 py-4 border-b backdrop-blur-sm"
        style={{ borderColor: "var(--border)", background: "rgba(10,10,15,0.9)" }}>
        <Link href="/" className="flex items-center gap-2 text-sm hover:opacity-70 transition-opacity"
          style={{ color: "var(--muted)" }}>
          <ArrowLeft size={14} /> Reel Studio
        </Link>
        <div className="h-4 w-px" style={{ background: "var(--border)" }} />
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
            <Film size={13} className="text-white" />
          </div>
          <span className="font-bold">Video Editor</span>
        </div>
        {totalDuration > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full font-mono"
            style={{ background: "var(--surface2)", color: "var(--muted)" }}>
            ~{totalDuration.toFixed(1)}s
          </span>
        )}
        <div className="ml-auto">
          <Link href="/"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border hover:opacity-80 transition-all"
            style={{ borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
            <Type size={11} /> Add Subtitles →
          </Link>
        </div>
      </header>

      {/* Body */}
      <div className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6 items-start">

        {/* ══ LEFT ══ */}
        <div className="space-y-4">

          {/* Preview */}
          <div className="relative rounded-2xl overflow-hidden bg-black"
            style={{ minHeight: 300 }}>
            {selItem ? (
              selItem.type === "video" ? (
                <>
                  <video ref={videoRef} key={selItem.id} src={selItem.localUrl}
                    className="w-full block max-h-[68vh] object-contain"
                    style={{ filter: cssFilter, transform: cssTransform }}
                    onEnded={() => setPlaying(false)} />
                  {/* Play overlay */}
                  <button onClick={togglePlay}
                    className="absolute inset-0 flex items-center justify-center transition-opacity"
                    style={{ opacity: playing ? 0 : 1, background: "rgba(0,0,0,0.18)" }}>
                    <div className="w-14 h-14 rounded-full flex items-center justify-center"
                      style={{ background: "rgba(124,58,237,0.8)" }}>
                      {playing
                        ? <Pause size={22} className="text-white" />
                        : <Play  size={22} className="text-white ml-1" />}
                    </div>
                  </button>
                </>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selItem.localUrl} alt={selItem.name}
                  className="w-full block max-h-[68vh] object-contain"
                  style={{ filter: cssFilter, transform: cssTransform }} />
              )
            ) : (
              /* Upload drop zone */
              <div onClick={() => fileInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
                onDragOver={e => e.preventDefault()}
                className="absolute inset-0 flex flex-col items-center justify-center gap-4 cursor-pointer"
                style={{ border: "2px dashed var(--border)" }}>
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                  style={{ background: "var(--surface2)" }}>
                  <Upload size={28} style={{ color: "#a855f7" }} />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-lg">Drop videos or images here</p>
                  <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
                    MP4 · MOV · JPG · PNG — add multiple, mix freely
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Media rack */}
          {mediaItems.length > 0 && (
            <div className="rounded-2xl border p-3"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center gap-2 mb-3">
                <Film size={13} style={{ color: "#a855f7" }} />
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                  Media · {mediaItems.length} item{mediaItems.length !== 1 ? "s" : ""}
                </span>
                <button onClick={() => fileInputRef.current?.click()}
                  className="ml-auto flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border"
                  style={{ borderColor: "var(--border)", background: "var(--surface2)", color: "#a855f7" }}>
                  <Plus size={11} /> Add more
                </button>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1.5" style={{ scrollbarWidth: "thin" }}>
                {mediaItems.map((item, idx) => (
                  <MediaCard key={item.id} item={item} selected={selIdx === idx}
                    onSelect={() => setSelIdx(idx)}
                    onUpdate={p => updateItem(item.id, p)}
                    onDelete={() => removeItem(item.id)}
                    canMoveLeft={idx > 0}
                    canMoveRight={idx < mediaItems.length - 1}
                    onMoveLeft={() => moveItem(item.id, -1)}
                    onMoveRight={() => moveItem(item.id, 1)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Active text layer badge strip */}
          {textLayers.length > 0 && (
            <div className="rounded-2xl border p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center gap-2 mb-2">
                <Type size={13} style={{ color: "#a855f7" }} />
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                  Text layers · {textLayers.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {textLayers.map(l => (
                  <div key={l.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border"
                    style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
                    <span className="font-mono" style={{ color: "var(--muted)" }}>{l.start}–{l.end}s</span>
                    <span className="max-w-[100px] truncate">
                      {l.text || <span style={{ color: "var(--muted)" }}>(empty)</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ══ RIGHT: Controls ══ */}
        <div className="space-y-3 lg:sticky lg:top-24 lg:max-h-[calc(100vh-100px)] lg:overflow-y-auto"
          style={{ scrollbarWidth: "thin" }}>

          {/* ── Reference Video ── */}
          <Panel title="Reference Video" icon={<LinkIcon size={14} />} defaultOpen={false}>
            <p className="text-xs mb-3 leading-relaxed" style={{ color: "var(--muted)" }}>
              Paste any reel or YouTube URL — we detect its color grade and text style
              and apply both to your project instantly.
            </p>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border mb-3"
              style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
              <LinkIcon size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <input value={refURL} onChange={e => { setRefURL(e.target.value); setRefMsg(""); }}
                placeholder="Instagram / YouTube / reel URL…"
                className="flex-1 bg-transparent outline-none text-sm min-w-0"
                style={{ color: "var(--foreground)" }} />
              {refURL && (
                <button onClick={() => { setRefURL(""); setRefMsg(""); }}
                  style={{ color: "var(--muted)" }}><X size={12} /></button>
              )}
            </div>
            <button onClick={analyzeRef} disabled={!refURL || analyzing}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
              style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff" }}>
              {analyzing
                ? <><Loader2 size={14} className="animate-spin" /> Analyzing…</>
                : <><Sparkles size={14} /> Analyze &amp; Copy Style</>}
            </button>
            {refMsg && (
              <p className="text-xs mt-2 leading-relaxed"
                style={{ color: refMsg.startsWith("✓") ? "#86efac" : "var(--muted)" }}>
                {refMsg}
              </p>
            )}
          </Panel>

          {/* ── Color & Effects ── */}
          <Panel title="Color &amp; Effects" icon={<span className="text-sm">🎨</span>}>
            <div className="space-y-3">
              <RangeRow label="Brightness" value={effects.brightness} min={-50} max={50} neutral={0}
                onChange={v => setEffects(e => ({ ...e, brightness: v }))} />
              <RangeRow label="Contrast" value={effects.contrast} min={-50} max={50} neutral={0}
                onChange={v => setEffects(e => ({ ...e, contrast: v }))} />
              <RangeRow label="Saturation" value={effects.saturation} min={0} max={200} neutral={100}
                onChange={v => setEffects(e => ({ ...e, saturation: v }))} />

              <div>
                <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Speed</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                    <button key={s} onClick={() => setEffects(e => ({ ...e, speed: s }))}
                      className="py-2 rounded-xl border text-xs font-bold transition-all"
                      style={effects.speed === s
                        ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.2)", color: "#a855f7" }
                        : { borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
                      {s}×
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {([
                  { k: "flip_h" as const, icon: <FlipHorizontal2 size={14} />, label: "Flip H" },
                  { k: "flip_v" as const, icon: <FlipVertical2   size={14} />, label: "Flip V" },
                ]).map(({ k, icon, label }) => (
                  <button key={k} onClick={() => setEffects(e => ({ ...e, [k]: !e[k] }))}
                    className="flex items-center justify-center gap-2 py-2.5 rounded-xl border text-xs font-medium transition-all"
                    style={effects[k]
                      ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.2)", color: "#a855f7" }
                      : { borderColor: "var(--border)", background: "var(--surface2)", color: "var(--muted)" }}>
                    {icon} {label}
                  </button>
                ))}
              </div>

              {(effects.brightness !== 0 || effects.contrast !== 0 || effects.saturation !== 100
                || effects.speed !== 1 || effects.flip_h || effects.flip_v) && (
                <button onClick={() => setEffects(DEFAULT_EFFECTS)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg"
                  style={{ color: "var(--muted)", background: "var(--surface2)" }}>
                  <RotateCcw size={10} /> Reset all effects
                </button>
              )}
            </div>
          </Panel>

          {/* ── Audio ── */}
          <Panel title="Audio" icon={<Music size={14} />} defaultOpen={false}>
            <div className="flex gap-1 p-1 rounded-xl mb-4"
              style={{ background: "var(--surface2)" }}>
              {(["none","upload","url"] as const).map(m => (
                <button key={m} onClick={() => setAudio(a => ({ ...a, mode: m }))}
                  className="flex-1 py-2 rounded-lg text-xs font-medium transition-all"
                  style={audio.mode === m
                    ? { background: "#7c3aed", color: "#fff" }
                    : { color: "var(--muted)" }}>
                  {m === "none" ? "Keep Original" : m === "upload" ? "Upload" : "From URL"}
                </button>
              ))}
            </div>

            {audio.mode === "none" && (
              <p className="text-xs py-1" style={{ color: "var(--muted)" }}>
                Video clips will keep their own audio. Images will have no sound.
              </p>
            )}

            {audio.mode === "upload" && (
              <>
                {!audio.name ? (
                  <button onClick={() => audioInputRef.current?.click()}
                    className="w-full flex items-center gap-3 px-4 py-4 rounded-xl cursor-pointer border-2 border-dashed hover:opacity-80"
                    style={{ borderColor: "var(--border)" }}>
                    <Music size={18} style={{ color: "#a855f7" }} />
                    <span className="text-sm" style={{ color: "var(--muted)" }}>Upload MP3 / WAV / M4A</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2 rounded-lg"
                    style={{ background: "var(--surface2)" }}>
                    <Music size={14} style={{ color: "#a855f7" }} />
                    <span className="text-sm flex-1 truncate">{audio.name}</span>
                    <button onClick={() => setAudio(a => ({ ...a, path: null, name: "" }))}
                      style={{ color: "var(--muted)" }}><X size={13} /></button>
                  </div>
                )}
                <input ref={audioInputRef} type="file" accept="audio/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleAudioFile(f); }} />
              </>
            )}

            {audio.mode === "url" && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border"
                style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
                <Music size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <input value={audio.url} onChange={e => setAudio(a => ({ ...a, url: e.target.value }))}
                  placeholder="YouTube / SoundCloud / Instagram URL…"
                  className="flex-1 bg-transparent outline-none text-sm min-w-0"
                  style={{ color: "var(--foreground)" }} />
                {audio.url && (
                  <button onClick={() => setAudio(a => ({ ...a, url: "" }))}
                    style={{ color: "var(--muted)" }}><X size={12} /></button>
                )}
              </div>
            )}

            {audio.mode !== "none" && (
              <div className="mt-4">
                <RangeRow label="Volume" value={audio.volume} min={0} max={200} neutral={100}
                  onChange={v => setAudio(a => ({ ...a, volume: v }))} />
              </div>
            )}
          </Panel>

          {/* ── Text Layers ── */}
          <Panel title="Text Layers" icon={<Type size={14} />} defaultOpen={false}>
            {textLayers.length === 0 ? (
              <p className="text-xs mb-3 leading-relaxed" style={{ color: "var(--muted)" }}>
                Add text overlays that appear at specific timestamps in your final video.
                Each layer has its own font, color, position and timing.
              </p>
            ) : (
              <div className="space-y-3 mb-3">
                {textLayers.map((layer, li) => (
                  <TextLayerCard key={layer.id} layer={layer} index={li}
                    totalDuration={totalDuration}
                    onUpdate={p => updateLayer(layer.id, p)}
                    onDelete={() => setTextLayers(prev => prev.filter(l => l.id !== layer.id))} />
                ))}
              </div>
            )}
            <button onClick={addLayer}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium hover:opacity-80 transition-all"
              style={{ borderColor: "#7c3aed", color: "#a855f7", background: "rgba(124,58,237,.08)" }}>
              <Plus size={14} /> Add Text Layer
            </button>
          </Panel>

          {/* ── Export ── */}
          <Panel title="Export" icon={<Download size={14} />}>
            {!mediaItems.length && (
              <p className="text-sm text-center py-2" style={{ color: "var(--muted)" }}>
                Add videos or images above ↑
              </p>
            )}

            {mediaItems.length > 0 && !processing && !isDone && (
              <button onClick={exportVideo}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold"
                style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff" }}>
                <Download size={16} /> Export HD Video
              </button>
            )}

            {processing && jobStatus && (
              <div className="space-y-3">
                <div className="w-full rounded-full h-2" style={{ background: "var(--surface2)" }}>
                  <div className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${jobStatus.progress}%`, background: "linear-gradient(90deg,#7c3aed,#a855f7)" }} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2" style={{ color: "var(--muted)" }}>
                    <Loader2 size={12} className="animate-spin" /> {jobStatus.status}
                  </span>
                  <span style={{ color: "#a855f7" }}>{jobStatus.progress}%</span>
                </div>
              </div>
            )}

            {isDone && (
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm font-medium" style={{ color: "#86efac" }}>
                  ✓ Your video is ready!
                </p>
                <button onClick={() => window.open(`/api/download?id=${jobId}`, "_blank")}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff" }}>
                  <Download size={16} /> Download MP4
                </button>
                {/* ── Transfer to Reel Studio ── */}
                {outputPath && jobId && (
                  <Link
                    href={`/?from_job=${jobId}&path=${encodeURIComponent(outputPath)}`}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{ background: "linear-gradient(135deg,#059669,#10b981)", color: "#fff" }}>
                    <Type size={15} /> Open in Reel Studio → Add Subtitles
                  </Link>
                )}
                <button onClick={() => { setJobId(null); setJobStatus(null); setIsDone(false); setOutputPath(null); }}
                  className="w-full py-2 rounded-xl text-xs border"
                  style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--surface2)" }}>
                  Export again
                </button>
              </div>
            )}

            {jobStatus?.error && (
              <div className="mt-2 rounded-xl p-3 text-xs"
                style={{ background: "#1a0808", color: "#fca5a5" }}>
                {jobStatus.error}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Hidden inputs */}
      <input ref={fileInputRef} type="file" accept="video/*,image/*" multiple className="hidden"
        onChange={e => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

// ── Media Card ─────────────────────────────────────────────────────────────────
function MediaCard({ item, selected, onSelect, onUpdate, onDelete, canMoveLeft, canMoveRight, onMoveLeft, onMoveRight }: {
  item: MediaItem; selected: boolean;
  onSelect: () => void; onUpdate: (p: Partial<MediaItem>) => void; onDelete: () => void;
  canMoveLeft: boolean; canMoveRight: boolean; onMoveLeft: () => void; onMoveRight: () => void;
}) {
  return (
    <div onClick={onSelect}
      className="flex-shrink-0 w-32 rounded-xl border cursor-pointer transition-all overflow-hidden"
      style={{
        borderColor:  selected ? "#7c3aed" : "var(--border)",
        background:   selected ? "rgba(124,58,237,.1)" : "var(--surface2)",
        boxShadow:    selected ? "0 0 0 2px rgba(124,58,237,.3)" : "none",
      }}>
      {/* Thumbnail */}
      <div className="relative h-20 bg-black overflow-hidden">
        {item.type === "video"
          ? <video src={item.localUrl} className="w-full h-full object-cover" muted preload="metadata" />
          : /* eslint-disable-next-line @next/next/no-img-element */
            <img src={item.localUrl} alt={item.name} className="w-full h-full object-cover" />}
        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
          style={{ background: item.type === "video" ? "rgba(124,58,237,.9)" : "rgba(22,163,74,.9)", color: "#fff" }}>
          {item.type === "video" ? <Film size={8} className="inline mr-0.5" /> : <ImageIcon size={8} className="inline mr-0.5" />}
          {item.type}
        </div>
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1 right-1 w-4 h-4 rounded flex items-center justify-center"
          style={{ background: "rgba(0,0,0,.6)" }}>
          <X size={8} className="text-white" />
        </button>
      </div>

      <div className="p-1.5 space-y-1.5" onClick={e => e.stopPropagation()}>
        <p className="text-[9px] truncate" style={{ color: "var(--muted)" }}>{item.name}</p>

        {item.type === "image" ? (
          <div>
            <label className="text-[9px] block mb-0.5" style={{ color: "var(--muted)" }}>Duration (s)</label>
            <input type="number" step="0.5" min={0.5} max={60} value={item.duration}
              onChange={e => onUpdate({ duration: +e.target.value })}
              className="w-full px-1.5 py-1 rounded text-[10px] outline-none border"
              style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--foreground)" }} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-0.5">
            <div>
              <label className="text-[9px] block" style={{ color: "var(--muted)" }}>Start</label>
              <input type="number" step="0.1" min={0} value={item.trimStart}
                onChange={e => onUpdate({ trimStart: +e.target.value })}
                className="w-full px-1 py-0.5 rounded text-[9px] outline-none border"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--foreground)" }} />
            </div>
            <div>
              <label className="text-[9px] block" style={{ color: "var(--muted)" }}>End</label>
              <input type="number" step="0.1" min={0} value={item.trimEnd ?? item.duration}
                onChange={e => onUpdate({ trimEnd: +e.target.value })}
                className="w-full px-1 py-0.5 rounded text-[9px] outline-none border"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--foreground)" }} />
            </div>
          </div>
        )}

        {/* Reorder */}
        <div className="flex gap-1">
          <button disabled={!canMoveLeft} onClick={onMoveLeft}
            className="flex-1 py-0.5 rounded text-[10px] border disabled:opacity-25"
            style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--surface)" }}>
            ←
          </button>
          <button disabled={!canMoveRight} onClick={onMoveRight}
            className="flex-1 py-0.5 rounded text-[10px] border disabled:opacity-25"
            style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--surface)" }}>
            →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Text Layer Card ───────────────────────────────────────────────────────────
function TextLayerCard({ layer, index, totalDuration, onUpdate, onDelete }: {
  layer: TextLayer; index: number; totalDuration: number;
  onUpdate: (p: Partial<TextLayer>) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(true);

  // Find nearest position preset
  const nearestLabel = POS_GRID.reduce((best, p) => {
    const d = Math.abs(p.x - layer.position_x) + Math.abs(p.y - layer.position_y);
    const bd = Math.abs(best.x - layer.position_x) + Math.abs(best.y - layer.position_y);
    return d < bd ? p : best;
  }).label;

  return (
    <div className="rounded-xl border overflow-hidden"
      style={{ borderColor: "var(--border)", background: "var(--surface2)" }}>
      <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}>
        <span className="w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0"
          style={{ background: "#7c3aed", color: "#fff" }}>{index + 1}</span>
        <span className="flex-1 text-xs truncate"
          style={{ color: layer.text ? "var(--foreground)" : "var(--muted)" }}>
          {layer.text || "(empty text)"}
        </span>
        <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--muted)" }}>
          {layer.start}–{layer.end}s
        </span>
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          className="hover:text-red-400 transition-colors shrink-0"
          style={{ color: "var(--muted)" }}>
          <Trash2 size={12} />
        </button>
        {open
          ? <ChevronUp size={11} style={{ color: "var(--muted)" }} />
          : <ChevronDown size={11} style={{ color: "var(--muted)" }} />}
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>
          {/* Text */}
          <div className="pt-2">
            <input value={layer.text} onChange={e => onUpdate({ text: e.target.value })}
              placeholder="Enter your text…"
              className="w-full px-2.5 py-2 rounded-lg border text-sm outline-none"
              style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--foreground)" }} />
          </div>

          {/* Time range */}
          <div className="grid grid-cols-2 gap-2">
            {([
              { k: "start" as const, label: "Start (s)" },
              { k: "end"   as const, label: "End (s)" },
            ]).map(({ k, label }) => (
              <div key={k}>
                <label className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>{label}</label>
                <input type="number" step="0.1" min={0} max={totalDuration || 999} value={layer[k]}
                  onChange={e => onUpdate({ [k]: +e.target.value })}
                  className="w-full px-2 py-1.5 rounded-lg border text-xs outline-none"
                  style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--foreground)" }} />
              </div>
            ))}
          </div>

          {/* Position */}
          <div>
            <p className="text-[10px] mb-1.5 flex items-center gap-1" style={{ color: "var(--muted)" }}>
              <Move size={9} /> Position
            </p>
            <div className="grid grid-cols-3 gap-1">
              {POS_GRID.map(p => (
                <button key={p.label} onClick={() => onUpdate({ position_x: p.x, position_y: p.y })}
                  className="py-1.5 rounded text-xs font-mono transition-all"
                  style={nearestLabel === p.label
                    ? { background: "rgba(124,58,237,.25)", color: "#a855f7", border: "1px solid #7c3aed" }
                    : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--border)" }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font */}
          <div>
            <p className="text-[10px] mb-1.5" style={{ color: "var(--muted)" }}>Font</p>
            <div className="grid grid-cols-3 gap-1">
              {FONTS.map(f => (
                <button key={f.key} onClick={() => onUpdate({ font: f.key })}
                  className="py-1.5 px-1 rounded border text-center transition-all"
                  style={layer.font === f.key
                    ? { borderColor: "#7c3aed", background: "rgba(124,58,237,.15)", color: "#a855f7" }
                    : { borderColor: "var(--border)", background: "var(--surface)", color: "var(--muted)" }}>
                  <span className="text-[10px] font-semibold block truncate"
                    style={{ fontFamily: f.family }}>{f.sample}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Size + Color */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Size · {layer.size}px</label>
              <input type="range" min={16} max={96} step={2} value={layer.size}
                onChange={e => onUpdate({ size: +e.target.value })}
                className="w-full" style={{ accentColor: "#7c3aed" }} />
            </div>
            <div>
              <label className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Color</label>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border"
                style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <input type="color" value={layer.color} onChange={e => onUpdate({ color: e.target.value })}
                  className="w-6 h-6 rounded cursor-pointer p-0 border-0"
                  style={{ background: "transparent" }} />
                <span className="text-[10px] font-mono" style={{ color: "var(--muted)" }}>{layer.color}</span>
              </div>
            </div>
          </div>

          {/* Outline + Shadow */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Outline · {layer.stroke}px</label>
              <div className="flex items-center gap-1.5">
                <input type="color" value={layer.stroke_color}
                  onChange={e => onUpdate({ stroke_color: e.target.value })}
                  className="w-5 h-5 rounded cursor-pointer p-0 border-0 shrink-0"
                  style={{ background: "transparent" }} />
                <input type="range" min={0} max={8} step={1} value={layer.stroke}
                  onChange={e => onUpdate({ stroke: +e.target.value })}
                  className="flex-1" style={{ accentColor: "#7c3aed" }} />
              </div>
            </div>
            <div>
              <label className="text-[10px] block mb-1" style={{ color: "var(--muted)" }}>Shadow · {layer.shadow_blur}px</label>
              <input type="range" min={0} max={20} step={1} value={layer.shadow_blur}
                onChange={e => onUpdate({ shadow_blur: +e.target.value })}
                className="w-full" style={{ accentColor: "#7c3aed" }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
