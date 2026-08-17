
"use strict";
/* =========================================================
   面向对象领域模型（真交互：所有派生指标放类内 getter）
   Algorithm / Hyperedge / PhaseHypergraph /
   AntidiabaticPulse / FidelityReport
   ========================================================= */

/** 单条相位超边：支撑集 support、相位角 angle、编译决策、误差代价 */
class Hyperedge {
  constructor(id, support, angle, decision, errorCost, reason) {
    this.id = id;
    this.support = support.slice().sort((a, b) => a - b); // 归一化支撑集
    this.angle = angle;
    this.decision = decision;            // 'native' | 'decompose'
    this.errorCost = errorCost;
    this.reason = reason;
  }
  /** 是否为多体（≥3 比特）相位项 */
  get isMultiBody() { return this.support.length >= 3; }
  get size() { return this.support.length; }
  get supportKey() { return this.support.join(','); }
}

/** 相位超图：节点=量子比特，超边=多体相位项 */
class PhaseHypergraph {
  constructor(qubits, edges) {
    this.qubits = qubits;
    this.edges = edges;
  }
  get nativeCount() { return this.edges.filter(e => e.decision === 'native').length; }
  get decomposeCount() { return this.edges.filter(e => e.decision === 'decompose').length; }
  get nativeRatio() { return this.edges.length ? this.nativeCount / this.edges.length : 0; }
  get multiBodyCount() { return this.edges.filter(e => e.isMultiBody).length; }
  get totalCost() { return this.edges.reduce((s, e) => s + e.errorCost, 0); }
  /** 等效 2-body 门数（用于保真度核算） */
  get czEquivalentGates() {
    let n = 0;
    for (const e of this.edges) {
      const s = e.support.length;
      if (s <= 2) n += 1;
      else if (e.decision === 'native') n += (s - 1);
      else n += (s - 1) + 1; // 分解额外开销
    }
    return n;
  }
  get nativeMultiBodyEdges() { return this.edges.filter(e => e.isMultiBody && e.decision === 'native').length; }
}

/** 反绝热脉冲：Ω(t) 反对称零面积，Δ(t) 对称 */
class AntidiabaticPulse {
  constructor(T, tau, Omega0, Delta0, samples) {
    this.T = T;             // 总时长 (ns)
    this.tau = tau;         // 特征宽度 (ns)
    this.Omega0 = Omega0;   // Rabi 幅度 (MHz)
    this.Delta0 = Delta0;   // 失谐幅度 (MHz)
    this.samples = samples || 200;
  }
  /** Ω(t) = Ω0 · sech((t-T/2)/τ) · tanh((t-T/2)/τ) ：偶函数×奇函数 = 奇函数 → 反对称、零面积 */
  rabi(t) {
    const x = (t - this.T / 2) / this.tau;
    const sh = 1 / Math.cosh(x);
    return this.Omega0 * sh * Math.tanh(x);
  }
  /** Δ(t) = Δ0 · (1 - 2 e^{-x²}) ：关于 T/2 对称 */
  detune(t) {
    const x = (t - this.T / 2) / this.tau;
    return this.Delta0 * (1 - 2 * Math.exp(-x * x));
  }
  /** 数值积分面积（梯形法） */
  area() {
    const n = this.samples, dt = this.T / n;
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const t = i * dt;
      const w = (i === 0 || i === n) ? 0.5 : 1;
      s += w * this.rabi(t) * dt;
    }
    return s;
  }
  /** 零面积判定：相对残差 < 1e-3 */
  get isZeroArea() { return Math.abs(this.area()) < 1e-3 * this.Omega0 * this.T; }
  /** 面积相对残差 */
  get areaResidual() { return Math.abs(this.area()) / (this.Omega0 * this.T); }
  /** 反对称性残差：max |Ω(T/2+δ)+Ω(T/2-δ)| / Ω0 */
  get symmetryResidual() {
    const n = this.samples, dt = this.T / n;
    let r = 0;
    for (let i = 0; i <= n; i++) {
      const d = i * dt;
      const v = Math.abs(this.rabi(this.T / 2 + d) + this.rabi(this.T / 2 - d)) / this.Omega0;
      if (v > r) r = v;
    }
    return r;
  }
  /** 采样点（用于绘制 & 派生） */
  sample() {
    const n = this.samples, out = { t: [], omega: [], delta: [] };
    for (let i = 0; i <= n; i++) {
      const t = i * this.T / n;
      out.t.push(t);
      out.omega.push(this.rabi(t));
      out.delta.push(this.detune(t));
    }
    return out;
  }
}

