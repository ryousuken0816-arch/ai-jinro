// 人狼ゲームの進行（ブラウザ版）
//
// ルール
// - 9 人村: 人狼2・狂人1・占い師・霊媒師・騎士・村人3
// - 初日は占い師に「お告げ」（人狼ではない人を 1 人）。初日の夜の襲撃はない（1日目の昼のあと、最初の夜から襲撃）
// - 騎士は自分を守れず、2 晩続けて同じ人も守れない
// - 同票なら同票の人だけで決選投票。それでも同票ならくじ
// - 昼は席の順に 2 周発言（トップバッターは毎日ずれる）
//
// 進み具合（state）は 1 手ごとにブラウザに保存するので、ページを閉じても続きから再開できる。

import { randomCast } from "./people.js?v=2026-10-27h";

export const MODEL = "claude-opus-5-5";
const EFFORT = "medium";
const SDK_URL = "https://esm.sh/@anthropic-ai/sdk@1.3.0";
const SAVE_KEY = "jinro.save.v1";

export const ROLES = {
  "村人": ["村人陣営", "特別な能力はない。話し合いで人狼を見つけて処刑しよう。"],
  "占い師": ["村人陣営", "毎晩 1 人を占い、人狼かどうかを知る。"],
  "霊媒師": ["村人陣営", "処刑された人が人狼だったかどうかを、その夜に知る。"],
  "騎士": ["村人陣営", "毎晩 1 人（自分以外・2 晩続けて同じ人は不可）を人狼の襲撃から守る。"],
  "人狼": ["人狼陣営", "仲間の人狼を知っている。毎晩 1 人を襲撃する。正体を隠して村人のふりをする。"],
  "狂人": ["人狼陣営", "人間だが人狼の味方。人狼が誰かは知らない。占いでは人狼ではないと出る。村を混乱させよう。"],
};
export const SETUP = ["人狼", "人狼", "狂人", "占い師", "霊媒師", "騎士", "村人", "村人", "村人"];
const CO_ROLES = ["占い師", "霊媒師", "騎士", "村人"];
const ROUNDS = 2;
// 1 回の発言時間の上限（1 周目 60 秒・2 周目 90 秒・遺言 45 秒）と、その時間で読み上げられる字数の目安
export const ROUND_SECONDS = [60, 90];
export const LASTWORD_SECONDS = 45;
const charsFor = (sec) => Math.round(sec * 4.2);

// 長すぎる発言は、上限の字数までの最後の句点で切る（少し超えたくらいなら切らない）
function clip(text, max) {
  if ([...text].length <= max * 1.4) return text;
  max = Math.round(max * 1.4);
  const head = [...text].slice(0, max).join("");
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  return cut > max * 0.5 ? head.slice(0, cut + 1) : head + "…";
}

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const label = (p) => `${p.seat}番${p.name}`;
const isWolf = (p) => p.role === "人狼";
export const teamOf = (role) => ROLES[role][0];

// ================================================================ AI

export class ClaudeBrain {
  constructor(apiKey) { this.apiKey = apiKey; this.client = null; }

  async ask(system, user) {
    if (!this.client) {
      const { default: Anthropic } = await import(SDK_URL);
      this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 6 });
    }
    // 安全分類器で断られたときは、別モデルで自動的にやり直す（server-side fallback）
    // 考える量（medium）に出力の上限を使い切られて発言が途中で切れないよう、上限は大きめにとる
    const r = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (r.stop_reason === "refusal") return "";
    return r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  // 音声入力の誤変換直しのような、すぐ返してほしい短い頼みごと（考える量を少なくする）
  async quick(system, user) {
    if (!this.client) {
      const { default: Anthropic } = await import(SDK_URL);
      this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 6 });
    }
    const r = await this.client.beta.messages.create({
      model: MODEL, max_tokens: 2000, system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (r.stop_reason === "refusal") return "";
    return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  }
}

// 音声入力の文字を、参加者の名前と人狼の用語を踏まえて直してもらう
export async function fixTranscript(brain, text, players) {
  if (!brain.quick) return text;
  const names = players.map((p) => `${p.seat}番 ${p.name}`).join("、");
  const system = `あなたは人狼ゲームの音声入力の誤変換を直す係です。
参加者: ${names}
よく出る言葉: CO、占い師、霊媒師、騎士、村人、人狼、狂人、白、黒、グレー、グレラン、ローラー、吊り、噛み、縄、真、偽、確白、潜伏、対抗、指定、ラン、精査、矢印、エンドポジ、トップバッター
ルール:
- 聞き間違い・変換ミスと思われるところだけを直す（例:「参版」→「3番」、「占いし」→「占い師」、名前の聞き間違い）
- 言い回しや内容、話し言葉の口調は変えない。足したり要約したりしない
- 直した文だけを返す。説明や引用符は付けない`;
  const out = await brain.quick(system, text);
  // 直した結果が元と大きく違うときは、勝手に書き換えたとみなして元のまま使う
  return out && out.length <= text.length * 1.5 + 10 ? out : text;
}

