// 声: 発言を 1 人ずつ順番に流す（読み上げ）と、あなたの声を文字にする（音声入力）
//
// 読み上げは 2 通り。PC の VOICEVOX につながればその声、つながらなければスマホの読み上げの声。
// VOICEVOX の場所（中継の URL と合言葉）は、PC の起動画面の QR から開くと自動で保存される。

const VV_KEY = "jinro.voicevox";
const SOUND_KEY = "jinro.sound";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function readJSON(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export class Voice {
  constructor() {
    this.sound = readJSON(SOUND_KEY, true);
    this.vv = readJSON(VV_KEY, null);       // { url, key }
    this.vvOk = false;
    this.speakers = [];                      // VOICEVOX のキャラ一覧
    this.queue = [];
    this.busy = false;
    this.waiters = [];
    this.audio = new Audio();
    this.onShow = () => {};                  // 出来事を画面に出すタイミングで呼ばれる
    this.onSpeaking = () => {};              // いま喋っている人（クレジット表示用）
  }

  setSound(on) { this.sound = on; writeJSON(SOUND_KEY, on); if (!on) this.cancel(); }
  setVoicevox(url, key) { this.vv = { url: url.replace(/\/$/, ""), key }; writeJSON(VV_KEY, this.vv); }

  async checkVoicevox() {
    this.vvOk = false;
    if (!this.vv) return false;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${this.vv.url}/speakers`, { headers: { "X-Voice-Key": this.vv.key }, signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      this.speakers = await r.json();
      this.vvOk = this.speakers.length > 0;
    } catch { this.vvOk = false; }
    return this.vvOk;
  }

  // スマホの読み上げで使える日本語の声
  deviceVoices() {
    if (!("speechSynthesis" in window)) return [];
    return speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
  }

  // 人ごとに声を決める。VOICEVOX の声と、スマホの声（高さ・速さ）の両方を持たせておき、
  // 途中で PC が切れてもスマホの声で続けられるようにする
  assign(players) {
    const chars = shuffle(this.speakers.slice());
    let i = 0;
    for (const p of players) {
      if (p.human || p.voice) continue;
      const c = chars[i % Math.max(chars.length, 1)];
      const style = c ? (c.styles.find((s) => s.name === "ノーマル") || c.styles[0]) : null;
      p.voice = {
        vv: style ? style.id : null, vvName: c ? c.name : "",
        dev: i, pitch: +(0.75 + Math.random() * 0.6).toFixed(2), rate: +(0.95 + Math.random() * 0.3).toFixed(2),
      };
      i++;
    }
  }

  // スマホでは、ボタンを押したときに一度音を鳴らしておかないと、あとで音が出せない
  unlock() {
    try {
      this.audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      this.audio.play().catch(() => {});
      if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    } catch {}
  }

  // --- 出来事の順番待ち

  enqueue(ev, player) {
    const item = { ev, player, audio: null };
    if (ev.type === "say" && player && !player.human && this.sound && this.vvOk && player.voice?.vv != null) {
      item.audio = this.fetchVoicevox(ev.text, player.voice.vv); // 先に作り始めておく
    }
    this.queue.push(item);
    this.pump();
  }

  queued() { return this.queue.length + (this.busy ? 1 : 0); }

  waitPresenter(max) {
    if (this.queued() <= max) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ max, resolve }));
  }

  notify() {
    this.waiters = this.waiters.filter((w) => { if (this.queued() <= w.max) { w.resolve(); return false; } return true; });
  }

  cancel() {
    try { this.audio.pause(); } catch {}
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (this.skip) this.skip();
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const item = this.queue.shift();
    this.onShow(item.ev);
    if (item.ev.type === "say" && item.player && !item.player.human) {
      this.onSpeaking(item.player, null);
      await this.present(item);
      this.onSpeaking(null, null);
    }
    this.busy = false;
    this.notify();
    this.pump();
  }

  async present(item) {
    const text = item.ev.text;
    // 「次へ」で飛ばせるようにする
    const skipped = new Promise((r) => { this.skip = r; });
    let speaking;
    if (!this.sound) {
      speaking = sleep(Math.min(1500 + text.length * 60, 7000));   // 音なし: 読む時間だけ待つ
    } else if (item.audio) {
      speaking = item.audio.then((url) => url ? this.playUrl(url, item.player) : this.speakDevice(text, item.player));
    } else {
      speaking = this.speakDevice(text, item.player);
    }
    await Promise.race([speaking, skipped]);
    this.skip = null;
  }

  async fetchVoicevox(text, speaker) {
    try {
      const r = await fetch(`${this.vv.url}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Voice-Key": this.vv.key },
        body: JSON.stringify({ text, speaker }),
      });
      if (!r.ok) throw new Error(String(r.status));
      return URL.createObjectURL(await r.blob());
    } catch {
      this.vvOk = false;  // PC が切れたら、以降はスマホの声に切り替える
      return null;
    }
  }

  playUrl(url, player) {
    this.onSpeaking(player, player.voice.vvName);
    return new Promise((resolve) => {
      const done = () => { URL.revokeObjectURL(url); resolve(); };
      this.audio.onended = done;
      this.audio.onerror = done;
      this.audio.src = url;
      this.audio.play().catch(done);
    });
  }

  speakDevice(text, player) {
    if (!("speechSynthesis" in window)) return sleep(Math.min(1500 + text.length * 60, 7000));
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      const voices = this.deviceVoices();
      const v = player.voice || { dev: player.seat, pitch: 1, rate: 1 };
      if (voices.length) u.voice = voices[v.dev % voices.length];
      u.pitch = v.pitch; u.rate = v.rate;
      // 端末によっては終わりの合図が来ないので、長さから見積もった時間でも打ち切る
      const timer = setTimeout(resolve, 2000 + text.length * 250);
      u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
      speechSynthesis.speak(u);
    });
  }
}

// --- 音声入力（ブラウザの機能を使う）

export function makeRecognizer(onText, onState) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = "ja-JP";
  r.interimResults = true;
  r.continuous = false;
  let active = false;
  r.onresult = (e) => {
    let t = "";
    for (const res of e.results) t += res[0].transcript;
    onText(t);
  };
  r.onend = () => { active = false; onState(false); };
  r.onerror = (e) => { active = false; onState(false, e.error); };
  return {
    toggle() {
      if (active) { r.stop(); return; }
      try { r.start(); active = true; onState(true); } catch { onState(false, "start"); }
    },
  };
}