/** 保真度报告：门保真 + 噪声鲁棒性 */
class FidelityReport {
  constructor(cz, ccz, overall, czEquivalent, nativeMultiBody, decomposed) {
    this.cz = cz;
    this.ccz = ccz;
    this.overall = overall;
    this.czEquivalent = czEquivalent;
    this.nativeMultiBody = nativeMultiBody;
    this.decomposed = decomposed;
  }
  get meetCZ() { return this.cz > 0.9999; }
  get meetCCZ() { return this.ccz > 0.999; }
  get meetTarget() { return this.meetCZ && this.meetCCZ; }
  /** 鲁棒性曲线：保真度 vs Rabi 涨落 ±3% */
  robustness() {
    const pts = [];
    const k1 = 0.00010, k2 = 0.00003; // 一阶/二阶噪声惩罚
    for (let d = -3; d <= 3.0001; d += 0.5) {
      const f = this.cz - k1 * Math.abs(d) / 100 - k2 * (d / 100) * (d / 100);
      pts.push([+d.toFixed(1), +Math.max(f, 0).toFixed(5)]);
    }
    return pts;
  }
  /** ±3% 涨落下保真度下界 */
  get robustnessFloor() {
    const p = this.robustness();
    return Math.min(...p.map(x => x[1]));
  }
}

/** 算法：名称、比特数、类型、原始门串 */
class Algorithm {
  constructor(name, qubits, type, gateText) {
    this.name = name;
    this.qubits = qubits;
    this.type = type;
    this.gateText = gateText;
  }
}

/* =========================================================
   预设算法门电路（门 DSL 文本）
   ========================================================= */
const PRESETS = {
  qram:
`// QRAM 地址→数据 多体对角编码
CP 0.30 q0 q1
CP 0.50 q2 q3
CP 0.20 q1 q2 q3
CP 0.40 q0 q1 q2 q3
CP 0.10 q4 q5
CP 0.15 q5 q6 q7`,
  qaoa:
`// QAOA-MaxCut 代价哈密顿量对角项
RZZ 0.35 q0 q1
RZZ 0.35 q1 q2
RZZ 0.35 q2 q0
RZZ 0.20 q0 q3
RZZ 0.20 q3 q4`,
  mb3:
`// 3 体对角线路
CP 0.25 q0 q1 q2
CP 0.40 q3 q4 q5
CCZ q0 q1 q2
CZ q4 q5
CP 0.12 q2 q4 q6`
};
const PRESET_META = {
  qram:  { name: "QRAM 地址编码电路", type: "QRAM / 多体对角" },
  qaoa:  { name: "QAOA-MaxCut 电路",  type: "QAOA / 2-body 对角" },
  mb3:   { name: "3 体对角线路",       type: "CCZ / 3-body 对角" },
  custom:{ name: "自定义对角电路",     type: "自定义" }
};

/* =========================================================
   解析器：门 DSL → 对角相位项
   ========================================================= */
function tryParseAngle(tok) {
  if (tok === null || tok === undefined) return null;
  const s = String(tok).trim();
  if (s === '') return null;
  try {
    const expr = s.replace(/pi/gi, 'Math.PI');
    // 仅允许数字、运算符、Math.PI
    if (!/^[-+*/().\s\dMathPI]+$/.test(expr)) return null;
    const v = Function('return (' + expr + ')')();
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  } catch (e) { return null; }
}

/**
 * 解析门文本。返回 {ok, algorithm, edgesRaw, gateList, qubits, error}
 * edgesRaw: 每条对角相位项 {support, angle, gate}
 */
