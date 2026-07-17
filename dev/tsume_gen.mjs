// つめしょうぎ問題ジェネレーター
//
// index.html のルールエンジン部分をそのまま読み込んで使い、
// ランダムに作った局面を「本当に詰むか」全数検証して問題にする。
// 出版物の問題集はコピーしない（著作権のため）。パターン設計だけを参考にする。
//
// 使い方: node dev/tsume_gen.mjs [--seed 数字]
// 出力: dev/tsume_data.js（index.html へ埋め込む問題データ）と検証レポート

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- エンジンを index.html から抜き出して読み込む（二重実装しない） ----
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const begin = html.indexOf('/* =====================  ルールエンジン');
const end = html.indexOf('/* =====================  よわめCPU');
if (begin < 0 || end < 0) throw new Error('index.html からエンジン部分を見つけられません');
const engineSrc = html.slice(begin, end);
const engine = new Function(`
  ${engineSrc}
  return { S, G, other, emptyHand, cloneState, inBoard, pseudoDests, findKing,
           inCheck, deadEnd, nifu, applyMove, legalMoves, HAND_ORDER };
`)();
const { S, G, cloneState, inCheck, applyMove, legalMoves, HAND_ORDER } = engine;

// ---- 乱数（seed固定で再現可能にする） ----
let seed = 20260717;
const argIdx = process.argv.indexOf('--seed');
if (argIdx >= 0) seed = Number(process.argv[argIdx + 1]);
function rnd() { // mulberry32
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = n => Math.floor(rnd() * n);
const pick = a => a[ri(a.length)];

// ---- 局面づくり ----
const TOTALS = { FU: 18, KY: 4, KE: 4, GI: 4, KI: 4, KA: 2, HI: 2 };

function emptyState() {
  return {
    board: [...Array(9)].map(() => Array(9).fill(null)),
    hands: { S: engine.emptyHand(), G: engine.emptyHand() },
    turn: S, over: null, last: null,
  };
}
// 盤と先手持ち駒の残り全部を後手の持ち駒にする（詰将棋の約束事）
function fillGoteHand(st) {
  const used = { FU: 0, KY: 0, KE: 0, GI: 0, KI: 0, KA: 0, HI: 0 };
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = st.board[r][c];
    if (p && p.t !== 'OU') used[p.t]++;
  }
  for (const t of HAND_ORDER) {
    st.hands.G[t] = TOTALS[t] - used[t] - st.hands.S[t];
    if (st.hands.G[t] < 0) return false;
  }
  return true;
}
function nifuOnBoard(st, r, c, t, o) {
  if (t !== 'FU') return false;
  for (let i = 0; i < 9; i++) {
    const p = st.board[i][c];
    if (p && p.o === o && p.t === 'FU' && !p.p) return true;
  }
  return false;
}
function placeRandom(st, t, o, p, zone) {
  for (let tries = 0; tries < 30; tries++) {
    const [r, c] = pick(zone);
    if (st.board[r][c]) continue;
    if (!p && engine.deadEnd(t, r, o)) continue;
    if (!p && nifuOnBoard(st, r, c, t, o)) continue;
    st.board[r][c] = { t, o, p };
    return true;
  }
  return false;
}
function near(kr, kc, dist, rMin = 0, rMax = 8) {
  const cells = [];
  for (let r = Math.max(rMin, kr - dist); r <= Math.min(rMax, kr + dist); r++)
    for (let c = Math.max(0, kc - dist); c <= Math.min(8, kc + dist); c++)
      if (r !== kr || c !== kc) cells.push([r, c]);
  return cells;
}

// レシピ＝どんな駒立てで乱数生成するか。パターン網羅のために複数用意する
const RECIPES = [
  // [名前, 先手持ち駒, 盤上攻め駒の候補, 攻め駒数, 守り駒数]
  ['kin-drop',  { KI: 1 }, ['FU', 'KI', 'GI', 'HI', 'KY', 'RY', 'TO'], [1, 2], [0, 2]],
  ['gin-drop',  { GI: 1 }, ['FU', 'KI', 'GI', 'HI', 'RY', 'UM'], [1, 2], [0, 2]],
  ['hi-drop',   { HI: 1 }, ['KI', 'GI', 'FU', 'UM'], [1, 2], [0, 2]],
  ['board-move', {},       ['KI', 'GI', 'HI', 'RY', 'UM', 'KA', 'TO', 'NG'], [2, 3], [0, 2]],
  ['kei-drop',  { KE: 1 }, ['KI', 'GI', 'FU', 'RY', 'HI'], [1, 3], [1, 3]],
  ['kyo-drop',  { KY: 1 }, ['KI', 'GI', 'FU', 'RY'], [1, 2], [0, 2]],
  ['fu-promote', {},       ['FU', 'KI', 'GI', 'HI', 'RY', 'KY'], [2, 3], [0, 2]],
  ['kaku-drop', { KA: 1 }, ['KI', 'GI', 'FU', 'RY'], [1, 2], [0, 2]],
];
const PIECE = { RY: { t: 'HI', p: true }, UM: { t: 'KA', p: true }, TO: { t: 'FU', p: true }, NG: { t: 'GI', p: true } };