export class MockBrain {
  // API を使わないダミー。流れの確認用
  static LINES = ["まだ情報が少ないね。", "さっきの発言が少し引っかかった。", "私は村人だよ。", "投票先は話を聞いてから決める。",
    "あの人の意見に賛成。", "占い師はちゃんと結果を出してほしい。"];

  async ask(system, user) {
    await new Promise((r) => setTimeout(r, 150));
    if (user.includes("【選べる相手】")) {
      const names = [...user.split("【選べる相手】").pop().matchAll(/^- (.+)$/gm)].map((m) => m[1]);
      return `考え: なんとなく。\n答え: ${pick(names)}`;
    }
    const co = pick(["なし", "なし", "なし", "なし", "なし", "占い師", "霊媒師", "騎士"]);
    return `考え: 様子見。\nCO: ${co}\n報告: なし\n要点: ${pick(["3番が怪しい", "占い真は2番", "今日は5・7ラン", "まだ様子見"])}\n発言: ${pick(MockBrain.LINES)}`;
  }
}

function parseFields(text) {
  // 「考え: … / CO: … / 報告: … / 発言: … / 答え: …」を取り出す
  const parts = text.split(/^(考え|CO|報告|要点|発言|答え)[:：]/m);
  const d = {};
  for (let i = 1; i < parts.length - 1; i += 2) d[parts[i]] = parts[i + 1].trim();
  return d;
}

// ================================================================ ゲーム

export function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch { return null; }
}
export function clearSaved() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
}

export function newState({ watch, humanName, role }) {
  const cast = randomCast(watch ? 9 : 8);
  let name = (humanName || "あなた").slice(0, 10);
  while (cast.some((c) => c.name === name)) name += "2";
  const entries = cast.map((c) => ({ name: c.name, persona: c, human: false }));
  if (!watch) entries.push({ name, persona: null, human: true });
  shuffle(entries);
  const roles = shuffle(SETUP.slice());
  // あなたが役職を選んだときは、その役職をあなたの席に回す
  if (role && !watch && SETUP.includes(role)) {
    const hi = entries.findIndex((e) => e.human), ri = roles.indexOf(role);
    [roles[hi], roles[ri]] = [roles[ri], roles[hi]];
  }
  const players = entries.map((e, i) => ({
    seat: i + 1, name: e.name, persona: e.persona, human: e.human, role: roles[i],
    alive: true, co: "", secrets: [], thoughts: [], voice: null,
    known: {},   // 占い・霊媒で分かった結果（席番号 → 白 / 黒）。画面で名前の色を変えるのに使う
  }));
  const wolves = players.filter(isWolf);
  for (const w of wolves) w.secrets.push("仲間の人狼: " + wolves.filter((x) => x !== w).map(label).join("、"));
  for (const seer of players.filter((p) => p.role === "占い師")) {
    const w = pick(players.filter((p) => p !== seer && !isWolf(p)));
    seer.secrets.push(`お告げ: ${label(w)} は人狼ではない`);
    seer.known[w.seat] = "白";
  }
  // 観戦のときは、誰か 1 人の視点で見る（選んだ役職の人、なければランダム）
  let viewSeat = null;
  if (watch) {
    const cands = role ? players.filter((p) => p.role === role) : players;
    viewSeat = pick(cands.length ? cands : players).seat;
  }
  return {
    id: Date.now(), watch, viewSeat, players, day: 1, phase: "night", events: [], reports: [], executed: [], attacked: [],
    lastGuard: null, over: false, winner: null, speaking: null, pending: null,
    topSeat: 1 + Math.floor(Math.random() * players.length),   // 1 日目のトップバッターはランダム
    cursor: { stage: "start" },
  };
}

export class Game {
  // ui は { onEvent(ev), update(), waitPresenter(maxQueued) } を持つ
  constructor(state, brain, theory, ui) {
    this.S = state;
    this.brain = brain;
    this.theory = theory;
    this.ui = ui;
    this.stopped = false;
    this.resolveHuman = null;
    this.S.pending = null;
  }

  // --- 基本