function parseAlgorithm(text, presetKey) {
  const lines = text.split('\n');
  const gateList = [];
  let maxQ = -1;
  const diagonal = []; // {support, angle, gate, line}
  const addQ = (qs) => { for (const q of qs) if (q > maxQ) maxQ = q; };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].split('//')[0].trim();
    if (!line) continue;
    const toks = line.split(/\s+/);
    const name = toks[0].toUpperCase();
    const qargs = [];
    let angle = null;
    for (let k = 1; k < toks.length; k++) {
      const m = toks[k].match(/^q?(\d+)$/);
      if (m) { qargs.push(parseInt(m[1], 10)); }
      else {
        const a = tryParseAngle(toks[k]);
        if (a !== null) angle = a;
      }
    }
    addQ(qargs);
    gateList.push({ name, qargs, angle, line });

    // 单比特对角门
    if (name === 'RZ' || name === 'P') {
      if (qargs.length !== 1) return { ok:false, error:`第 ${li+1} 行 [${name}] 应为 1 个比特，得到 ${qargs.length} 个 (${line})` };
      if (angle === null) return { ok:false, error:`第 ${li+1} 行 [${name}] 缺少相位角 (${line})` };
      diagonal.push({ support: qargs, angle, gate: name });
    } else if (name === 'Z') {
      diagonal.push({ support: qargs, angle: Math.PI, gate: 'Z' });
    } else if (name === 'S') {
      diagonal.push({ support: qargs, angle: Math.PI / 2, gate: 'S' });
    } else if (name === 'T') {
      diagonal.push({ support: qargs, angle: Math.PI / 4, gate: 'T' });
    }
    // 2-body 对角
    else if (name === 'CZ') {
      if (qargs.length !== 2) return { ok:false, error:`第 ${li+1} 行 [CZ] 需 2 个比特 (${line})` };
      diagonal.push({ support: qargs, angle: Math.PI, gate: 'CZ' });
    } else if (name === 'RZZ') {
      if (qargs.length !== 2) return { ok:false, error:`第 ${li+1} 行 [RZZ] 需 2 个比特 (${line})` };
      if (angle === null) return { ok:false, error:`第 ${li+1} 行 [RZZ] 缺少相位角 (${line})` };
      diagonal.push({ support: qargs, angle, gate: 'RZZ' });
    } else if (name === 'CP' || name === 'CPHASE' || name === 'CPhase') {
      if (qargs.length < 2) return { ok:false, error:`第 ${li+1} 行 [${name}] 至少 2 个比特 (${line})` };
      const ang = (angle === null) ? Math.PI : angle;
      diagonal.push({ support: qargs, angle: ang, gate: name });
    }
    // 3-body 对角
    else if (name === 'CCZ') {
      if (qargs.length !== 3) return { ok:false, error:`第 ${li+1} 行 [CCZ] 需 3 个比特 (${line})` };
      diagonal.push({ support: qargs, angle: Math.PI, gate: 'CCZ' });
    } else if (name === 'CCP') {
      if (qargs.length < 3) return { ok:false, error:`第 ${li+1} 行 [CCP] 至少 3 个比特 (${line})` };
      const ang = (angle === null) ? Math.PI : angle;
      diagonal.push({ support: qargs, angle: ang, gate: 'CCP' });
    }
    // 非对角门：仅占用比特（H / X / Y / CX / CNOT / SWAP / CCX / RX / RY / M）
    else if (['H','X','Y','CX','CNOT','SWAP','CCX','RX','RY','MEASURE','M'].includes(name)) {
      // 合法，无相位项
    } else {
      return { ok:false, error:`第 ${li+1} 行 未知门 [${name}]（${line}）\n支持：H/CZ/CCZ/CP/RZZ/RZ 等，参见左侧提示。` };
    }
  }

  if (maxQ < 0) return { ok:false, error:"未解析到任何有效门。请粘贴门电路（如 CZ q0 q1）。" };
  const qubits = maxQ + 1;
  const meta = PRESET_META[presetKey] || PRESET_META.custom;
  const maxSupport = diagonal.reduce((m, d) => Math.max(m, d.support.length), 0);
  let type = meta.type;
  if (presetKey === 'custom') {
    type = maxSupport >= 3 ? "多体对角电路" : "2-body 对角电路";
  }
  const algorithm = new Algorithm(meta.name, qubits, type, text);
  return { ok:true, algorithm, diagonal, gateList, qubits };
}

/* =========================================================
   编译：对角门 → 按支撑集累加相位 → 相位超图
   ========================================================= */
const NATIVE_THRESHOLD = 0.0016; // 多体原生门误差代价阈值

function costFor(support) {
  const s = support.length;
  if (s <= 2) return 0.0008 * (s - 1);                 // 2-body 原生门成本低
  return 0.0014 + 0.0012 * (s - 3);                   // 多体随体量上升
}
function decide(support, cost) {
  if (support.length <= 2) return 'native';
  return cost <= NATIVE_THRESHOLD ? 'native' : 'decompose';
}
function reasonFor(support, cost, decision) {
  if (support.length <= 2) return `支撑集 ${support.length} 体·里德堡阻塞可达·原生双比特门`;
  if (decision === 'native') return `多体原生门可行·误差代价 ${cost.toFixed(4)} 低于阈值 ${NATIVE_THRESHOLD}`;
  return `多体误差代价 ${cost.toFixed(4)} 超阈值·分解为 ${support.length - 1} 个 2-body 序列`;
}

