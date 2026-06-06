#!/usr/bin/env python3
"""
Reel Studio — Editor processor.
Handles: images + video clips → concat → effects → audio → text overlay → HD output.
Input: JSON on stdin.  Output: PROGRESS/STATUS/DONE/ERROR lines on stdout.
"""
import sys, json, os, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

_LIB = Path(__file__).parent

def _find(candidates):
    for p in candidates:
        if Path(p).exists(): return str(p)
    return None

_FALLBACK        = str(_LIB / "fonts/Poppins-Regular.ttf")
_FALLBACK_SCRIPT = str(_LIB / "fonts/GreatVibes.ttf")

FONTS = {
    "impact":      _find([str(_LIB/"fonts/Impact.ttf"),
                          "/System/Library/Fonts/Supplemental/Impact.ttf",
                          "/usr/local/share/fonts/reelstudio/Impact.ttf",
                          "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"]) or _FALLBACK,
    "bebas":       _find(["/usr/local/share/fonts/reelstudio/BebasNeue.ttf",
                          str(_LIB/"fonts/BebasNeue.ttf")]) or _FALLBACK,
    "oswald":      _find(["/usr/local/share/fonts/reelstudio/Oswald-Bold.ttf",
                          str(_LIB/"fonts/Oswald-Bold.ttf")]) or _FALLBACK,
    "poppins":     str(_LIB / "fonts/Poppins-Regular.ttf"),
    "great_vibes": str(_LIB / "fonts/GreatVibes.ttf"),
    "pacifico":    _find(["/usr/local/share/fonts/reelstudio/Pacifico.ttf",
                          str(_LIB/"fonts/Pacifico.ttf")]) or _FALLBACK_SCRIPT,
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def prog(p: int, s: str):
    print(f"PROGRESS:{p}", flush=True)
    print(f"STATUS:{s}", flush=True)

def hex_rgba(h: str, a: int = 255):
    h = h.lstrip("#")
    return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16), a)

def get_font(key: str, size: int):
    path = FONTS.get(key, _FALLBACK)
    try:    return ImageFont.truetype(path, size)
    except: return ImageFont.load_default()