function genCandidate(recipe, forMate3) {
  const [, hand, atkTypes, atkN, defN] = recipe;
  const st = emptyState();
  const kr = ri(2), kc = ri(9);                    // 玉は上2段のどこか
  st.board[kr][kc] = { t: 'OU', o: G, p: false };
  const skc = kc <= 4 ? 8 : 0;                     // 先手玉は遠くの下段
  st.board[8][skc] = { t: 'OU', o: S, p: false };
  st.hands.S = { ...engine.emptyHand(), ...hand };
  if (forMate3 && rnd() < 0.7) st.hands.S[pick(['KI', 'GI', 'FU'])]++;

  const nd = defN[0] + ri(defN[1] - defN[0] + 1);
  for (let i = 0; i < nd; i++) placeRandom(st, pick(['KI', 'GI', 'FU', 'KE']), G, false, near(kr, kc, 1 + ri(2)));
  const na = atkN[0] + ri(atkN[1] - atkN[0] + 1);
  for (let i = 0; i < na; i++) {
    const key = pick(atkTypes);
    const pc = PIECE[key] || { t: key, p: false };
    placeRandom(st, pc.t, S, pc.p, near(kr, kc, 2, 0, 6));
  }
  if (!fillGoteHand(st)) return null;
  if (inCheck(st, S)) return null;                 // 先手玉が王手されている局面は不正
  if (inCheck(st, G)) return null;                 // 先手番で後手玉に王手が掛かっているのも不正
  return st;
}

// ---- 検証 ----
function isMateAfter(st, mv) {
  const sim = applyMove(cloneState(st), mv);
  return inCheck(sim, G) && legalMoves(sim).length === 0;
}
function matingMoves(st) {
  const res = [];
  for (const mv of legalMoves(st)) {
    const sim = applyMove(cloneState(st), mv);
    if (!inCheck(sim, G)) continue;                // 王手でない手は詰まない
    if (legalMoves(sim).length === 0) res.push(mv);
  }
  return res;
}
function firstMatingMove(st) {
  for (const mv of legalMoves(st)) {
    const sim = applyMove(cloneState(st), mv);
    if (!inCheck(sim, G)) continue;
    if (legalMoves(sim).length === 0) return mv;
  }
  return null;
}
// 3手詰め: どう受けても詰む初手（すべて王手）が存在するか
function forcedMate3(st) {
  const sols = [];
  for (const m1 of legalMoves(st)) {
    const s1 = applyMove(cloneState(st), m1);
    if (!inCheck(s1, G)) continue;
    const replies = legalMoves(s1);
    if (replies.length === 0) return { mate1: true };   // 1手で詰む→3手問題として不採用
    let all = true;
    for (const m2 of replies) {
      const s2 = applyMove(cloneState(s1), m2);
      if (!firstMatingMove(s2)) { all = false; break; }
    }
    if (all) {
      sols.push(m1);
      if (sols.length > 2) return { many: true };       // 正解が多すぎる問題は分かりにくいので不採用
    }
  }
  return { sols };
}

// ---- 問題の分類と難易度 ----
function classify(mv, st) {
  const t = mv.drop || st.board[mv.from.r][mv.from.c].t;
  const prom = mv.drop ? false : st.board[mv.from.r][mv.from.c].p || mv.promote;
  if (t === 'KI') return 'kin';
  if (t === 'GI') return 'gin';
  if (t === 'HI') return 'hi';
  if (t === 'KA') return 'kaku';
  if (t === 'KE') return 'kei';
  if (t === 'KY') return 'kyo';
  if (t === 'FU' && prom) return 'tokin';
  return 'mix';
}
function pieceCount(st) {
  let n = 0;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (st.board[r][c]) n++;
  return n;
}
function difficulty(st, mates) {
  const n = legalMoves(st).length;
  const mv = mates[0];
  const king = engine.findKing(st, G);
  const dist = Math.max(Math.abs(mv.to.r - king[0]), Math.abs(mv.to.c - king[1]));
  return n * 0.15 + (mv.drop ? 0 : 2) + (mv.promote ? 2 : 0) + (dist > 1 ? 2 : 0)
    + pieceCount(st) * 0.5 + (mates.length === 1 ? 0 : 1);
}

// ---- 直列化（index.html へ埋め込む形式） ----
function encBoard(st) {
  const out = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = st.board[r][c];
    if (p) out.push(`${r}${c}${p.t}${p.o}${p.p ? 1 : 0}`);
  }
  return out.join(',');
}
function encHand(h) {
  return HAND_ORDER.filter(t => h[t]).map(t => `${t}${h[t]}`).join(',');
}
function encMove(mv) {
  return mv.drop ? `D${mv.drop}${mv.to.r}${mv.to.c}`
    : `M${mv.from.r}${mv.from.c}${mv.to.r}${mv.to.c}${mv.promote ? 1 : 0}`;
}
function key(st) { return encBoard(st) + '|' + encHand(st.hands.S); }

// ---- 生成の本体 ----
console.log('生成をはじめます（seed=' + seed + '）…');
const t0 = Date.now();

