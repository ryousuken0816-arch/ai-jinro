// 声: 発言を 1 人ずつ順番に流す（読み上げ）と、あなたの声を文字にする（音声入力）
//
// 読み上げは 2 通り。PC の VOICEVOX につながればその声、つながらなければスマホの読み上げの声。
// VOICEVOX の場所（中継の URL と合言葉）は、PC の起動画面の QR から開くと自動で保存される。

const VV_KEY = "jinro.voicevox";
const SOUND_KEY = "jinro.sound";
const GAP_KEY = "jinro.gap";
export const GAPS = { "短め": 800, "普通": 2000, "長め": 4000 };   // 発言と発言のあいだの間（ミリ秒）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function readJSON(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export class Voice {
  constructor() {
    this.sound = readJSON(SOUND_KEY, true);
    this.gap = readJSON(GAP_KEY, "普通");
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
  setGap(name) { if (GAPS[name]) { this.gap = name; writeJSON(GAP_KEY, name); } }
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
        // 速すぎると聞き取れないので、速さは 0.9〜1.1 倍に抑える（声の違いは主に高さで出す）
        dev: i, pitch: +(0.75 + Math.random() * 0.6).toFixed(2), rate: +(0.9 + Math.random() * 0.2).toFixed(2),
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
    if ((ev.type === "say" || ev.type === "wolf") && player && !player.human && this.sound && this.vvOk && player.voice?.vv != null) {
      // 1 文ずつ、先に作り始めておく（長い発言でも話し始めが早く、途中で切れにくい）
      item.audio = Voice.chunks(ev.text).map((t) => ({ text: t, url: this.fetchVoicevox(t, player.voice.vv) }));
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

  stopAudio() {
    this.speakToken = (this.speakToken || 0) + 1;   // 1 文ずつ読んでいる途中なら、残りも読まない
    try { this.audio.pause(); } catch {}
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  cancel() {
    this.stopAudio();
    if (this.skip) this.skip();
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const item = this.queue.shift();
    this.onShow(item.ev);
    if ((item.ev.type === "say" || item.ev.type === "wolf") && item.player && !item.player.human) {
      this.onSpeaking(item.player, null);
      await this.present(item);
      this.onSpeaking(null, null);
      // 次の人が話し出す前に間をあけて、いまの発言を頭の中で整理できるようにする
      await Promise.race([sleep(GAPS[this.gap] ?? 2000), new Promise((r) => { this.skip = r; })]);
      this.skip = null;
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
      speaking = sleep(Math.min(2000 + text.length * 90, 12000));  // 音なし: 読む時間だけ待つ
    } else if (item.audio) {
      speaking = this.playVoicevox(item.audio, text, item.player);
    } else {
      speaking = this.speakDevice(text, item.player);
    }
    // 持ち時間（最大 90 秒）を過ぎたら読み上げを止めて次の人へ。読み上げの速さの差で切れないよう少し余裕をみる。
    // 喋り終わったら必ず見張りを解除する（解除し忘れると、あとの人の声を途中で止めてしまう）
    let limitTimer;
    const limit = new Promise((r) => { limitTimer = setTimeout(() => { this.stopAudio(); r(); }, 100_000); });
    await Promise.race([speaking, skipped, limit]);
    clearTimeout(limitTimer);
    this.skip = null;
  }

  // 1 文ずつ（短い文はまとめて max 字くらいずつ）に分ける。
  // 「。」のない長い文は読点「、」のところでも分ける（長いかたまりは読み上げが途中で止まることがあるため）
  static chunks(text, max = 100) {
    const sentences = (text.match(/[^。！？!?\n]+[。！？!?\n]*/g) || [text]).map((x) => x.trim()).filter(Boolean);
    const pieces = [];
    for (const s of sentences) {
      if (s.length <= max) { pieces.push(s); continue; }
      let cur = "";
      for (const c of s.match(/[^、，,]+[、，,]*/g) || [s]) {
        if (cur && (cur + c).length > max) { pieces.push(cur); cur = ""; }
        cur += c;
        while (cur.length > max) { pieces.push(cur.slice(0, max)); cur = cur.slice(max); }
      }
      if (cur) pieces.push(cur);
    }
    const out = [];
    for (const p of pieces) {
      if (out.length && (out[out.length - 1] + p).length <= max) out[out.length - 1] += p;
      else out.push(p);
    }
    return out.length ? out : [text];
  }

  // VOICEVOX の声を 1 かたまりずつ順に流す。作れなかったかたまりはスマホの声で読む
  async playVoicevox(jobs, text, player) {
    const token = (this.speakToken = (this.speakToken || 0) + 1);
    for (const job of jobs) {
      if (token !== this.speakToken) return;    // 飛ばされた
      const url = await job.url;
      if (token !== this.speakToken) { if (url) URL.revokeObjectURL(url); return; }
      if (url) await this.playUrl(url, player);
      else await this.speakOne(job.text, player);
    }
  }

  async fetchVoicevox(text, speaker) {
    try {
      const r = await fetch(`${this.vv.url}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Voice-Key": this.vv.key },
        body: JSON.stringify({ text, speaker }),
      });
      if (!r.ok) throw new Error(String(r.status));
      this.vvFails = 0;
      return URL.createObjectURL(await r.blob());
    } catch {
      // 1 回の失敗ではあきらめず、3 回続いたら PC が切れたとみなしてスマホの声に切り替える
      this.vvFails = (this.vvFails || 0) + 1;
      if (this.vvFails >= 3) { this.vvOk = false; this.onStatus?.("PC の声につながらないので、スマホの声に切り替えました"); }
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

  // スマホの読み上げは、長い文を一度に読ませると途中で止まることがある（ブラウザの既知の不具合）。
  // 1 文ずつに分けて順に読む
  async speakDevice(text, player) {
    if (!("speechSynthesis" in window)) return sleep(Math.min(2000 + text.length * 90, 12000));
    const parts = Voice.chunks(text, 50);
    const token = (this.speakToken = (this.speakToken || 0) + 1);
    for (const part of parts) {
      if (token !== this.speakToken) return;    // 飛ばされた
      await this.speakOne(part.trim(), player);
    }
  }

  speakOne(text, player) {
    if (!text) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      const voices = this.deviceVoices();
      const v = player.voice || { dev: player.seat, pitch: 1, rate: 1 };
      if (voices.length) u.voice = voices[v.dev % voices.length];
      u.pitch = v.pitch; u.rate = v.rate;
      // 端末によっては終わりの合図が来ないので、長さから見積もった時間でも次へ進む
      const timer = setTimeout(resolve, 3000 + text.length * 300);
      u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
      speechSynthesis.speak(u);
    });
  }
}

// --- 音声入力（ブラウザの機能を使う）

// 自分の番のあいだ聞き取り続ける。onText(ここまでの文字) が話している最中に何度も呼ばれる。
// 途中で区切れても（息継ぎなど）自動で聞き直し、それまでの文字に足していく。
export function makeRecognizer(onText, onState) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = "ja-JP";
  r.interimResults = true;
  r.continuous = true;
  let wanted = false;     // 聞き取りを続けたいか
  let running = false;    // ブラウザの聞き取りが動いているか
  let done = "";          // 前の区切りまでに確定した文字
  let current = "";       // いまの区切りの文字
  let finishing = null;   // finish() の結果を待っている人
  const text = () => done + current;

  r.onresult = (e) => {
    current = "";
    for (const res of e.results) current += res[0].transcript;
    onText(text());
  };
  r.onend = () => {
    running = false;
    done = text(); current = "";
    if (finishing) { const f = finishing; finishing = null; wanted = false; onState(false); f(done); return; }
    if (wanted) { try { r.start(); running = true; return; } catch {} }
    wanted = false;
    onState(false);
  };
  r.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;   // 黙っていただけ。onend で聞き直す
    wanted = false;
    onState(false, e.error);
  };
  return {
    active: () => wanted,
    // 聞き取りを始める。prefix はそれまでに入力欄にあった文字（続きから話すとき）。始められなければ false
    start(prefix = "") {
      done = prefix; current = ""; wanted = true;
      try { if (!running) { r.start(); running = true; } onState(true); return true; }
      catch { wanted = false; onState(false); return false; }
    },
    // 一時停止（それまでの文字は入力欄に残る）
    pause() { wanted = false; if (running) r.stop(); onState(false); },
    // 発言を締める: 聞き取りを止めて、最後までの文字を返す
    finish() {
      if (!running) { wanted = false; onState(false); return Promise.resolve(text()); }
      return new Promise((resolve) => { finishing = resolve; wanted = false; r.stop(); setTimeout(() => { if (finishing) { finishing = null; resolve(text()); } }, 1500); });
    },
  };
}

// --- 音声入力の誤変換を、決まった直し方で直す（数字・席番号・人狼の用語）

const KANJI_NUM = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const READ_NUM = { "いち": 1, "に": 2, "さん": 3, "よん": 4, "ご": 5, "ろく": 6, "なな": 7, "はち": 8, "きゅう": 9 };
const TERMS = [
  [/シーオー|しーおー|シーオウ|C\s*O|ｃｏ|ＣＯ/gi, "CO"],
  [/占い[しし氏市死]|うらないし|裏内し/g, "占い師"],
  [/霊媒[しし氏市死]|れいばいし|霊倍し/g, "霊媒師"],
  [/人郎|陣狼|人老|じんろう/g, "人狼"],
  [/凶人|強人|きょうじん/g, "狂人"],
  [/棋士|きし(?=[がはをにのもC])/g, "騎士"],
  [/グレーラン|ぐれらん/g, "グレラン"],
  [/ローラ(?!ー)/g, "ローラー"],
];

export function normalizeSpeech(text) {
  let t = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 「三番」「さんばん」「3版」「3晩」→「3番」
  t = t.replace(/([一二三四五六七八九])\s*(?:番|版|晩|盤|バン|ばん)/g, (_, k) => `${KANJI_NUM[k]}番`);
  t = t.replace(/(いち|さん|よん|ろく|なな|はち|きゅう)ばん/g, (_, r) => `${READ_NUM[r]}番`);
  t = t.replace(/([1-9])\s*(?:版|晩|盤|バン|ばん)/g, "$1番");
  for (const [re, to] of TERMS) t = t.replace(re, to);
  return t;
}