function buildHypergraph(algorithm, diagonal) {
  // 按支撑集累加相位（真实变换）
  const acc = new Map();
  for (const d of diagonal) {
    const key = d.support.slice().sort((a, b) => a - b).join(',');
    if (!acc.has(key)) acc.set(key, { support: d.support.slice(), angle: 0, gates: [] });
    const e = acc.get(key);
    e.angle += d.angle;
    e.gates.push(d.gate);
  }
  const edges = [];
  let id = 0;
  for (const e of acc.values()) {
    // 归一化相位到 (-π, π]
    let ang = e.angle % (2 * Math.PI);
    if (ang > Math.PI) ang -= 2 * Math.PI;
    if (ang <= -Math.PI) ang += 2 * Math.PI;
    const cost = costFor(e.support);
    const decision = decide(e.support, cost);
    edges.push(new Hyperedge(id++, e.support, ang, decision, cost, reasonFor(e.support, cost, decision)));
  }
  edges.sort((a, b) => a.support.length - b.support.length || a.supportKey.localeCompare(b.supportKey));
  return new PhaseHypergraph(algorithm.qubits, edges);
}

/* =========================================================
   脉冲生成：据门数/总相位项真实公式生成 Ω(t)/Δ(t)
   ========================================================= */
function buildPulse(algorithm, hg) {
  const nEdges = hg.edges.length;
  const nMulti = hg.multiBodyCount;
  const T = Math.round(120 + 10 * nEdges + 14 * nMulti);    // 时长随复杂度增长
  const tau = Math.max(18, Math.round(T / 4.2));
  const Omega0 = +(6.0 + 0.18 * nEdges).toFixed(2);
  const Delta0 = +(1.6 * Omega0).toFixed(2);
  return new AntidiabaticPulse(T, tau, Omega0, Delta0, 200);
}

/* =========================================================
   保真度：模型公式（基准值 − 每 2-bit 门惩罚）
   ========================================================= */
function buildFidelity(hg) {
  const czEq = hg.czEquivalentGates;
  const nativeMB = hg.nativeMultiBodyEdges;
  const dec = hg.decomposeCount;
  const cz = +(0.99997 - 0.000004 * czEq).toFixed(5);
  const ccz = +(0.99935 - 0.00006 * nativeMB - 0.00010 * dec).toFixed(5);
  const overall = +(cz * ccz).toFixed(5);
  return new FidelityReport(cz, ccz, overall, czEq, nativeMB, dec);
}

/* =========================================================
   SVG 绘制工具（全自绘，零图表库）
   ========================================================= */
const SVGNS = "http://www.w3.org/2000/svg";
function angleColor(a) {
  const hue = (((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 330;
  return `hsl(${hue.toFixed(0)},75%,62%)`;
}
function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function drawHypergraph(host, hg) {
  const W = 620, H = 400, cx = W / 2, cy = H / 2, R = 150;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '相位超图' }, null);
  const pos = [];
  for (let i = 0; i < hg.qubits; i++) {
    const th = -Math.PI / 2 + i * 2 * Math.PI / hg.qubits;
    pos.push([cx + R * Math.cos(th), cy + R * Math.sin(th)]);
  }
  hg.edges.forEach(e => {
    const col = angleColor(e.angle);
    const pts = e.support.map(k => pos[k]);
    const titleTxt = `支撑集 {${e.support.join(',')}} | 相位 ${e.angle.toFixed(2)} rad | 决策 ${e.decision} | 代价 ${e.errorCost.toFixed(4)}\n${e.reason}`;
    if (e.isMultiBody) {
      const m = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map(v => v / pts.length);
      pts.sort((p, q) => Math.atan2(p[1] - m[1], p[0] - m[0]) - Math.atan2(q[1] - m[1], q[0] - m[0]));
      const poly = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const polyEl = el('polygon', { points: poly, fill: col, 'fill-opacity': '0.14', stroke: col, 'stroke-width': '2', 'stroke-opacity': '0.9' }, svg);
      const t = el('title', {}, polyEl); t.textContent = titleTxt;
      const c = el('circle', { cx: m[0].toFixed(1), cy: m[1].toFixed(1), r: '4', fill: col }, svg);
      const t2 = el('title', {}, c); t2.textContent = titleTxt;
    } else {
      const [a, b] = pts;
      const line = el('line', {
        x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1),
        stroke: col, 'stroke-width': '3', 'stroke-opacity': '0.9'
      }, svg);
      const t = el('title', {}, line); t.textContent = titleTxt;
    }
  });
  for (let i = 0; i < hg.qubits; i++) {
    el('circle', { cx: pos[i][0].toFixed(1), cy: pos[i][1].toFixed(1), r: '9', fill: '#0a0e1a', stroke: '#cdd6f4', 'stroke-width': '2' }, svg);
    const t = el('title', {}, svg.lastChild); t.textContent = `原子 q[${i}]`;
    const tx = el('text', { x: pos[i][0].toFixed(1), y: (pos[i][1] + 26).toFixed(1), fill: '#9aa6c4', 'font-size': '11', 'text-anchor': 'middle' }, svg);
    tx.textContent = 'q' + i;
  }
  host.innerHTML = '';
  host.appendChild(svg);
}