def probe_video(path: str):
    r = subprocess.run(["ffprobe","-v","quiet","-print_format","json",
                        "-show_streams", path], capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
        for s in d.get("streams", []):
            if s.get("codec_type") == "video":
                fps_str = s.get("r_frame_rate","30/1")
                n, denom = fps_str.split("/")
                fps = float(n)/float(denom)
                return s.get("width",1080), s.get("height",1920), fps
    except:
        pass
    return 1080, 1920, 30.0

# ── Text rendering ────────────────────────────────────────────────────────────
def draw_outlined(draw, xy, text, font, fill, stroke_px, stroke_rgba):
    x, y = xy
    if stroke_px > 0:
        for ox in range(-stroke_px, stroke_px+1):
            for oy in range(-stroke_px, stroke_px+1):
                if ox or oy:
                    draw.text((x+ox, y+oy), text, font=font, fill=stroke_rgba, anchor="mm")
    draw.text(xy, text, font=font, fill=fill, anchor="mm")

def render_text_layers(frame: Image.Image, t: float, layers: list, W: int, H: int) -> Image.Image:
    overlay = Image.new("RGBA", (W, H), (0,0,0,0))
    draw    = ImageDraw.Draw(overlay)
    changed = False

    for layer in layers:
        text = (layer.get("text") or "").strip()
        if not text: continue
        if not (float(layer.get("start", 0)) <= t <= float(layer.get("end", 999))):
            continue
        changed = True

        font_key   = layer.get("font", "impact")
        font_size  = int(layer.get("size", 32))
        font       = get_font(font_key, font_size)

        pos_x = float(layer.get("position_x", 50)) / 100.0 * W
        pos_y = float(layer.get("position_y", 80)) / 100.0 * H

        fill       = hex_rgba(layer.get("color", "#ffffff"))
        stroke_px  = int(layer.get("stroke", 2))
        stroke_rgba= hex_rgba(layer.get("stroke_color", "#000000"), 200)
        shadow     = int(layer.get("shadow_blur", 4))

        # Shadow layer
        if shadow > 0:
            shad = Image.new("RGBA", (W, H), (0,0,0,0))
            sd   = ImageDraw.Draw(shad)
            sd.text((pos_x, pos_y + shadow), text, font=font, fill=(0,0,0,180), anchor="mm")
            shad = shad.filter(ImageFilter.GaussianBlur(shadow))
            overlay = Image.alpha_composite(overlay, shad)
            draw    = ImageDraw.Draw(overlay)

        draw_outlined(draw, (pos_x, pos_y), text, font, fill, stroke_px, stroke_rgba)

    if not changed:
        return frame.convert("RGB")
    base   = frame.convert("RGBA")
    result = Image.alpha_composite(base, overlay)
    return result.convert("RGB")

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    cfg        = json.loads(sys.stdin.read())
    output_dir = cfg["output_dir"]
    items      = cfg.get("media_items", [])
    audio      = cfg.get("audio", {})
    effects    = cfg.get("effects", {})
    layers     = cfg.get("text_layers", [])

    if not items:
        print("ERROR:No media items provided", flush=True)
        return

    tmp = tempfile.mkdtemp(prefix="editor_")
    try:
        # ── 1. Determine output dimensions ────────────────────────────────────
        out_w, out_h = 1080, 1920
        for item in items:
            if item.get("type") == "video":
                w, h, _ = probe_video(item["path"])
                if w > h: out_w, out_h = 1920, 1080
                break
        # Also accept explicit override
        if cfg.get("output_width"):  out_w = cfg["output_width"]
        if cfg.get("output_height"): out_h = cfg["output_height"]

        scale_vf = (f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
                    f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")

        # BT.709 color metadata flags — added to every libx264 encode so players
        # never have to guess the color space (unknown → wrong matrix → color shift).
        _bt709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]

        # ── 2. Normalize each item → MP4 clip ─────────────────────────────────
        clips = []
        for i, item in enumerate(items):
            prog(5 + int(i / len(items) * 20), f"Processing item {i+1}/{len(items)}…")
            out_clip = os.path.join(tmp, f"clip_{i:03d}.mp4")

            if item.get("type") == "image":
                dur = max(0.5, float(item.get("duration", 3)))
                subprocess.run([
                    "ffmpeg", "-y", "-loop", "1", "-t", str(dur), "-i", item["path"],
                    "-vf", f"{scale_vf},fps=30",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", *_bt709, "-an", out_clip
                ], capture_output=True)
            else:  # video
                ts  = float(item.get("trim_start", 0))
                te  = item.get("trim_end")
                cmd = ["ffmpeg", "-y"]
                if ts > 0: cmd += ["-ss", str(ts)]
                cmd += ["-i", item["path"]]
                if te is not None: cmd += ["-t", str(float(te) - ts)]
                cmd += ["-vf", f"{scale_vf},fps=30",
                        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", *_bt709, "-an", out_clip]
                subprocess.run(cmd, capture_output=True)

            clips.append(out_clip)

        # ── 3. Concatenate ─────────────────────────────────────────────────────
        prog(27, "Combining clips…")
        if len(clips) == 1:
            combined = clips[0]
        else:
            list_file = os.path.join(tmp, "list.txt")
            with open(list_file, "w") as f:
                for c in clips: f.write(f"file '{c}'\n")
            combined = os.path.join(tmp, "combined.mp4")
            subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                            "-i", list_file, "-c", "copy", combined], capture_output=True)

        # ── 4. Effects ─────────────────────────────────────────────────────────
        prog(35, "Applying color & effects…")
        br    = effects.get("brightness", 0) / 50.0          # -1 to +1
        co    = 1.0 + effects.get("contrast", 0) / 100.0
        sa    = effects.get("saturation", 100) / 100.0
        speed = float(effects.get("speed", 1))
        fh    = bool(effects.get("flip_h", False))
        fv    = bool(effects.get("flip_v", False))

        # Only add eq when values are actually non-neutral — avoids ffmpeg's
        # internal YUV↔RGB round-trip which shifts colors even at "identity" settings.
        vf = []
        if abs(br) > 0.005 or abs(co - 1.0) > 0.01 or abs(sa - 1.0) > 0.01:
            vf.append(f"eq=brightness={br:.3f}:contrast={co:.3f}:saturation={sa:.3f}")
        if speed != 1.0: vf.append(f"setpts={1/speed:.4f}*PTS")
        if fh: vf.append("hflip")
        if fv: vf.append("vflip")

        effected = os.path.join(tmp, "effected.mp4")
        if vf:
            # Apply filters + tag bt709 metadata
            subprocess.run(["ffmpeg", "-y", "-i", combined,
                            "-vf", ",".join(vf),
                            "-c:v", "libx264", "-crf", "16", "-preset", "fast",
                            "-pix_fmt", "yuv420p", *_bt709, effected],
                           capture_output=True)
        else:
            # No visual changes — just copy to stamp bt709 metadata (fast stream-copy
            # preserves original quality; re-encode only when we actually need metadata)
            subprocess.run(["ffmpeg", "-y", "-i", combined,
                            "-c:v", "libx264", "-crf", "16", "-preset", "fast",
                            "-pix_fmt", "yuv420p", *_bt709, effected],
                           capture_output=True)

        # ── 5. Audio ───────────────────────────────────────────────────────────
        prog(50, "Processing audio…")
        a_mode = audio.get("mode", "none")
        a_path = audio.get("path")
        a_url  = audio.get("url", "")
        a_vol  = float(audio.get("volume", 100)) / 100.0

        if a_mode == "url" and a_url:
            tmpl = os.path.join(tmp, "audio.%(ext)s")
            subprocess.run(["yt-dlp", "--socket-timeout", "20", "-x",
                            "--audio-format", "mp3", "-o", tmpl, a_url],
                           capture_output=True)
            cands = list(Path(tmp).glob("audio.*"))
            a_path = str(cands[0]) if cands else None

        current = effected
        if a_path and Path(a_path).exists():
            with_audio = os.path.join(tmp, "with_audio.mp4")
            af_parts = [f"volume={a_vol:.3f}"]
            if speed != 1.0:
                # atempo only supports 0.5-2.0; chain for values outside range
                s = speed
                while s > 2.0:   af_parts.append("atempo=2.0"); s /= 2.0
                while s < 0.5:   af_parts.append("atempo=0.5"); s /= 0.5
                af_parts.append(f"atempo={s:.4f}")
            subprocess.run(["ffmpeg", "-y", "-i", effected, "-i", a_path,
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-map", "0:v", "-map", "1:a",
                            "-af", ",".join(af_parts),
                            "-shortest", with_audio], capture_output=True)
            current = with_audio

        # ── 6. Burn text layers ────────────────────────────────────────────────
        if layers:
            prog(60, "Rendering text overlays…")
            vid_w, vid_h, fps = probe_video(current)

            frames_dir = os.path.join(tmp, "tframes")
            os.makedirs(frames_dir)
            subprocess.run(["ffmpeg", "-y", "-i", current,
                            f"{frames_dir}/%06d.png"], capture_output=True)

            ffiles = sorted(Path(frames_dir).glob("*.png"))
            total  = len(ffiles)

            for fi, fp in enumerate(ffiles):
                t = fi / fps
                active = [l for l in layers
                          if float(l.get("start",0)) <= t <= float(l.get("end",9999))
                          and (l.get("text") or "").strip()]
                if active:
                    frame   = Image.open(fp)
                    rendered = render_text_layers(frame, t, active, vid_w, vid_h)
                    rendered.save(fp)
                    frame.close()
                if fi % 60 == 0:
                    prog(60 + int(fi/total*22), f"Rendering frames… {fi}/{total}")

            prog(83, "Encoding final video…")
            output = os.path.join(output_dir, "output.mp4")
            subprocess.run(["ffmpeg", "-y",
                            "-framerate", str(fps),
                            "-i", f"{frames_dir}/%06d.png",
                            "-i", current,
                            "-map", "0:v", "-map", "1:a",
                            "-c:v", "libx264", "-crf", "15", "-preset", "medium",
                            "-pix_fmt", "yuv420p", *_bt709,
                            "-c:a", "copy", "-movflags", "+faststart", output],
                           capture_output=True)
        else:
            prog(85, "Finalizing…")
            output = os.path.join(output_dir, "output.mp4")
            shutil.copy2(current, output)

        print(f"DONE:{output}", flush=True)

    except Exception:
        import traceback
        print(f"ERROR:{traceback.format_exc()}", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