  bySeat(seat) { return this.S.players[seat - 1]; }
  human() { return this.S.players.find((p) => p.human) || null; }
  alive(exclude) { return this.S.players.filter((p) => p.alive && p !== exclude); }
  save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.S)); } catch {} }
  stop() { this.stopped = true; if (this.resolveHuman) this.resolveHuman(null); }

  emit(type, { text = "", seat = null, line = "", priv = false, summary = "", aud = "" } = {}) {
    const ev = { id: this.S.events.length + 1, type, day: this.S.day, text, seat,
      name: seat ? this.bySeat(seat).name : "", private: priv, line, summary, aud };
    this.S.events.push(ev);
    this.ui.onEvent(ev);
    return ev;
  }

  setPhase(phase, text) {
    this.S.phase = phase;
    if (text) this.emit("phase", { text, line: text });
    this.ui.update();
  }

  // --- 人間とのやりとり

  // seconds は発言の持ち時間（speak のときだけ）
  waitHuman(kind, prompt, options = [], seconds = 0) {
    this.S.pending = { kind, prompt, options, seconds };
    this.ui.update();
    return new Promise((resolve) => { this.resolveHuman = resolve; });
  }

  // elapsed は発言にかかった秒数（早く切り上げたことを AI にも伝えるため）
  submit(value, elapsed = null) {
    const p = this.S.pending;
    if (!p || !this.resolveHuman) return false;
    if (p.kind === "speak" || p.kind === "wolfchat") {
      value = String(value ?? "").trim().slice(0, 600);
      this.lastElapsed = elapsed;
    } else if (!p.options.includes(value)) return false;
    this.S.pending = null;
    const r = this.resolveHuman; this.resolveHuman = null;
    r(value);
    this.ui.update();
    return true;
  }

  declareCo(seat, role) {
    const p = this.bySeat(seat);
    if (!p.alive || !CO_ROLES.includes(role) || p.co === role) return false;
    p.co = role;
    this.emit("co", { text: `${role} CO`, seat, line: `${this.S.day}日目 ${label(p)} が${role} CO` });
    this.ui.update();
    this.save();
    return true;
  }

  declareReport(seat, targetSeat, result) {
    const p = this.bySeat(seat), t = this.bySeat(targetSeat);
    if (!["白", "黒"].includes(result) || !p.alive || !t) return false;
    const kind = p.co === "霊媒師" ? "霊媒" : "占い";
    this.S.reports.push([this.S.day, label(p), kind, label(t), result]);
    this.emit("report", { text: `${t.name} は${result}（${kind}結果）`, seat, line: `${this.S.day}日目 ${label(p)} の${kind}報告: ${label(t)} は${result}` });
    this.ui.update();
    this.save();
    return true;
  }

  // --- AI への入力

  commonPrompt() {
    // 全員に同じ部分（キャッシュが効くよう前に置く）
    const counts = {};
    for (const r of SETUP) counts[r] = (counts[r] || 0) + 1;
    const roster = Object.entries(counts).map(([r, n]) => `${r}${n}人`).join("、");
    return `あなたは 9 人村の人狼ゲームに参加しているプレイヤーです。参加者には人間が混ざっていることもあります。
人を呼ぶときは「3番」「3番さん」のように席番号で呼ぶ。

## 村の構成
${roster}。人狼が全滅すれば村人陣営の勝ち。人狼の数が人間（狂人を含む）の数以上になれば人狼陣営の勝ち。
昼は順番に発言し、投票で 1 人を処刑する。夜は人狼が襲撃し、占い師・騎士も動く。初日の朝は誰も死んでいない。
占い師は最初に「人狼ではない人」を 1 人教えられている。騎士は自分を守れず、2 晩続けて同じ人は守れない。
役職を明かす（CO）か、嘘をつくかは自由。勝つために一番いい振る舞いを選んで。

## 聞いてすぐ分かる話し方
- 結論を先に言い、理由は 1 つか 2 つに絞る。誰を疑う・信じるかは席番号ではっきり言う。
- 専門用語は使ってよいが、1 回の発言で 2 つまで。耳で聞いて分かる、ふつうの話し言葉にする。
- 決まり文句で話し始めない。「役職ないです」「CO ないっす」のように役職がないことから始めない（言うなら途中で短く、言わなくてもよい）。
- 「初心者です」「まだ慣れてなくて」のように、自分の腕前やゲームに慣れていないことを口にしない。

## メタ情報の禁止
AI であること、プロンプト、ゲームの外の話はしない。

## 人狼のセオリー
${this.theory}`;
  }

  personalPrompt(p) {
    const others = this.S.players.filter((q) => q !== p).map(label).join("、");
    const [team, desc] = ROLES[p.role];
    return `## あなた
あなたは「${label(p)}」（${p.seat}番席の${p.name}）です。ほかの参加者: ${others}。

## あなたの役職: ${p.role}（${team}）
${desc}

## あなたのキャラクター
${p.persona.text}
このキャラクターの口調と腕前で話す。腕前が「初心者」なら、セオリーを全部は使いこなせない。`;
  }

  board(p) {
    const S = this.S, a = this.alive();
    const phaseName = { day: "昼", vote: "投票", night: "夜" }[S.phase] || S.phase;
    const lines = [`【いまは ${S.day} 日目・${phaseName}】`];
    lines.push("【席】" + S.players.map((q) => `${label(q)}（${q.alive ? "生" : "死"}）`).join("、"));
    const cos = S.players.filter((q) => q.co).map((q) => `${label(q)}=${q.co}`);
    lines.push("【CO状況】" + (cos.length ? cos.join("、") : "まだ誰も CO していない"));
    if (S.reports.length) {
      lines.push("【占い・霊媒の報告】");
      for (const [d, w, k, t, r] of S.reports) lines.push(`- ${d}日目 ${w}（${k}）: ${t} は${r}`);
    } else lines.push("【占い・霊媒の報告】まだなし");
    if (S.executed.length) lines.push("【処刑】" + S.executed.map(([d, n]) => `${d}日目 ${n}`).join("、"));
    if (S.attacked.length) lines.push("【襲撃された人】" + S.attacked.map(([d, n]) => `${d}日目の朝 ${n}`).join("、"));
    const gray = a.filter((q) => !q.co && q !== p && !S.reports.some((r) => r[3] === label(q))).map(label);
    lines.push(`【生存】${a.length}人。グレー（CO なし・未判定）: ${gray.length ? gray.join("、") : "なし"}`);
    lines.push(`【残りの縄の目安】あと ${Math.max(Math.floor((a.length - 1) / 2), 0)} 回吊れる（人狼が減らない場合）。人狼は全部で 2 人`);
    const stances = S.players.filter((q) => q.alive && q.stance).map((q) => `${label(q)}: ${q.stance}`);
    if (stances.length) lines.push("【みんなの今の主張（要点）】" + stances.join(" / "));
    if (p.secrets.length) { lines.push("【あなただけが知っていること】"); for (const s of p.secrets) lines.push(`- ${s}`); }
    if (p.thoughts.length) { lines.push("【自分用メモ（前に考えたこと）】"); for (const t of p.thoughts.slice(-5)) lines.push(`- ${t}`); }
    lines.push("【ここまでの発言と出来事】");
    const log = S.events.filter((e) => e.line && (!e.aud || (e.aud === "wolves" && isWolf(p)))).map((e) => e.line).slice(-100);
    lines.push(...(log.length ? log : ["（まだ何もない）"]));
    return lines.join("\n");
  }

  async ask(p, task) {
    const system = [
      { type: "text", text: this.commonPrompt(), cache_control: { type: "ephemeral" } },
      { type: "text", text: this.personalPrompt(p) },
    ];
    const user = this.board(p) + "\n\n" + task;
    // 混み合って断られても、間をおいて何度かやり直す（黙ったことにしない）
    for (let i = 0; i < 4; i++) {
      try {
        const text = await this.brain.ask(system, user);
        if (text.trim()) return text;
      } catch (e) {
        const msg = String(e.message || e);
        if (/401|authentication|api.key/i.test(msg)) { this.ui.onFatal?.("APIキーが正しくないようです。設定から入れ直してください。"); this.stop(); break; }
        if (i === 3) this.emit("sys", { text: `（${p.name} の呼び出しが混み合っていて失敗しました: ${msg.slice(0, 80)}）` });
      }
      if (this.stopped) break;
      if (i < 3) await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
    }
    return "";
  }

  remember(p, thought) {
    if (!thought) return;
    p.thoughts.push(`${this.S.day}日目: ${thought}`);
    this.emit("secret", { text: `${p.name} の考え: ${thought}`, seat: p.seat, priv: true });
  }

  matchPlayer(text, candidates) {
    // 「3番」のような席番号を優先し、なければ名前で探す
    const m = text.match(/(\d+)\s*番/);
    if (m) { const hit = candidates.find((c) => c.seat === +m[1]); if (hit) return hit; }
    return candidates.slice().sort((a, b) => b.name.length - a.name.length).find((c) => text.includes(c.name)) || null;
  }

  async aiSpeak(p, task, maxChars = charsFor(60)) {
    const text = await this.ask(p, task + `

次の形式で答えて:
考え: （誰にも見えない自分用の整理。盤面を数えて、誰を疑う・信じるか、1〜2 文）
CO: （今この発言で役職を宣言するなら 占い師 / 霊媒師 / 騎士 / 村人。しないなら なし）
報告: （占い・霊媒の結果を報告するなら「3番 白」か「3番 黒」のように。なければ なし。嘘の報告も戦略として可）
要点: （この発言でいちばん言いたいことを 15 字以内で。例「3番が怪しい」「占い真は2番」「今日は5・7ラン」）
発言: （みんなに向けた発言。キャラクターの口調で）`);
    const f = parseFields(text);
    const summary = (f["要点"] || "").replace(/^「|」$/g, "").slice(0, 20);
    if (summary) p.stance = summary;
    this.lastSummary = summary;
    this.remember(p, f["考え"] || "");
    // 「CO: なし（村人として振る舞う）」のような書き方を村人 CO と取り違えないよう、
    // 欄が役職名そのもので始まり、否定の言葉を含まないときだけ CO とみなす
    const co = (f["CO"] || "").trim();
    const role = /なし|しない|しません|潜伏|保留/.test(co) ? null : CO_ROLES.find((r) => co.startsWith(r));
    if (role) this.declareCo(p.seat, role);
    const rep = f["報告"] || "";
    if (rep && !rep.startsWith("なし")) {
      const t = this.matchPlayer(rep, this.S.players);
      const res = rep.includes("黒") || (rep.includes("人狼") && !rep.includes("ではない")) ? "黒" : (rep.includes("白") || rep.includes("ではない") ? "白" : "");
      if (t && res) this.declareReport(p.seat, t.seat, res);
    }
    if (!text.trim()) return "（通信が混み合っていて発言できませんでした）";
    let speech = f["発言"] || text.trim();
    speech = speech.replace(new RegExp(`^[「『]?(?:${p.seat}番)?${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[」』]?[:：]?`), "").trim().replace(/^「|」$/g, "");
    return clip(speech, maxChars) || "……";
  }

  async aiChoose(p, task, candidates) {
    const text = await this.ask(p, task + "\n\n【選べる相手】\n" + candidates.map((c) => `- ${label(c)}`).join("\n")
      + "\n\n次の形式で答えて:\n考え: （理由を 1〜2 文）\n答え: （名前だけ）");
    const f = parseFields(text);
    this.remember(p, f["考え"] || "");
    return this.matchPlayer(f["答え"] || "", candidates) || this.matchPlayer(text, candidates) || pick(candidates);
  }

  speechTask(round, index, total) {
    // 何周目か・発言順のどこかに合わせた指示
    const pos = index === 0 ? "トップバッター（最初）" : index === 1 ? "2 番手（トップの次）" : index >= total - 2 ? "エンドポジ（最後のほう）" : "中盤";
    let task = `いまは ${this.S.day} 日目の昼、話し合い ${round} 周目で、あなたの番です。今日の発言順で ${index + 1}/${total} 番目、${pos}の席です。\n`;
    const sec = ROUND_SECONDS[round - 1];
    task += round === 1
      ? `1 周目なので、セオリーの「1 周目」と、あなたの席の位置の型に沿って話して。持ち時間は ${sec} 秒で、使い切るのが基本（早く切り上げると情報を出していないと見られる）。役職を CO するならここ。`
      : `2 周目なので、占いの真偽の判断と、今日投票したい人を 1〜2 人、席番号ではっきり言って。持ち時間は ${sec} 秒。`;
    task += `
読み上げて ${sec} 秒以内に収まる長さ（${charsFor(sec)} 字まで）にすること。`;
    if (this.S.day >= 2) task += "\n2 日目以降なので、昨日の投票先と、昨夜誰が噛まれたかを推理の材料にして。";
    task += "\n前の人たちと同じ主張をそのまま繰り返さない。賛成なら一言で済ませ、まだ誰も言っていない材料や視点を 1 つ足す。"
      + "あなたのキャラクターとしての立場を持ち、違うと思ったらはっきり反対してよい。言いたいことは 1 つか 2 つに絞る。";
    return task;
  }

  winnerNow() {
    const a = this.alive(), wolves = a.filter(isWolf).length;
    if (wolves === 0) return "村人陣営";
    if (wolves >= a.length - wolves) return "人狼陣営";
    return null;
  }

  finish(winner) {
    this.S.winner = winner;
    this.S.over = true;
    this.S.phase = "end";
    this.S.speaking = null;
    this.emit("sys", { text: `${winner}の勝利` });
    this.ui.update();
  }

  // --- 進行（1 手ずつ進めて、そのたびに保存する）

  async run() {
    while (!this.S.over && !this.stopped) {
      const c = this.S.cursor;
      if (c.stage === "start") await this.stepStart();
      else if (c.stage === "talk") await this.stepTalk();
      else if (c.stage === "vote") await this.stepVote();
      else if (c.stage === "lastword") await this.stepLastword();
      else if (c.stage === "night") await this.stepNight();
      else if (c.stage === "morning") await this.stepMorning();
      if (!this.stopped) this.save();
    }
    this.save();
  }

  async stepStart() {
    // 初日の夜: 役職が配られ、占い師にはお告げが届く。襲撃はない
    this.setPhase("night", "初日の夜");
    this.emit("sys", { text: "夜になりました。役職が配られました" });
    await this.ui.waitPresenter(0);
    await new Promise((r) => setTimeout(r, 5000));
    if (this.stopped) return;
    this.setPhase("day", "1日目 朝");
    this.emit("sys", { text: "朝が来ました。初日の襲撃はありません", line: "1日目 朝: 初日の襲撃はなし。話し合い開始" });
    this.S.cursor = { stage: "talk", round: 1, idx: 0, announced: false };
  }

  todaysOrder() {
    // トップバッターは 1 日目はランダム、2 日目以降は噛まれた人の次の席（時計回り）
    const n = this.S.players.length, start = ((this.S.topSeat || 1) - 1) % n;
    return Array.from({ length: n }, (_, k) => this.S.players[(start + k) % n]);
  }

  async stepTalk() {
    const c = this.S.cursor, order = this.todaysOrder();
    if (!c.announced) {
      this.emit("sys", { text: `話し合い ${c.round}/${ROUNDS}`, line: `${this.S.day}日目 話し合い ${c.round} 周目` });
      c.announced = true;
    }
    const p = order[c.idx];
    if (p.alive) {
      const aliveOrder = order.filter((q) => q.alive);
      // 声が追いつくよう、1 人先までしか先に作らない
      await this.ui.waitPresenter(p.human ? 0 : 1);
      if (this.stopped) return;
      this.S.speaking = p.seat;
      this.ui.update();
      const sec = ROUND_SECONDS[c.round - 1];
      this.lastElapsed = null;
      const speech = p.human
        ? (await this.waitHuman("speak", "あなたの発言です", [], sec)) ?? null
        : await this.aiSpeak(p, this.speechTask(c.round, aliveOrder.indexOf(p), aliveOrder.length), charsFor(sec));
      if (this.stopped || speech === null) return;
      // 持ち時間をあまり使わずに切り上げたら、それも AI に見える記録に残す
      const early = p.human && this.lastElapsed != null && this.lastElapsed < sec * 0.4
        ? `（持ち時間 ${sec} 秒のうち ${this.lastElapsed} 秒で発言を終えた）` : "";
      this.emit("say", { text: speech || "……", seat: p.seat, summary: p.human ? "" : this.lastSummary, line: `${this.S.day}日目 ${label(p)}: 「${speech || "……"}」${early}` });
    }
    c.idx++;
    if (c.idx >= order.length) {
      c.round++; c.idx = 0; c.announced = false;
      if (c.round > ROUNDS) { this.S.speaking = null; this.S.cursor = { stage: "vote", sub: "main", cands: null, announced: false }; }
    }
  }

  async voteRound(candidates, title) {
    const voters = this.alive();
    const ai = voters.filter((p) => !p.human);
    const jobs = ai.map((p) => this.aiChoose(p, `${title}。今日処刑したい人に投票してください。`, candidates.filter((c) => c !== p)).then((t) => [p, t]));
    const votes = new Map();
    const me = voters.find((p) => p.human);
    if (me) {
      const seat = await this.waitHuman("vote", `${title}。処刑したい人を席から選んでください`, candidates.filter((c) => c !== me).map((c) => c.seat));
      if (seat == null) return null;
      votes.set(me, this.bySeat(seat));
    }
    for (const [p, t] of await Promise.all(jobs)) votes.set(p, t);
    if (this.stopped) return null;
    const tally = new Map();
    for (const p of voters) {
      const t = votes.get(p);
      tally.set(t, (tally.get(t) || 0) + 1);
      this.emit("vote", { text: `${p.name} → ${t.name}`, seat: p.seat, line: `${this.S.day}日目 投票: ${label(p)} → ${label(t)}` });
    }
    const top = Math.max(...tally.values());
    return [...tally].filter(([, n]) => n === top).map(([t]) => t);
  }

  async stepVote() {
    const c = this.S.cursor;
    await this.ui.waitPresenter(0);
    if (!c.announced) { this.setPhase("vote", `${this.S.day}日目 投票`); c.announced = true; }
    const cands = c.sub === "runoff" ? c.cands.map((s) => this.bySeat(s)) : this.alive();
    const tied = await this.voteRound(cands, c.sub === "runoff" ? "決選投票" : "投票");
    if (!tied) return;
    if (tied.length > 1 && c.sub === "main") {
      this.emit("sys", { text: "同票です。決選投票を行います" });
      this.S.cursor = { stage: "vote", sub: "runoff", cands: tied.map((t) => t.seat), announced: true };
      return;
    }
    const target = tied.length > 1 ? pick(tied) : tied[0];
    if (tied.length > 1) this.emit("sys", { text: `再び同票。くじで ${target.name} が選ばれました` });
    this.emit("death", { text: `${target.name} が処刑されます`, seat: target.seat, line: `${this.S.day}日目 投票の結果、${label(target)} が処刑された` });
    this.S.cursor = { stage: "lastword", target: target.seat };
  }

  async stepLastword() {
    const t = this.bySeat(this.S.cursor.target);
    await this.ui.waitPresenter(t.human ? 0 : 1);
    this.S.speaking = t.seat;
    this.ui.update();
    const last = t.human
      ? await this.waitHuman("speak", "処刑されます。最後に一言どうぞ", [], LASTWORD_SECONDS)
      : await this.aiSpeak(t, `あなたは投票で処刑されることになりました。最後に一言どうぞ（${LASTWORD_SECONDS} 秒以内）。`, charsFor(LASTWORD_SECONDS));
    if (this.stopped || last === null) return;
    this.emit("say", { text: last || "……", seat: t.seat, summary: t.human ? "" : this.lastSummary, line: `${this.S.day}日目 ${label(t)}（遺言）: 「${last || "……"}」` });
    this.S.speaking = null;
    t.alive = false;
    this.S.executed.push([this.S.day, label(t)]);
    const result = isWolf(t) ? "人狼だった" : "人狼ではなかった";
    for (const m of this.alive().filter((p) => p.role === "霊媒師")) {
      m.secrets.push(`${this.S.day}日目: 処刑された ${label(t)} は${result}（霊媒結果）`);
      m.known[t.seat] = isWolf(t) ? "黒" : "白";
    }
    this.ui.update();
    const w = this.winnerNow();
    if (w) { await this.ui.waitPresenter(0); this.finish(w); } else this.S.cursor = { stage: "night" };
  }

  // --- 夜の人狼の相談タイム（人狼だけに見える）

  async wolfTalk(w, task) {
    const partner = this.alive().filter((q) => isWolf(q) && q !== w).map(label).join("、");
    const text = await this.ask(w, `いまは ${this.S.day} 日目の夜、人狼どうしの相談タイムです（ほかの人には見えない）。相方の人狼: ${partner}。
${task}
2〜3 文で、キャラクターの口調で、相方に向けて話して。

次の形式で答えて:
考え: （自分用の整理を 1 文）
発言: （相方への言葉）`);
    const f = parseFields(text);
    this.remember(w, f["考え"] || "");
    return clip((f["発言"] || text).trim(), charsFor(30)) || "……";
  }

  async wolfMeeting(wolves) {
    await this.ui.waitPresenter(0);
    const day = this.S.day;
    this.emit("sys", { text: "人狼の相談タイム（人狼だけに見えています）", aud: "wolves", line: `${day}日目夜: 人狼の相談` });
    const say = async (w, task) => {
      const t = await this.wolfTalk(w, task);
      if (this.stopped) return;
      this.emit("wolf", { text: t, seat: w.seat, aud: "wolves", line: `${day}日目夜 人狼の相談 ${label(w)}: 「${t}」` });
    };
    const human = wolves.find((w) => w.human), ai = wolves.filter((w) => !w.human);
    if (human) {
      await say(ai[0], "今夜の襲撃先の候補と理由を相方に提案して。");
      await this.ui.waitPresenter(0);
      if (this.stopped) return;
      const reply = await this.waitHuman("wolfchat", "人狼の相談タイム。相方に返事をしてください（空のまま送ると相方に任せます）", [], 60);
      if (reply === null || this.stopped) return;
      this.emit("wolf", { text: reply || "（任せる）", seat: human.seat, aud: "wolves", line: `${day}日目夜 人狼の相談 ${label(human)}: 「${reply || "任せる"}」` });
      await say(ai[0], "相方の返事を受けて、今夜の襲撃先をまとめて。明日の昼の動き方（騙るか、潜伏か、相方をどう扱うか）も一言。");
    } else {
      await say(ai[0], "今夜の襲撃先の候補と理由、明日の昼の作戦（誰が占い師を騙るか、潜伏するか）を相方に提案して。");
      await say(ai[1], "相方の提案に答えて。賛成か、別の候補か。明日の昼の作戦も合わせて。");
    }
    await this.ui.waitPresenter(0);
  }

  async stepNight() {
    await this.ui.waitPresenter(0);
    this.setPhase("night", `${this.S.day}日目 夜`);
    const alive = this.alive();
    const options = (p) => {
      if (p.role === "人狼") return [alive.filter((q) => !isWolf(q)), "襲撃する相手"];
      if (p.role === "占い師") return [alive.filter((q) => q !== p), "占う相手"];
      return [alive.filter((q) => q !== p && label(q) !== this.S.lastGuard), "守る相手"];
    };
    const wolves = alive.filter(isWolf);
    if (wolves.length >= 2) { await this.wolfMeeting(wolves); if (this.stopped) return; }
    const actors = alive.filter((p) => ["人狼", "占い師", "騎士"].includes(p.role));
    const jobs = actors.filter((p) => !p.human).map((p) => {
      const [cands, what] = options(p);
      const agreed = p.role === "人狼" && wolves.length >= 2 ? "さっきの人狼の相談で決めた相手を選んで。" : "";
      return this.aiChoose(p, `夜です。${p.role}として、今夜${what}を選んでください。${agreed}`, cands).then((t) => [p, t]);
    });
    const picks = new Map();
    const me = actors.find((p) => p.human);
    if (me) {
      const [cands, what] = options(me);
      const seat = await this.waitHuman("night", `夜です。${me.role}として、今夜${what}を席から選んでください`, cands.map((c) => c.seat));
      if (seat == null) return;
      picks.set(me, this.bySeat(seat));
    }
    for (const [p, t] of await Promise.all(jobs)) picks.set(p, t);
    if (this.stopped) return;

    for (const [p, t] of picks) {
      if (p.role === "占い師") {
        p.secrets.push(`${this.S.day}日目夜: 占い結果 ${label(t)} は${isWolf(t) ? "人狼" : "人狼ではない"}`);
        p.known[t.seat] = isWolf(t) ? "黒" : "白";
      }
      this.emit("secret", { text: `${p.name}（${p.role}）→ ${t.name}`, seat: p.seat, priv: true });
    }
    const wolfPicks = [...picks].filter(([p]) => isWolf(p));
    const humanWolf = wolfPicks.find(([p]) => p.human);
    const lead = wolfPicks.find(([p]) => p === wolves[0]);
    const victim = humanWolf ? humanWolf[1] : (lead ? lead[1] : pick(wolfPicks.map(([, t]) => t)));
    const guard = [...picks].find(([p]) => p.role === "騎士")?.[1] || null;
    this.S.lastGuard = guard ? label(guard) : null;
    for (const w of alive.filter(isWolf)) w.secrets.push(`${this.S.day}日目夜: ${label(victim)} を襲撃した`);

    // 演出のため少しだけ夜を見せる
    await new Promise((r) => setTimeout(r, 2500));
    this.S.day++;
    this.setPhase("day", `${this.S.day}日目 朝`);
    const n = this.S.players.length;
    if (guard === victim) {
      this.S.topSeat = (this.S.topSeat || 1) % n + 1;
      for (const k of alive.filter((p) => p.role === "騎士")) k.secrets.push(`${this.S.day - 1}日目夜: ${label(victim)} を守り、襲撃を防いだ`);
      this.emit("sys", { text: "昨夜は誰も死ななかった", line: `${this.S.day}日目 朝: 昨夜は誰も死ななかった` });
    } else {
      victim.alive = false;
      this.S.topSeat = victim.seat % n + 1;
      this.S.attacked.push([this.S.day, label(victim)]);
      this.emit("death", { text: `${victim.name} が無残な姿で見つかりました`, seat: victim.seat, line: `${this.S.day}日目 朝: ${label(victim)} が襲撃されて死んでいた` });
    }
    this.ui.update();
    const w = this.winnerNow();
    if (w) this.finish(w);
    else this.S.cursor = { stage: "morning" };
  }

  // --- 朝の結果発表: 夜が明けたら、話し合いの前に占い師・霊媒師が結果を出す（自分の番を待たない）

  async morningReport(p) {
    const co = p.co ? `${p.co}として CO 済み` : "まだ CO していない";
    const text = await this.ask(p, `夜が明けて ${this.S.day} 日目の朝です。話し合いの前に、占い師・霊媒師が結果を発表する時間です（自分の番を待たずに出せる）。
あなたは${co}。結果を出すなら CO と報告を書き、発言は結果を伝える 1 文だけにして。出さないなら全部「なし」。
本物でなくても、占い師・霊媒師を名乗っているなら結果を出すのが自然（嘘の結果も戦略として可）。

次の形式で答えて:
考え: （1 文）
CO: （占い師 / 霊媒師 / なし）
報告: （「3番 白」か「3番 黒」。なければ なし）
発言: （結果を伝える 1 文。出さないなら なし）`);
    return { p, f: parseFields(text) };
  }

  async stepMorning() {
    await this.ui.waitPresenter(0);
    const day = this.S.day;
    const ROLE_CO = ["占い師", "霊媒師"];
    const reporters = this.alive().filter((p) => !p.human && (ROLE_CO.includes(p.co) || ROLE_CO.includes(p.role)));
    if (reporters.length) {
      this.emit("sys", { text: "朝の結果発表", line: `${day}日目 朝の結果発表` });
      const results = await Promise.all(reporters.map((p) => this.morningReport(p)));
      if (this.stopped) return;
      for (const { p, f } of results.sort((a, b) => a.p.seat - b.p.seat)) {
        this.remember(p, f["考え"] || "");
        const co = (f["CO"] || "").trim();
        const role = /なし|しない/.test(co) ? null : ROLE_CO.find((r) => co.startsWith(r));
        const rep = f["報告"] || "";
        const t = rep && !rep.startsWith("なし") ? this.matchPlayer(rep, this.S.players) : null;
        const res = rep.includes("黒") ? "黒" : rep.includes("白") ? "白" : "";
        if (!role && !(p.co && t && res)) continue;            // 何も出さない人
        if (role) this.declareCo(p.seat, role);
        if (t && res) this.declareReport(p.seat, t.seat, res);
        const speech = (f["発言"] || "").trim();
        if (speech && !speech.startsWith("なし")) {
          this.emit("say", { text: clip(speech, charsFor(20)), seat: p.seat, line: `${day}日目 朝の結果発表 ${label(p)}: 「${speech}」` });
        }
      }
    }
    this.S.cursor = { stage: "talk", round: 1, idx: 0, announced: false };
  }
}