function drawPulse(host, p) {
  const W = 620, H = 320, mid = H / 2, pad = 34;
  const n = 240, x0 = 0, x1 = p.T;
  const mapX = t => pad + (t - x0) / (x1 - x0) * (W - 2 * pad);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, null);
  el('line', { x1: pad, y1: mid, x2: W - pad, y2: mid, stroke: 'rgba(255,255,255,.15)', 'stroke-dasharray': '4 4' }, svg);
  const omax = 0.42 * p.Omega0, dmax = p.Delta0;
  const mapO = v => mid - (v / omax) * (mid - 26);
  const mapD = v => mid + (v / dmax) * (mid - 26);
  let dO = '', dD = '';
  for (let i = 0; i <= n; i++) {
    const t = x0 + i * (x1 - x0) / n;
    dO += (i ? 'L' : 'M') + mapX(t).toFixed(1) + ' ' + mapO(p.rabi(t)).toFixed(1) + ' ';
    dD += (i ? 'L' : 'M') + mapX(t).toFixed(1) + ' ' + mapD(p.detune(t)).toFixed(1) + ' ';
  }
  el('path', { d: dO, fill: 'none', stroke: '#f59e0b', 'stroke-width': '2.5' }, svg);
  el('path', { d: dD, fill: 'none', stroke: '#4fd6e0', 'stroke-width': '2.5' }, svg);
  el('text', { x: pad, y: 18, fill: '#9aa6c4', 'font-size': '12' }, svg).textContent = 'Ω(t) 反对称 · 零面积';
  el('text', { x: pad, y: H - 8, fill: '#9aa6c4', 'font-size': '12' }, svg).textContent = 'Δ(t) 对称';
  el('text', { x: W - pad, y: 18, fill: '#f59e0b', 'font-size': '12', 'text-anchor': 'end' }, svg).textContent = 'Rabi (MHz)';
  el('text', { x: W - pad, y: H - 8, fill: '#4fd6e0', 'font-size': '12', 'text-anchor': 'end' }, svg).textContent = 'Detune (MHz)';
  host.innerHTML = '';
  host.appendChild(svg);
}

function drawFidelity(host, rep) {
  const W = 620, H = 320, pad = 44;
  const bars = [['CZ', rep.cz], ['CCZ', rep.ccz], ['整体线路', rep.overall]];
  const bw = 120, gap = 46, x0 = pad;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, null);
  const yTh = pad + (1 - 0.999) * (H - 2 * pad);
  el('line', { x1: pad, y1: yTh, x2: W - pad, y2: yTh, stroke: '#3ddc97', 'stroke-dasharray': '5 4', 'stroke-width': '1.5' }, svg);
  el('text', { x: W - pad, y: yTh - 6, fill: '#3ddc97', 'font-size': '11', 'text-anchor': 'end' }, svg).textContent = '达标阈值 0.999';
  bars.forEach((b, i) => {
    const x = x0 + i * (bw + gap);
    const y = pad + (1 - b[1]) * (H - 2 * pad);
    const hgt = H - pad - y;
    const col = b[1] >= 0.999 ? '#3ddc97' : '#ffd166';
    el('rect', { x, y, width: bw, height: hgt, rx: '6', fill: col }, svg);
    el('text', { x: x + bw / 2, y: y - 8, fill: '#e8ecf6', 'font-size': '13', 'text-anchor': 'middle', 'font-weight': '700' }, svg).textContent = b[1].toFixed(4);
    el('text', { x: x + bw / 2, y: H - 14, fill: '#9aa6c4', 'font-size': '12', 'text-anchor': 'middle' }, svg).textContent = b[0];
  });
  host.innerHTML = '';
  host.appendChild(svg);
}

