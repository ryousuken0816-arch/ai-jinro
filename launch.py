"""PC の VOICEVOX の声をスマホで使えるようにする（起動.bat をダブルクリックすると、これが動く）

1. VOICEVOX が起動していなければ起動する
2. 声の中継（voice_relay.py）と、外からつなぐための cloudflared を起動する
3. スマホで読み取る QR コードを表示する（ゲームのページを開くと、声の場所と合言葉が自動で入る）

ゲーム本体はスマホのブラウザの中で動くので、PC を消していても遊べる（そのときはスマホの声になる）。
止めるときは、この窓で Ctrl+C か、窓を閉じる。
"""

import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV = HERE / ".env"
PORT = 8001


def read_env():
    values = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def set_env(key, value):
    text = ENV.read_text(encoding="utf-8") if ENV.exists() else ""
    text = re.sub(rf"^{key}=.*\n?", "", text, flags=re.M)
    if text and not text.endswith("\n"):
        text += "\n"
    ENV.write_text(text + f"{key}={value}\n", encoding="utf-8")


def voicevox_running():
    try:
        urllib.request.urlopen("http://127.0.0.1:50021/version", timeout=2).read()
        return True
    except Exception:
        return False


def start_voicevox(values):
    if voicevox_running():
        return True
    exe = values.get("VOICEVOX_PATH") or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "VOICEVOX" / "VOICEVOX.exe")
    if not Path(exe).exists():
        print(f"VOICEVOX が見つかりません（{exe}）。.env の VOICEVOX_PATH に場所を書いてください。")
        return False
    print("VOICEVOX を起動しています…")
    subprocess.Popen([exe], cwd=Path(exe).parent)
    for _ in range(90):
        if voicevox_running():
            return True
        time.sleep(1)
    print("VOICEVOX が起動しませんでした。")
    return False


def find_cloudflared():
    for path in [shutil.which("cloudflared"),
                 r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
                 r"C:\Program Files\cloudflared\cloudflared.exe"]:
        if path and Path(path).exists():
            return path
    return None


def show_qr(url):
    try:
        import qrcode
    except ImportError:
        print("（pip install qrcode を入れると、ここに QR コードが出ます）")
        return
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.print_ascii(invert=True)


def main():
    values = read_env()
    page = values.get("JINRO_PAGE_URL", "")
    if not page:
        print("JINRO_PAGE_URL（GitHub Pages のゲームのページ）が .env にありません。")
        return 1
    key = values.get("VOICE_KEY", "")
    if len(key) < 16:
        key = secrets.token_urlsafe(18)
        set_env("VOICE_KEY", key)
    cloudflared = find_cloudflared()
    if not cloudflared:
        print("cloudflared が見つかりません。winget install Cloudflare.cloudflared で入れてください。")
        return 1
    if not start_voicevox(values):
        return 1

    env = dict(os.environ, PYTHONIOENCODING="utf-8", VOICE_KEY=key)
    relay = subprocess.Popen([sys.executable, str(HERE / "voice_relay.py"), "--port", str(PORT)], cwd=HERE, env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    tunnel = subprocess.Popen([cloudflared, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{PORT}"],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")

    print("起動しています…（中継の URL が出るまで 10 秒ほどかかります）")
    url = None
    found = threading.Event()

    def watch_tunnel():
        nonlocal url
        for line in tunnel.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not url:
                url = m.group(0)
                found.set()

    threading.Thread(target=watch_tunnel, daemon=True).start()
    found.wait(60)

    try:
        if relay.poll() is not None:
            print("声の中継が起動できませんでした:")
            print(relay.stderr.read()[-1500:])
            return 1
        if not url:
            print("中継の URL を取得できませんでした。ネットにつながっているか確かめてください。")
            return 1
        time.sleep(2)  # 中継が通るまで少し待つ
        phone = f"{page}#voice={urllib.parse.quote(url, safe='')}&vkey={key}"
        print()
        print("=" * 60)
        print("  スマホのカメラでこの QR コードを読んでください")
        print("  （ゲームのページが開き、PC の VOICEVOX の声が使えるようになります）")
        print("=" * 60)
        show_qr(phone)
        print(f"ゲームのページ: {page}")
        print("PC を消しても遊べます（そのときはスマホの読み上げの声になります）。")
        print("止めるときは、この窓で Ctrl+C を押すか、窓を閉じてください。")
        while relay.poll() is None and tunnel.poll() is None:
            time.sleep(1)
        print("中継が止まりました。")
    except KeyboardInterrupt:
        print("\n止めています…")
    finally:
        for p in (tunnel, relay):
            if p.poll() is None:
                p.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
