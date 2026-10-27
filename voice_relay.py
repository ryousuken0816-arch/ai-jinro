"""VOICEVOX の声をスマホに渡す中継

スマホのゲームから「この文をこの声で」と頼まれたら、PC の VOICEVOX で声を作って返す。
合言葉（.env の VOICE_KEY）を知っているスマホからだけ受け付ける。
ふつうは launch.py（起動.bat）が自動で起動するので、直接動かす必要はない。
"""

import argparse
import hmac
import json
import os
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VOICEVOX = "http://127.0.0.1:50021"
KEY = ""


def vv(path, data=None, headers=None):
    req = urllib.request.Request(VOICEVOX + path, data=data, headers=headers or {}, method="POST" if data is not None or "?" in path else "GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Voice-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def reply(self, status, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        return hmac.compare_digest(self.headers.get("X-Voice-Key", "").encode(), KEY.encode())

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self):
        if not self.authed():
            return self.reply(401, "合言葉が違います".encode())
        if self.path == "/speakers":
            try:
                return self.reply(200, vv("/speakers"), "application/json; charset=utf-8")
            except Exception as e:
                return self.reply(502, f"VOICEVOX につながりません: {e}".encode())
        self.reply(404)

    def do_POST(self):
        if not self.authed():
            return self.reply(401, "合言葉が違います".encode())
        if self.path != "/tts":
            return self.reply(404)
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 20_000)
            data = json.loads(self.rfile.read(length) or b"{}")
            text = str(data.get("text", ""))[:400]
            speaker = int(data.get("speaker", 3))
            query = vv("/audio_query?" + urllib.parse.urlencode({"text": text, "speaker": speaker}))
            wav = vv(f"/synthesis?speaker={speaker}", data=query, headers={"Content-Type": "application/json"})
            self.reply(200, wav, "audio/wav")
        except Exception as e:
            self.reply(502, f"声を作れませんでした: {e}".encode())


def main():
    global KEY
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8001)
    args = ap.parse_args()
    KEY = os.environ.get("VOICE_KEY", "")
    if len(KEY) < 16:
        raise SystemExit("VOICE_KEY（16 文字以上）が必要です。起動.bat から起動してください。")
    try:
        Server(("127.0.0.1", args.port), Handler).serve_forever()
    except OSError:
        raise SystemExit(f"{args.port} 番がほかのプログラムに使われています。前に開いた起動.bat の窓を閉じてから、もう一度起動してください。")


class Server(ThreadingHTTPServer):
    # Windows では同じ番号を複数のプログラムで取り合えてしまい、古い中継に頼みが届くことがある。それを防ぐ
    allow_reuse_address = False


if __name__ == "__main__":
    main()