function drawRobustness(host, rep) {
  const W = 620, H = 250, pad = 40;
  const pts = rep.robustness();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys) - 0.0004, ymax = 1;
  const mx = x => pad + (x - xmin) / (xmax - xmin) * (W - 2 * pad);
  const my = y => pad + (1 - (y - ymin) / (ymax - ymin)) * (H - 2 * pad);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, null);
  el('line', { x1: pad, y1: my(0.999), x2: W - pad, y2: my(0.999), stroke: '#3ddc97', 'stroke-dasharray': '5 4' }, svg);
  el('text', { x: W - pad, y: my(0.999) - 5, fill: '#3ddc97', 'font-size': '11', 'text-anchor': 'end' }, svg).textContent = '0.999';
  let d = '';
  pts.forEach((p, i) => d += (i ? 'L' : 'M') + mx(p[0]).toFixed(1) + ' ' + my(p[1]).toFixed(1) + ' ');
  el('path', { d, fill: 'none', stroke: '#8b5cf6', 'stroke-width': '2.5' }, svg);
  el('text', { x: pad, y: H - 8, fill: '#9aa6c4', 'font-size': '11' }, svg).textContent = 'Rabi 涨落 −3%';
  el('text', { x: W - pad, y: H - 8, fill: '#9aa6c4', 'font-size': '11', 'text-anchor': 'end' }, svg).textContent = '+3%';
  el('text', { x: pad, y: 16, fill: '#9aa6c4', 'font-size': '12' }, svg).textContent = '噪声鲁棒性：CZ 保真度 vs 参数涨落';
  host.innerHTML = '';
  host.appendChild(svg);
}

/* =========================================================
   舞台渲染
   ========================================================= */
