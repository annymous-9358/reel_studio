import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

const script = `
import ssl, json, sys, os, subprocess, tempfile, shutil
ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops

cfg       = json.loads(sys.stdin.read())
url       = cfg.get("url", "")
do_transcribe = cfg.get("transcribe", True)
language  = cfg.get("language", "auto")

tmp_dir = tempfile.mkdtemp(prefix="inspo_")

# ── 1. Download video ─────────────────────────────────────────────────────────
out_tmpl = os.path.join(tmp_dir, "inspo.%(ext)s")
r = subprocess.run(
    ["yt-dlp", "--socket-timeout", "20", "--retries", "2",
     "-f", "mp4/best[height<=720]/best",
     "-o", out_tmpl, url],
    capture_output=True, text=True
)
if r.returncode != 0:
    print(json.dumps({"error": "Download failed: " + r.stderr[-300:]}))
    shutil.rmtree(tmp_dir, ignore_errors=True)
    sys.exit(0)

# Find downloaded file
files = list(Path(tmp_dir).glob("inspo.*"))
if not files:
    print(json.dumps({"error": "Downloaded file not found"}))
    shutil.rmtree(tmp_dir, ignore_errors=True)
    sys.exit(0)
video_path = str(files[0])

# ── 2. Extract frames (low-res, 1 fps, max 15 frames) ────────────────────────
frames_dir = os.path.join(tmp_dir, "frames")
os.makedirs(frames_dir)
subprocess.run([
    "ffmpeg", "-y", "-i", video_path,
    "-vf", "fps=1,scale=360:-2",
    "-frames:v", "15",
    f"{frames_dir}/%03d.png",
], capture_output=True)

frames = []
for fp in sorted(Path(frames_dir).glob("*.png"))[:15]:
    try:
        frames.append(Image.open(fp).convert("RGB"))
    except Exception:
        pass

# ── 3. Detect text region ─────────────────────────────────────────────────────
# Strategy: text overlays are bright pixels (white/yellow) immediately next to
# dark pixels (outline/shadow). MaxFilter expands the dark mask so we can AND.
def analyze_text_style(frames):
    if not frames:
        return 50, 80, "#ffffff", 28

    W, H = frames[0].size
    boxes   = []
    colors  = []

    for frame in frames:
        gray = frame.convert("L")

        bright   = gray.point(lambda p: 255 if p > 170 else 0)
        dark     = gray.point(lambda p: 255 if p < 90  else 0)
        dark_exp = dark.filter(ImageFilter.MaxFilter(7))   # dilate 3 px

        text_mask = ImageChops.multiply(bright, dark_exp)
        bbox = text_mask.getbbox()
        if not bbox:
            continue

        x1, y1, x2, y2 = bbox
        boxes.append((x1, y1, x2, y2))

        # Sample bright pixels inside bbox for color
        region  = frame.crop(bbox)
        data    = list(region.getdata())
        bright_pix = [p for p in data if (p[0]+p[1]+p[2])//3 > 150]
        if bright_pix:
            r = sum(p[0] for p in bright_pix) // len(bright_pix)
            g = sum(p[1] for p in bright_pix) // len(bright_pix)
            b = sum(p[2] for p in bright_pix) // len(bright_pix)
            colors.append((r, g, b))

    if not boxes:
        return 50, 80, "#ffffff", 28

    def med(lst):
        return sorted(lst)[len(lst) // 2]

    cx_pct = med([(x1+x2)/2 / W * 100 for x1,y1,x2,y2 in boxes])
    cy_pct = med([(y1+y2)/2 / H * 100 for x1,y1,x2,y2 in boxes])
    heights = [y2 - y1 for x1,y1,x2,y2 in boxes]
    avg_h   = med(heights)
    # Scale font_size: frames are resized to ~360px wide; typical reel is 1080px,
    # so multiply detected height by ~3 for a rough real-size estimate
    font_size = max(16, min(72, int(avg_h * 2.5)))

    if colors:
        r = sum(c[0] for c in colors) // len(colors)
        g = sum(c[1] for c in colors) // len(colors)
        b = sum(c[2] for c in colors) // len(colors)
        # Clamp toward pure white/yellow if very bright (avoid muted off-whites)
        if r > 200 and g > 200 and b > 200:
            color = "#ffffff"
        elif r > 200 and g > 180 and b < 120:
            color = "#ffee00"   # yellow
        else:
            color = f"#{r:02x}{g:02x}{b:02x}"
    else:
        color = "#ffffff"

    return round(cx_pct), round(cy_pct), color, font_size

pos_x, pos_y, color, font_size = analyze_text_style(frames)

# ── Color grading analysis ────────────────────────────────────────────────────
def analyze_color_grade(frames):
    """Estimate brightness / contrast / saturation of the video."""
    if not frames: return 0, 0, 100

    all_lum, all_sat = [], []
    for frame in frames:
        data = list(frame.getdata())
        sample = data[::8]   # sample every 8th pixel for speed
        lums = [(0.299*r + 0.587*g + 0.114*b) for r,g,b in sample]
        # Saturation: distance from grey / max channel
        sats = []
        for r,g,b in sample:
            mx = max(r,g,b,1)
            mn = min(r,g,b)
            sats.append((mx - mn) / mx * 100)
        all_lum.extend(lums)
        all_sat.extend(sats)

    avg_lum = sum(all_lum) / max(len(all_lum), 1)
    avg_sat = sum(all_sat) / max(len(all_sat), 1)

    # Contrast: std-dev of luminance (simplified)
    mean = avg_lum
    variance = sum((l - mean)**2 for l in all_lum) / max(len(all_lum), 1)
    std_lum = variance ** 0.5

    # Map to UI slider ranges:
    # brightness: neutral=128 → 0, darker=0 → -50, brighter=255 → +50
    brightness_adj = round((avg_lum - 128) / 128 * 50)
    # contrast: neutral std~40 → 0; lower std → negative; higher → positive
    contrast_adj   = round((std_lum - 40) / 40 * 30)
    # saturation: neutral~30 → 100; scale to 0-200
    saturation_adj = round(min(200, max(0, avg_sat / 30 * 100)))

    return (
        max(-50, min(50, brightness_adj)),
        max(-50, min(50, contrast_adj)),
        saturation_adj,
    )

brightness_adj, contrast_adj, saturation_adj = analyze_color_grade(frames)

result = {
    "style": {
        "position_x":  pos_x,
        "position_y":  pos_y,
        "color":       color,
        "font_size":   font_size,
        "stroke":      2,
        "stroke_color":"#000000",
        "shadow_blur": 4,
        "font":        "impact",
        "animation":   "word_by_word",
    },
    "color_grade": {
        "brightness": brightness_adj,
        "contrast":   contrast_adj,
        "saturation": saturation_adj,
    },
}

# ── 4. Transcribe audio ───────────────────────────────────────────────────────
if do_transcribe:
    import whisper
    model = whisper.load_model("small")
    lang_kwargs = {"task": "transcribe"}
    if language == "hinglish":
        lang_kwargs["language"]        = "hi"
        lang_kwargs["initial_prompt"]  = (
            "Yaar yeh Hinglish song hai. Har word Roman English mein likho. "
            "Devanagari mat use karo."
        )
    elif language == "hi":
        lang_kwargs["language"] = "hi"
    elif language == "en":
        lang_kwargs["language"] = "en"

    tr = model.transcribe(video_path, word_timestamps=True, verbose=False, **lang_kwargs)

    words = []
    for seg in tr["segments"]:
        for w in seg.get("words", []):
            clean = w["word"].strip()
            if clean:
                words.append({
                    "word":  clean,
                    "start": round(w["start"], 3),
                    "end":   round(w["end"],   3),
                })

    result["words"]    = words
    result["text"]     = tr["text"].strip()
    result["language"] = tr["language"]

shutil.rmtree(tmp_dir, ignore_errors=True)
print(json.dumps(result))
`;

export async function POST(req: NextRequest) {
  const { url, transcribe = true, language = "auto" } = await req.json();
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const cfg = JSON.stringify({ url, transcribe, language });

  return new Promise<NextResponse>((resolve) => {
    const proc = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin.write(cfg);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // Generous timeout — download + Whisper can be slow
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(NextResponse.json({ error: "Analysis timed out (3 min). Try a shorter video." }, { status: 504 }));
    }, 180_000);

    proc.on("close", (code: number) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(NextResponse.json({ error: stderr.slice(-400) }, { status: 500 }));
        return;
      }
      try {
        const lastLine = stdout.trim().split("\n").pop()!;
        const data = JSON.parse(lastLine);
        if (data.error) resolve(NextResponse.json({ error: data.error }, { status: 500 }));
        else resolve(NextResponse.json(data));
      } catch {
        resolve(NextResponse.json({ error: "Parse error", raw: stdout.slice(-300) }, { status: 500 }));
      }
    });
  });
}
