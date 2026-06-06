#!/usr/bin/env python3
"""
Reel Studio — video processor.
Called by Next.js API with a JSON config on stdin.
Outputs progress lines: PROGRESS:0-100 and DONE:<output_path>
"""
import sys, json, os, shutil, math, subprocess, tempfile, ssl
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ssl._create_default_https_context = ssl._create_unverified_context

_LIB = Path(__file__).parent

def _find(candidates):
    for p in candidates:
        if Path(p).exists(): return str(p)
    return None

_FALLBACK = str(_LIB / "fonts/Poppins-Regular.ttf")
_FALLBACK_SCRIPT = str(_LIB / "fonts/GreatVibes.ttf")

FONTS = {
    "impact":      _find([str(_LIB/"fonts/Impact.ttf"), "/System/Library/Fonts/Supplemental/Impact.ttf",
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

def log(msg): print(msg, flush=True)
def progress(n): log(f"PROGRESS:{n}")

def ease_out(t):
    return 1 - (1 - min(t, 1.0)) ** 3

def get_font(path, size):
    try:    return ImageFont.truetype(path, size)
    except: return ImageFont.load_default()

def tw(draw, text, font):
    bb = draw.textbbox((0,0), text, font=font)
    return bb[2]-bb[0], bb[3]-bb[1]

def draw_text_styled(draw, xy, text, font, color, stroke_px, stroke_rgba=(0,0,0,153)):
    x, y = xy
    if stroke_px > 0:
        for ox, oy in [(ox, oy) for ox in range(-stroke_px, stroke_px+1)
                                for oy in range(-stroke_px, stroke_px+1)
                                if (ox or oy)]:
            draw.text((x+ox, y+oy), text, font=font, fill=stroke_rgba)
    draw.text((x, y), text, font=font, fill=color)

def build_rows(all_words, max_w, font_n, draw):
    sp_w,_ = tw(draw, " ", font_n)
    rows, cur, cur_w = [], [], 0
    for entry in all_words:
        word = entry["word"]
        ww,_ = tw(draw, word, font_n)
        if cur_w + ww > max_w and cur:
            rows.append(cur); cur=[entry]; cur_w=ww+sp_w
        else:
            cur.append(entry); cur_w+=ww+sp_w
    if cur: rows.append(cur)
    return rows

def render_frame(img, t, segments, cfg):
    W, H = img.size
    font_key    = cfg.get("font", "impact")
    font_size   = cfg.get("font_size", 28)
    color_hex   = cfg.get("color", "#ffffff")
    animation   = cfg.get("animation", "word_by_word")
    stroke_px   = cfg.get("stroke", 2)
    stroke_hex  = cfg.get("stroke_color", "#000000")
    shadow_blur = cfg.get("shadow_blur", 0)
    bounce_dur  = 0.12

    # Position: new x/y percent API; legacy top/center/bottom fallback
    pos_x_pct = cfg.get("position_x", None)
    pos_y_pct = cfg.get("position_y", None)
    if pos_x_pct is None or pos_y_pct is None:
        legacy = cfg.get("position", "center")
        pos_x_pct = 50
        pos_y_pct = {"top": 10, "center": 50, "bottom": 85}.get(legacy, 50)

    font_path = FONTS.get(font_key, FONTS["poppins"])
    font_n = get_font(font_path, font_size)
    font_c = get_font(font_path, int(font_size * 1.12))

    # Parse text color
    h = color_hex.lstrip("#")
    color = tuple(int(h[i:i+2],16) for i in (0,2,4)) + (255,)

    # Parse stroke color
    hs = stroke_hex.lstrip("#")
    stroke_rgba = tuple(int(hs[i:i+2],16) for i in (0,2,4)) + (200,)

    # Find active segment
    seg = next((s for s in segments if s["start"] <= t < s["end"]), None)
    if seg is None:
        return img

    words_in_seg = seg["words"]
    MARGIN = 24
    MAX_W  = W - MARGIN*2

    tmp_img  = Image.new("RGB",(1,1))
    tmp_draw = ImageDraw.Draw(tmp_img)
    rows = build_rows(words_in_seg, MAX_W, font_n, tmp_draw)

    img  = img.convert("RGBA")
    draw = ImageDraw.Draw(img)
    sp_w,_ = tw(draw," ",font_n)
    _,fh   = tw(draw,"Ag",font_n)
    row_gap = 6
    n_rows  = len(rows)
    block_h = n_rows*fh + (n_rows-1)*row_gap

    center_x = int(W * pos_x_pct / 100)
    center_y = int(H * pos_y_pct / 100)
    block_y  = max(MARGIN, min(center_y - block_h // 2, H - block_h - MARGIN))

    for ri, row in enumerate(rows):
        y = block_y + ri*(fh+row_gap)

        if animation == "none":
            visible = row
        elif animation == "fade":
            # whole segment fades in
            seg_age = t - seg["start"]
            seg_dur = seg["end"] - seg["start"]
            fade_alpha = min(255, int(255 * ease_out(seg_age / 0.3))) if seg_age < 0.3 else 255
            visible = [(w, fade_alpha) for w in row]
        else:  # word_by_word
            visible = [(w, 255) for w in row if t >= w["start"]]

        if not visible:
            continue

        if animation == "fade":
            word_items = visible
        else:
            word_items = [(w, 255) for w in (visible if animation=="none" else [v[0] for v in visible])]

        vis_w = sum(tw(draw, item[0]["word"] if isinstance(item, tuple) else item["word"], font_n)[0]
                    for item in word_items)
        vis_w += sp_w * max(len(word_items)-1, 0)
        x = max(MARGIN, center_x - vis_w // 2)

        for item in word_items:
            entry = item[0] if isinstance(item, tuple) else item
            alpha = item[1] if isinstance(item, tuple) else 255
            word  = entry["word"]
            ws, we = entry["start"], entry["end"]
            is_cur = ws <= t < we
            font   = font_c if is_cur and animation=="word_by_word" else font_n
            ww,wh  = tw(draw, word, font)
            ww_n,_ = tw(draw, word, font_n)

            age = t - ws
            if animation == "word_by_word" and 0 < age < bounce_dur:
                scale = 0.4 + 0.6*ease_out(age/bounce_dur)
                alpha = int(255*ease_out(age/bounce_dur))
            else:
                scale = 1.0

            word_color = color[:3] + (alpha,)
            if is_cur and animation == "word_by_word":
                # slightly brighter / warm tint for current word
                r,g,b = min(255,color[0]+20), min(255,color[1]+10), max(0,color[2]-30)
                word_color = (r,g,b,alpha)

            if scale < 0.98:
                sw=max(1,int(ww*scale)); sh=max(1,int(wh*scale))
                tmp=Image.new("RGBA",(ww+12,wh+12),(0,0,0,0))
                td=ImageDraw.Draw(tmp)
                if shadow_blur > 0:
                    stmp=Image.new("RGBA",(ww+12,wh+12),(0,0,0,0))
                    sd=ImageDraw.Draw(stmp)
                    sd.text((8,8),word,font=font,fill=(0,0,0,180))
                    stmp=stmp.filter(ImageFilter.GaussianBlur(shadow_blur*0.5))
                    tmp=Image.alpha_composite(tmp,stmp)
                    td=ImageDraw.Draw(tmp)
                draw_text_styled(td,(6,6),word,font,word_color,stroke_px,stroke_rgba)
                tmp=tmp.resize((sw,sh),Image.LANCZOS)
                img.paste(tmp,(x+(ww_n-sw)//2,y+(fh-sh)//2),tmp)
            else:
                if shadow_blur > 0:
                    stmp=Image.new("RGBA",img.size,(0,0,0,0))
                    sd=ImageDraw.Draw(stmp)
                    sd.text((x+shadow_blur//2,y+shadow_blur//2),word,font=font,fill=(0,0,0,180))
                    stmp=stmp.filter(ImageFilter.GaussianBlur(shadow_blur*0.5))
                    img=Image.alpha_composite(img,stmp)
                    draw=ImageDraw.Draw(img)
                draw_text_styled(draw,(x,y),word,font,word_color,stroke_px,stroke_rgba)
            x += ww_n+sp_w

    return img.convert("RGB")

def process(cfg):
    video_path = cfg["video_path"]
    audio_path = cfg.get("audio_path")
    audio_url  = cfg.get("audio_url")
    segments   = cfg["segments"]
    output_dir = cfg.get("output_dir", "/tmp/reel_studio_out")
    job_id     = cfg.get("job_id", "job")

    out_dir = Path(output_dir)
    frames_dir = out_dir / "frames"
    out_frames = out_dir / "out_frames"
    for d in [frames_dir, out_frames]:
        if d.exists(): shutil.rmtree(d)
        d.mkdir(parents=True)

    output_video = str(out_dir / f"{job_id}_result.mp4")

    # ── Download audio from URL if given ─────────────────────────────────────
    if audio_url and not audio_path:
        progress(5)
        log(f"STATUS:Downloading audio from URL...")
        dl_path = str(out_dir / "downloaded_audio.mp3")
        r = subprocess.run(
            ["yt-dlp", "-x", "--audio-format", "mp3", "-o", dl_path, audio_url],
            capture_output=True, text=True
        )
        if r.returncode == 0:
            audio_path = dl_path
        else:
            log(f"ERROR:Audio download failed: {r.stderr[:200]}")

    # ── Probe fps + dimensions ────────────────────────────────────────────────
    progress(10)
    log("STATUS:Extracting frames...")
    probe_fps = subprocess.run(
        ["ffprobe","-v","quiet","-select_streams","v:0",
         "-show_entries","stream=r_frame_rate","-of","csv=p=0", video_path],
        capture_output=True, text=True
    )
    num, den = probe_fps.stdout.strip().split("/")
    fps = float(num) / float(den)

    probe_dim = subprocess.run(
        ["ffprobe","-v","quiet","-select_streams","v:0",
         "-show_entries","stream=width,height","-of","csv=p=0", video_path],
        capture_output=True, text=True
    )
    try:
        dp = probe_dim.stdout.strip().split(",")
        vid_w, vid_h = int(dp[0]), int(dp[1])
    except Exception:
        vid_w, vid_h = 1080, 1920

    # ── Calculate HD scale (upscale to 1080p min, keep if already ≥ 1080p) ───
    is_portrait = vid_h >= vid_w
    scale_vf    = None
    scale_factor = 1.0

    if is_portrait and vid_h < 1920:
        tgt_h    = 1920
        tgt_w    = round(vid_w * tgt_h / vid_h / 2) * 2   # must be even
        scale_vf = f"scale={tgt_w}:{tgt_h}:flags=lanczos"
        scale_factor = tgt_h / vid_h
        log(f"STATUS:Upscaling {vid_w}×{vid_h} → {tgt_w}×{tgt_h} (HD 1080p)")
    elif not is_portrait and vid_w < 1920:
        tgt_w    = 1920
        tgt_h    = round(vid_h * tgt_w / vid_w / 2) * 2
        scale_vf = f"scale={tgt_w}:{tgt_h}:flags=lanczos"
        scale_factor = tgt_w / vid_w
        log(f"STATUS:Upscaling {vid_w}×{vid_h} → {tgt_w}×{tgt_h} (HD 1080p)")

    # Scale pixel-based style values proportionally so text looks the same size
    if scale_factor != 1.0:
        cfg = dict(cfg)
        cfg["font_size"]   = round(cfg.get("font_size",  28) * scale_factor)
        cfg["stroke"]      = max(1, round(cfg.get("stroke",   2) * scale_factor))
        cfg["shadow_blur"] = round(cfg.get("shadow_blur", 0) * scale_factor)

    # ── Video edit settings ───────────────────────────────────────────────────
    ve          = cfg.get("video_edit", {})
    trim_start  = float(ve.get("trim_start", 0))
    trim_end_v  = ve.get("trim_end", None)
    trim_end    = float(trim_end_v) if trim_end_v is not None else None
    speed       = max(0.25, float(ve.get("speed",    1.0)))
    volume      = float(ve.get("volume",   100)) / 100.0
    ve_bright   = float(ve.get("brightness", 0)) / 100.0
    ve_contrast = float(ve.get("contrast",   0)) / 50.0 + 1.0
    ve_sat      = float(ve.get("saturation", 100)) / 100.0
    flip_h      = bool(ve.get("flip_h", False))
    flip_v      = bool(ve.get("flip_v", False))

    # Video filter chain: color → speed → flip → HD scale
    vf_parts = []
    if abs(ve_bright) > 0.005 or abs(ve_contrast-1.0) > 0.01 or abs(ve_sat-1.0) > 0.01:
        vf_parts.append(f"eq=brightness={ve_bright:.3f}:contrast={ve_contrast:.3f}:saturation={ve_sat:.3f}")
    if speed != 1.0:
        vf_parts.append(f"setpts={1.0/speed:.4f}*PTS")
    if flip_h: vf_parts.append("hflip")
    if flip_v: vf_parts.append("vflip")
    if scale_vf: vf_parts.append(scale_vf)
    vf_str = ",".join(vf_parts) if vf_parts else None

    # Audio filter: speed (atempo) + volume
    af_parts = []
    if speed != 1.0:
        if 0.5 <= speed <= 2.0:
            af_parts.append(f"atempo={speed:.3f}")
        elif speed > 2.0:
            af_parts.append(f"atempo=2.0,atempo={speed/2:.3f}")
        else:  # < 0.5
            af_parts.append(f"atempo=0.5,atempo={speed*2:.3f}")
    if abs(volume - 1.0) > 0.01:
        af_parts.append(f"volume={volume:.3f}")
    af_str = ",".join(af_parts) if af_parts else None

    effective_fps = fps * speed   # framerate for encoder (achieves playback speed)

    # ── Extract frames ────────────────────────────────────────────────────────
    # Tell ffmpeg to interpret the source as BT.709 regardless of the metadata
    # written in the file.  Videos with color_space=unknown get decoded with the
    # wrong matrix on some builds (BT.601 instead of BT.709) which produces the
    # dark/reddish shift the user reported.  Input-side flags are universally
    # supported (no libzimg needed) and override the container metadata.
    extract_cmd = ["ffmpeg", "-y",
                   "-color_primaries", "bt709",
                   "-color_trc",       "bt709",
                   "-colorspace",      "bt709"]
    if trim_start > 0:
        extract_cmd += ["-ss", str(trim_start)]
    extract_cmd += ["-i", video_path]
    if trim_end is not None:
        extract_cmd += ["-t", str(max(0.1, trim_end - trim_start))]
    extract_cmd += ["-vsync", "0"]
    if vf_str:
        extract_cmd += ["-vf", vf_str]
    extract_cmd += [f"{frames_dir}/%06d.png"]
    subprocess.run(extract_cmd, capture_output=True, check=True)

    frames = sorted(frames_dir.glob("*.png"))
    n = len(frames)
    log(f"STATUS:Processing {n} frames at {fps:.1f} fps...")

    # ── Render frames ─────────────────────────────────────────────────────────
    progress(15)
    for i, fp in enumerate(frames):
        t   = trim_start + (int(fp.stem)-1) / fps   # account for trim offset in segment timestamps
        img = Image.open(fp).convert("RGB")
        img = render_frame(img, t, segments, cfg)
        img.save(out_frames / fp.name, "PNG")
        if (i+1) % max(1, n//20) == 0:
            pct = 15 + int(65 * (i+1)/n)
            progress(pct)

    # ── Encode ────────────────────────────────────────────────────────────────
    progress(80)
    log("STATUS:Encoding video...")
    cmd = [
        "ffmpeg","-y",
        "-framerate", str(effective_fps),
        "-i", f"{out_frames}/%06d.png",
    ]
    if audio_path:
        cmd += ["-i", audio_path]
    else:
        # Seek the original video audio to the trim point
        if trim_start > 0:
            cmd += ["-ss", str(trim_start)]
        cmd += ["-i", video_path]
        if trim_end is not None:
            cmd += ["-t", str(max(0.1, trim_end - trim_start))]

    cmd += ["-map","0:v","-map","1:a","-c:a","aac","-b:a","256k"]
    if af_str:
        cmd += ["-af", af_str]
    cmd += ["-shortest",
            "-c:v","libx264","-crf","15","-preset","medium",
            "-pix_fmt","yuv420p",
            "-colorspace","bt709","-color_primaries","bt709","-color_trc","bt709",
            "-movflags","+faststart", output_video]

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"ERROR:Encode failed: {r.stderr[-300:]}")
        sys.exit(1)

    progress(100)
    log(f"DONE:{output_video}")

if __name__ == "__main__":
    cfg = json.load(sys.stdin)
    process(cfg)