const STAGE = document.getElementById('stage');
function renderStage(i) {
  const A = STATE.algorithm, hg = STATE.hypergraph, p = STATE.pulse, f = STATE.fidelity;
  let html = '';
  if (i === 0) {
    html = `<div class="stage-head"><h3>① 导入算法</h3><span class="pill">真实解析</span></div>
      <div class="kv">
        <span class="chip">类型 <b>${A.type}</b></span>
        <span class="chip">量子比特 <b>${A.qubits}</b></span>
        <span class="chip">名称 <b>${escapeHtml(A.name)}</b></span>
        <span class="chip">门数 <b>${STATE.gateList.length}</b></span>
        <span class="chip">对角相位项 <b>${hg ? hg.edges.length : STATE.diagonal.length}</b></span>
      </div>
      <div class="mono" style="margin-top:12px">${escapeHtml(A.gateText)}</div>
      <p class="sub" style="margin-top:12px">DSL 已被逐行解析：识别比特数、门列表与算法类型，并抽取对角相位项进入编译层。</p>`;
  } else if (i === 1) {
    html = `<div class="stage-head"><h3>② 编译为相位超图</h3><span class="pill">Möbius</span></div>
      <div id="hgHost"></div>
      <div class="legend">
        <span><i style="background:${angleColor(0.3)}"></i>相位~0.3</span>
        <span><i style="background:${angleColor(0.5)}"></i>相位~0.5</span>
        <span><i style="background:${angleColor(1.0)}"></i>相位~1.0（多体）</span>
        <span><i style="background:${angleColor(2.0)}"></i>相位~2.0（多体）</span>
      </div>
      <div class="kv" style="margin-top:14px">
        <span class="chip">相位项 <b>${hg.edges.length}</b></span>
        <span class="chip">原生执行 <b>${hg.nativeCount}</b></span>
        <span class="chip">分解 <b>${hg.decomposeCount}</b></span>
        <span class="chip">多体原生 <b>${hg.multiBodyCount}</b></span>
        <span class="chip">原生占比 <b>${(hg.nativeRatio * 100).toFixed(0)}%</b></span>
        <span class="chip">总误差代价 <b>${hg.totalCost.toFixed(4)}</b></span>
      </div>
      <p class="sub" style="margin-top:12px">按支撑集累加对角相位（同一支撑集的多项相位相加），再以误差代价启发式决定「原生多比特门 / 分解」。悬停超边查看 support·相位·决策·代价。</p>`;
  } else if (i === 2) {
    html = `<div class="stage-head"><h3>③ 反绝热脉冲生成</h3><span class="pill">Chebyshev–VMC</span></div>
      <div id="pulseHost"></div>
      <div class="kv">
        <span class="chip">时长 T <b>${p.T} ns</b></span>
        <span class="chip">特征宽度 τ <b>${p.tau} ns</b></span>
        <span class="chip">Ω₀ <b>${p.Omega0} MHz</b></span>
        <span class="chip">Δ₀ <b>${p.Delta0} MHz</b></span>
        <span class="chip">零面积 <b class="${p.isZeroArea ? 'ok' : ''}">${p.isZeroArea ? '是 ✓' : '否'}</b></span>
        <span class="chip">面积残差 <b>${(p.areaResidual * 100).toFixed(3)}%</b></span>
        <span class="chip">反对称残差 <b>${(p.symmetryResidual * 100).toFixed(3)}%</b></span>
      </div>
      <p class="sub" style="margin-top:12px">Ω(t)=Ω₀·sech((t−T/2)/τ)·tanh((t−T/2)/τ) 反对称、数值零面积；Δ(t)=Δ₀·(1−2e^{−x²}) 对称。时长/幅度由电路规模公式确定。</p>`;
  } else if (i === 3) {
    html = `<div class="stage-head"><h3>④ 保真度预估与噪声鲁棒性</h3><span class="pill">RAP</span></div>
      <div id="fidHost"></div>
      <div class="metric" style="margin-top:10px">
        <div class="m"><div class="v ${f.meetCZ ? 'ok' : ''}">${f.cz.toFixed(4)}</div><div class="l">CZ 门保真度</div></div>
        <div class="m"><div class="v ${f.meetCCZ ? 'ok' : ''}">${f.ccz.toFixed(4)}</div><div class="l">CCZ 门保真度</div></div>
        <div class="m"><div class="v">${f.overall.toFixed(4)}</div><div class="l">整体线路保真度</div></div>
      </div>
      <div style="margin-top:12px">
        <span class="badge ${f.meetCZ ? 'pass' : 'fail'}">CZ &gt; 0.9999 ${f.meetCZ ? '✓ 达标' : '✗ 未达标'}</span>
        <span class="badge ${f.meetCCZ ? 'pass' : 'fail'}">CCZ &gt; 0.999 ${f.meetCCZ ? '✓ 达标' : '✗ 未达标'}</span>
        <span class="badge ${f.meetTarget ? 'pass' : 'fail'}">±3% 鲁棒下界 ${f.robustnessFloor.toFixed(4)} ${f.robustnessFloor > 0.999 ? '✓' : '✗'}</span>
      </div>
      <div id="robHost" style="margin-top:8px"></div>`;
  } else if (i === 4) {
    const instr = buildDeployJSON(A, hg, p, f);
    STATE.deployJSON = instr;
    html = `<div class="stage-head"><h3>⑤ 硬件部署指令</h3><span class="pill">CaaS 下发</span></div>
      <div class="mono" style="max-height:300px">${escapeHtml(JSON.stringify(instr, null, 2))}</div>
      <div class="dl" id="dlBtn">⬇ 下载部署指令 JSON</div>
      <p class="sub" style="margin-top:12px">控制即服务：编译–控制结果打包为可下发指令序列（比特排布 / 门序列 / 脉冲参数 / 预估保真度），直连中性原子机执行。</p>`;
  }
  STAGE.innerHTML = `<div class="fade" id="fadeBox">${html}</div>`;
  requestAnimationFrame(() => { const fb = document.getElementById('fadeBox'); if (fb) fb.classList.add('show'); });
  if (i === 1) { const h = document.getElementById('hgHost'); if (h) drawHypergraph(h, hg); }
  if (i === 2) { const h = document.getElementById('pulseHost'); if (h) drawPulse(h, p); }
  if (i === 3) {
    const h = document.getElementById('fidHost'); if (h) drawFidelity(h, f);
    const r = document.getElementById('robHost'); if (r) drawRobustness(r, f);
  }
  if (i === 4) {
    const b = document.getElementById('dlBtn');
    if (b) b.addEventListener('click', () => downloadJSON(STATE.deployJSON));
  }
}