// 1手詰め: レシピを回して分類ごとのプールへ貯める
const pools = { kin: [], gin: [], hi: [], kaku: [], kei: [], kyo: [], tokin: [], mix: [] };
const seen = new Set();
const QUOTA = { kin: 16, gin: 12, hi: 12, kaku: 10, kei: 8, kyo: 6, tokin: 6, mix: 0 }; // 計70。mixはほぼ出ないので0
const need = () => Object.keys(QUOTA).reduce((s, k) => s + Math.max(0, QUOTA[k] - pools[k].length), 0);

let trials1 = 0;
while (need() > 0 && trials1 < 120000) {
  trials1++;
  const st = genCandidate(pick(RECIPES), false);
  if (!st) continue;
  const k = key(st);
  if (seen.has(k)) continue;
  const mates = matingMoves(st);
  if (mates.length < 1 || mates.length > 2) continue;   // 正解が1〜2通りの問題だけ採る
  seen.add(k);
  const cat = classify(mates[0], st);
  if (pools[cat].length >= QUOTA[cat] + 20) continue;
  pools[cat].push({ st, mates, diff: difficulty(st, mates) });
  if (trials1 % 10000 === 0) console.log(`  1手詰め: ${trials1}回試行, 残り${need()}問`);
}
console.log(`1手詰めプール完成（${trials1}回試行, ${((Date.now() - t0) / 1000).toFixed(0)}秒)`);
for (const k of Object.keys(pools)) console.log(`  ${k}: ${pools[k].length}問（採用${Math.min(QUOTA[k], pools[k].length)}）`);

// 3手詰め: 30問
const pool3 = [];
let trials3 = 0;
const t3 = Date.now();
while (pool3.length < 30 && trials3 < 60000) {
  trials3++;
  const st = genCandidate(pick(RECIPES.filter(r => ['kin-drop', 'gin-drop', 'hi-drop', 'board-move'].includes(r[0]))), true);
  if (!st) continue;
  const k = key(st);
  if (seen.has(k)) continue;
  if (matingMoves(st).length > 0) continue;             // 1手で詰んでしまうものは除外
  const v = forcedMate3(st);
  if (!v.sols || v.sols.length < 1) continue;
  seen.add(k);
  // こたえの手順サンプル: 初手 → 後手の応手（最初の合法手）→ 詰みの手
  const m1 = v.sols[0];
  const s1 = applyMove(cloneState(st), m1);
  const m2 = legalMoves(s1)[0];
  const s2 = applyMove(cloneState(s1), m2);
  const m3 = firstMatingMove(s2);
  pool3.push({ st, m1, line: [m1, m2, m3], nSol: v.sols.length, diff: legalMoves(s1).length + pieceCount(st) * 0.5 });
  if (pool3.length % 5 === 0) console.log(`  3手詰め: ${pool3.length}/30問（${trials3}回試行）`);
}
console.log(`3手詰め完成（${trials3}回試行, ${((Date.now() - t3) / 1000).toFixed(0)}秒）`);
if (pool3.length < 30) throw new Error('3手詰めが30問に届きませんでした: ' + pool3.length);

// ---- 並べる: 研究にもとづく順（金→銀→飛→角→桂→香→と金→ミックス）、各カテゴリ内は易→難 ----
const ORDER = ['kin', 'gin', 'hi', 'kaku', 'kei', 'kyo', 'tokin', 'mix'];
const problems = [];
for (const cat of ORDER) {
  const sel = pools[cat].sort((a, b) => a.diff - b.diff).slice(0, QUOTA[cat]);
  for (const p of sel) problems.push({ d: 1, st: p.st, ans: p.mates.map(encMove), line: null });
}
if (problems.length !== 70) throw new Error('1手詰めが70問になりません: ' + problems.length);
pool3.sort((a, b) => a.diff - b.diff);
for (const p of pool3) problems.push({ d: 3, st: p.st, ans: [encMove(p.m1)], line: p.line.map(encMove) });

// ---- 最終検証（生成とは独立にもう一度全問確かめる） ----
console.log('最終検証…');
let okCount = 0;
problems.forEach((p, i) => {
  const st = p.st;
  if (inCheck(st, S) || inCheck(st, G)) throw new Error(`問${i + 1}: 初期局面が不正`);
  if (p.d === 1) {
    const mates = matingMoves(st);
    if (mates.length < 1) throw new Error(`問${i + 1}: 詰みなし`);
  } else {
    const v = forcedMate3(st);
    if (!v.sols || v.sols.length < 1) throw new Error(`問${i + 1}: 3手で詰まない`);
  }
  okCount++;
});
console.log(`最終検証: ${okCount}/${problems.length} 合格`);

// ---- 出力 ----
const data = problems.map(p => ({
  d: p.d, b: encBoard(p.st), h: encHand(p.st.hands.S), a: p.ans, l: p.line,
}));
const js = 'const TSUME=' + JSON.stringify(data) + ';';
writeFileSync(join(__dirname, 'tsume_data.js'), js);
console.log(`書き出し: dev/tsume_data.js（${(js.length / 1024).toFixed(1)}KB）`);
console.log(`合計 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
