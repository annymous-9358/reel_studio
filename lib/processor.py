#!/usr/bin/env python3
"""
Reel Studio — video processor.
Called by Next.js API with a JSON config on stdin.
Outputs progress lines: PROGRESS:0-100 and DONE:<output_path>
"""
import sys, json, os, shutil, math, subprocess, tempfile, ssl
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ssl._create_default_https_context = ssl._create_unverified_context

def _find_impact():
    candidates = [
        Path(__file__).parent / "fonts/Impact.ttf",          # bundled (preferred)
        Path("/System/Library/Fonts/Supplemental/Impact.ttf"), # macOS
        Path("/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"), # Linux/Render
        Path("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return str(Path(__file__).parent / "fonts/Poppins-Regular.ttf")  # fallback

_IMPACT = _find_impact()

FONTS = {
    "great_vibes": str(Path(__file__).parent / "fonts/GreatVibes.ttf"),
    "poppins":     str(Path(__file__).parent / "fonts/Poppins-Light.ttf"),
    "impact":      _IMPACT,
}
FONT_CURRENT_MAP = {
    "great_vibes": str(Path(__file__).parent / "fonts/GreatVibes.ttf"),
    "poppins":     str(Path(__file__).parent / "fonts/Poppins-Regular.ttf"),
    "impact":      _IMPACT,
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

def draw_text_styled(draw, xy, text, font, color, stroke_px):
    x, y = xy
    if stroke_px > 0:
        sc = (0,0,0,int(255*0.6))
        for ox,oy in [(2,2),(1,2),(2,1),(3,3)]:
            draw.text((x+ox, y+oy), text, font=font, fill=sc)
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
    font_key  = cfg.get("font", "great_vibes")
    font_size = cfg.get("font_size", 28)
    position  = cfg.get("position", "center")   # top/center/bottom
    color_hex = cfg.get("color", "#ffffff")
    animation = cfg.get("animation", "word_by_word")  # word_by_word/fade/none
    stroke_px = cfg.get("stroke", 2)
    bounce_dur= 0.12

    font_path  = FONTS.get(font_key, FONTS["great_vibes"])
    font_path_c= FONT_CURRENT_MAP.get(font_key, font_path)
    font_n = get_font(font_path,   font_size)
    font_c = get_font(font_path_c, int(font_size * 1.12))

    # Parse color
    h = color_hex.lstrip("#")
    color = tuple(int(h[i:i+2],16) for i in (0,2,4)) + (255,)

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

    if position == "top":
        block_y = int(H * 0.05)
    elif position == "bottom":
        block_y = H - block_h - int(H * 0.07)
    else:  # center
        block_y = H//2 - block_h//2

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
        x = max(MARGIN, (W-vis_w)//2)

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
                draw_text_styled(td,(6,6),word,font,word_color,stroke_px)
                tmp=tmp.resize((sw,sh),Image.LANCZOS)
                img.paste(tmp,(x+(ww_n-sw)//2,y+(fh-sh)//2),tmp)
            else:
                draw_text_styled(draw,(x,y),word,font,word_color,stroke_px)
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

    # ── Extract frames ────────────────────────────────────────────────────────
    progress(10)
    log("STATUS:Extracting frames...")
    probe = subprocess.run(
        ["ffprobe","-v","quiet","-select_streams","v:0",
         "-show_entries","stream=r_frame_rate","-of","csv=p=0", video_path],
        capture_output=True, text=True
    )
    num,den = probe.stdout.strip().split("/")
    fps = float(num)/float(den)

    subprocess.run(
        ["ffmpeg","-y","-i",video_path,"-vsync","0",f"{frames_dir}/%06d.png"],
        capture_output=True, check=True
    )
    frames = sorted(frames_dir.glob("*.png"))
    n = len(frames)
    log(f"STATUS:Processing {n} frames at {fps:.1f} fps...")

    # ── Render frames ─────────────────────────────────────────────────────────
    progress(15)
    for i, fp in enumerate(frames):
        t   = (int(fp.stem)-1) / fps
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
        "-framerate", str(fps),
        "-i", f"{out_frames}/%06d.png",
    ]
    if audio_path:
        cmd += ["-i", audio_path, "-map","0:v","-map","1:a",
                "-c:a","aac","-b:a","192k","-shortest"]
    else:
        cmd += ["-i", video_path, "-map","0:v","-map","1:a",
                "-c:a","aac","-b:a","192k","-shortest"]
    cmd += ["-c:v","libx264","-crf","17","-preset","fast",
            "-pix_fmt","yuv420p", output_video]

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"ERROR:Encode failed: {r.stderr[-300:]}")
        sys.exit(1)

    progress(100)
    log(f"DONE:{output_video}")

if __name__ == "__main__":
    cfg = json.load(sys.stdin)
    process(cfg)