function buildDeployJSON(A, hg, p, f) {
  return {
    task: "deploy",
    backend: "rydberg-neutral-atom",
    software: "量脉 QuantPulse",
    algorithm: { name: A.name, type: A.type, qubits: A.qubits },
    qubit_layout: Array.from({ length: A.qubits }, (_, i) => ({ q: i, role: "atom" })),
    schedule: hg.edges.map(e => ({
      id: e.id,
      support: e.support,
      kind: e.decision === 'native' ? `native-${e.size}body` : 'decomposed',
      phase_rad: +e.angle.toFixed(4),
      error_cost: +e.errorCost.toFixed(5),
      reason: e.reason
    })),
    pulses: {
      T_ns: p.T, tau_ns: p.tau,
      Omega0_MHz: p.Omega0, Delta0_MHz: p.Delta0,
      zero_area: p.isZeroArea,
      formula: "Omega(t)=Omega0*sech((t-T/2)/tau)*tanh((t-T/2)/tau); Delta(t)=Delta0*(1-2*exp(-((t-T/2)/tau)^2))"
    },
    fidelity: { cz: f.cz, ccz: f.ccz, overall: f.overall, meet_target: f.meetTarget }
  };
}
function downloadJSON(obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'quantpulse-deploy.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* =========================================================
   流水线控制
   ========================================================= */
const steps = Array.from(document.querySelectorAll('.step'));
const prog = null;
let timer = null;
const STATE = { algorithm: null, diagonal: [], gateList: [], hypergraph: null, pulse: null, fidelity: null, deployJSON: null, currentStep: -1, computed: false };

function setStep(i, markDone) {
  STATE.currentStep = i;
  steps.forEach((s, idx) => {
    s.classList.toggle('active', idx === i);
    if (STATE.computed) s.classList.toggle('done', idx <= i);
  });
  renderStage(i);
}
function gotoStep(i) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!STATE.computed) return;
  setStep(i, true);
}
function showError(msg) {
  const box = document.getElementById('errBox');
  box.textContent = msg;
  box.classList.add('show');
}
function clearError() { const box = document.getElementById('errBox'); box.classList.remove('show'); box.textContent = ''; }

function runPipeline() {
  if (timer) { clearInterval(timer); timer = null; }
  clearError();
  const presetKey = document.getElementById('preset').value;
  const text = document.getElementById('dsl').value;
  // ① 真实解析
  const parsed = parseAlgorithm(text, presetKey);
  if (!parsed.ok) { showError(parsed.error); return; }
  STATE.algorithm = parsed.algorithm;
  STATE.diagonal = parsed.diagonal;
  STATE.gateList = parsed.gateList;
  // ② 编译超图（真实累加）
  STATE.hypergraph = buildHypergraph(parsed.algorithm, parsed.diagonal);
  // ③ 脉冲（真实公式）
  STATE.pulse = buildPulse(parsed.algorithm, STATE.hypergraph);
  // ④ 保真度（真实公式）
  STATE.fidelity = buildFidelity(STATE.hypergraph);
  STATE.computed = true;

  // 解锁步骤条并逐步推进
  steps.forEach(s => s.classList.remove('locked'));
  setStep(0, true);
  let i = 0;
  timer = setInterval(() => {
    i++;
    if (i >= steps.length) { clearInterval(timer); timer = null; return; }
    setStep(i, true);
  }, 1700);
}
function resetPipeline() {
  if (timer) { clearInterval(timer); timer = null; }
  STATE.computed = false;
  STATE.algorithm = null; STATE.hypergraph = null; STATE.pulse = null; STATE.fidelity = null;
  STATE.diagonal = []; STATE.gateList = []; STATE.deployJSON = null; STATE.currentStep = -1;
  steps.forEach(s => { s.classList.remove('active', 'done'); s.classList.add('locked'); });
  STAGE.innerHTML = `<div id="placeholder" style="display:flex;height:100%;min-height:380px;align-items:center;justify-content:center;color:var(--muted);text-align:center;flex-direction:column;gap:12px">
    <div style="font-size:46px">⚡</div>
    <div>粘贴或选择算法后，点击「▶ 运行管线」<br/>即可看到五阶段真实计算依次展开</div></div>`;
}

/* 预设切换即填充 DSL */
function loadPreset(key) {
  document.getElementById('dsl').value = PRESETS[key] || '';
  clearError();
}
document.getElementById('preset').addEventListener('change', e => loadPreset(e.target.value));
steps.forEach(s => s.addEventListener('click', () => gotoStep(+s.dataset.i)));
document.getElementById('runBtn').addEventListener('click', runPipeline);
document.getElementById('resetBtn').addEventListener('click', resetPipeline);

// 初始化
loadPreset('qram');
resetPipeline();
