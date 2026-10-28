# README の端末の録画（docs/images/demo.gif）を作り直す。
#
#     pip install pyte pillow
#     TABISAKI_PLUGINS=0 python3 tools/record_demo.py . docs/images/demo.gif
#
# 実際に ./tabisaki plan と ./tabisaki tui を pty で動かし、pyte で端末の画面をまねて、
# PIL で1コマずつ描きます（録画用の道具や画面は要りません）。日付は「明日」なので、
# 撮るたびに曜日が変わります。--frames=<dir> を足すと、各コマを PNG でも書き出します。
# フォントは JetBrains Mono と IPA ゴシック（Debian/Ubuntu の fonts-jetbrains-mono・fonts-ipafont-gothic）。
import os, pty, select, sys, time
import pyte
from PIL import Image, ImageDraw, ImageFont

REPO = os.path.abspath(sys.argv[1]); OUT = sys.argv[2]
FRAMES = next((a.split('=', 1)[1] for a in sys.argv[3:] if a.startswith('--frames=')), None)
COLS, ROWS = 84, 26
CW, CH = 11, 24
PAD = 18; BAR = 30
F_ASCII = ImageFont.truetype("/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf", 17)
F_ASCII_B = ImageFont.truetype("/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Bold.ttf", 17)
F_WIDE = ImageFont.truetype("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", 21)
BG = (30, 32, 38); FG = (220, 223, 228)
PAL = {"black": (60, 63, 70), "red": (236, 95, 103), "green": (153, 199, 148), "brown": (250, 200, 99),
       "yellow": (250, 200, 99), "blue": (102, 153, 204), "magenta": (197, 148, 197), "cyan": (95, 179, 179),
       "white": (220, 223, 228), "brightblack": (120, 124, 132), "brightred": (246, 120, 128),
       "brightgreen": (170, 215, 165), "brightyellow": (255, 215, 120), "brightblue": (130, 175, 225),
       "brightmagenta": (215, 170, 215), "brightcyan": (120, 200, 200), "brightwhite": (255, 255, 255)}

def col(c, default):
    if c == "default": return default
    if c in PAL: return PAL[c]
    if len(c) == 6:
        try: return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))
        except ValueError: pass
    return default

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
frames = []

def snap(ms, cursor=True):
    W = PAD * 2 + COLS * CW; H = BAR + PAD * 2 + ROWS * CH
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, BAR], fill=(44, 47, 54))
    for i, c in enumerate([(236, 95, 103), (250, 200, 99), (153, 199, 148)]):
        d.ellipse([14 + i * 20, 10, 26 + i * 20, 22], fill=c)
    d.text((W // 2, BAR // 2), "tabisaki — ssh", fill=(150, 154, 162), font=F_ASCII, anchor="mm")
    for y in range(ROWS):
        line = screen.buffer[y]; x = 0
        while x < COLS:
            ch = line[x]; data = ch.data
            wide = data and (x + 1 < COLS) and line[x + 1].data == ""
            fg = col(ch.fg, FG); bg = col(ch.bg, BG)
            if ch.bold and ch.fg in PAL and not ch.fg.startswith("bright"): fg = PAL.get("bright" + ch.fg, fg)
            if ch.reverse: fg, bg = (bg if bg != BG else BG), (fg)
            px = PAD + x * CW; py = BAR + PAD + y * CH
            w = CW * (2 if wide else 1)
            if bg != BG: d.rectangle([px, py, px + w - 1, py + CH - 1], fill=bg)
            if data and data != " ":
                if wide:
                    d.text((px + w / 2, py + CH / 2 + 1), data, fill=fg, font=F_WIDE, anchor="mm")
                else:
                    d.text((px, py + 2), data, fill=fg, font=F_ASCII_B if ch.bold else F_ASCII)
            x += 2 if wide else 1
    if cursor and not screen.cursor.hidden:
        px = PAD + screen.cursor.x * CW; py = BAR + PAD + screen.cursor.y * CH
        d.rectangle([px, py + 2, px + CW - 2, py + CH - 2], fill=(200, 200, 200))
    frames.append((im, ms))

def prompt():
    stream.feed("\x1b[32m~/tabisaki-app\x1b[0m $ ".encode())

def type_cmd(cmd):
    for i, ch in enumerate(cmd):
        stream.feed(ch.encode())
        if i % 2 == 1 or i == len(cmd) - 1: snap(55)
    snap(500)
    stream.feed(b"\r\n")

def run(args, keys=(), line_ms=70, settle=1.6):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        os.environ.update(TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS), LANG="C.UTF-8")
        os.execvp(args[0], args)
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    def pump(timeout, per_line=None):
        end = time.time() + timeout; buf = b""; done = False
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r: continue
            try: data = os.read(fd, 65536)
            except OSError: data = b""
            if not data:
                done = True; break
            buf += data
            end = time.time() + 0.4
        if per_line and buf:
            for ln in buf.split(b"\n"):
                stream.feed(ln + b"\n"); snap(per_line, cursor=False)
        else:
            stream.feed(buf)
        return not done
    pump(settle * 3 if not keys else settle * 2, per_line=line_ms if not keys else None)
    if keys:
        snap(1400, cursor=False)
        for k, ms in keys:
            os.write(fd, k.encode()); pump(0.6); snap(ms, cursor=False)
    try:
        while pump(0.5): pass
    except Exception: pass
    os.waitpid(pid, 0)

wish = "鎌倉でお寺と海を歩いて回りたい"
prompt(); snap(700)
type_cmd(f'./tabisaki plan "{wish}" --output=text')
run([f"{REPO}/tabisaki", "plan", wish, "--output=text"], line_ms=90)
prompt(); snap(2600)
stream.feed(b"\x1b[2J\x1b[H"); prompt(); snap(400)
type_cmd(f'./tabisaki tui "{wish}" --days=2')
run([f"{REPO}/tabisaki", "tui", wish, "--days=2"],
    keys=[("j", 500), ("j", 900), ("\r", 2400), ("\r", 600), ("l", 1500), ("j", 450), ("j", 1200), ("q", 300)])
stream.feed(b"\x1b[2J\x1b[H"); prompt(); snap(1200)

# 同じ画の続きはまとめる
merged = []
for im, ms in frames:
    if merged and merged[-1][0].tobytes() == im.tobytes(): merged[-1] = (merged[-1][0], merged[-1][1] + ms)
    else: merged.append((im, ms))
scale = 0.8
ims = [im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS) for im, _ in merged]
pal = ims[len(ims) // 2].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in ims]
q[0].save(OUT, save_all=True, append_images=q[1:], duration=[ms for _, ms in merged], loop=0, optimize=True, disposal=1)
if FRAMES:
    os.makedirs(FRAMES, exist_ok=True)
    for i, im in enumerate(ims): im.save(os.path.join(FRAMES, f"f{i:02d}.png"))
print(len(merged), "frames", os.path.getsize(OUT), "bytes")
