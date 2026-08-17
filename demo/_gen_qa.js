const fs = require('fs');
const vm = require('vm');

// ---- minimal DOM mock so the script's top-level code can load without a browser ----
function mkEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, setAttribute() {},
    querySelectorAll: () => [], style: {}, dataset: {}, value: 'qram',
    set innerHTML(v) {}, get innerHTML() { return ''; },
    set textContent(v) {}, get textContent() { return ''; },
  };
}
global.document = {
  getElementById: () => mkEl(),
  querySelectorAll: () => [],
  createElementNS: () => mkEl(),
  createElement: () => mkEl(),
  body: mkEl(),
};
global.window = {};
global.requestAnimationFrame = () => {};
global.setInterval = () => 0;
global.clearInterval = () => {};
global.Blob = class {};
global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

const html = fs.readFileSync('F:/10万/yuansheng-frontend/demo/prototype.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- appended TEST CODE runs in the SAME lexical scope as the script, so it can
//      call the file's real functions/classes (parseAlgorithm, buildHypergraph,
//      buildPulse, buildFidelity, AntidiabaticPulse, PRESETS, ...) directly ----
const tests = `
(function () {
  const results = [];
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; results.push('  PASS  ' + name); }
    else { fail++; results.push('  FAIL  ' + name + '  -> ' + (detail || '')); }
  }
  function approxEq(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-9); }

  // run full pipeline on a preset/custom text, return all artifacts
  function pipe(text, key) {
    const p = parseAlgorithm(text, key);
    if (!p.ok) return { parseError: p.error };
    const hg = buildHypergraph(p.algorithm, p.diagonal);
    const pulse = buildPulse(p.algorithm, hg);
    const fid = buildFidelity(hg);
    return { p, hg, pulse, fid };
  }

  // ============ 1. DSL 解析: 三预设 ============
  for (const key of ['qram', 'qaoa', 'mb3']) {
    const r = pipe(PRESETS[key], key);
    check('parse[' + key + '] ok', !r.parseError, r.parseError);
    check('parse[' + key + '] qubits=' + r.p.algorithm.qubits, typeof r.p.algorithm.qubits === 'number' && r.p.algorithm.qubits > 0);
    check('parse[' + key + '] gateList non-empty', r.p.gateList.length > 0);
  }

  // QRAM 解析细节
  {
    const r = pipe(PRESETS.qram, 'qram');
    check('QRAM qubits==8', r.p.algorithm.qubits === 8, 'got ' + r.p.algorithm.qubits);
    check('QRAM gates==6', r.p.gateList.length === 6, 'got ' + r.p.gateList.length);
    check('QRAM type 多体对角', /多体对角/.test(r.p.algorithm.type), r.p.algorithm.type);
  }
  // QAOA 解析细节
  {
    const r = pipe(PRESETS.qaoa, 'qaoa');
    check('QAOA qubits==5', r.p.algorithm.qubits === 5, 'got ' + r.p.algorithm.qubits);
    check('QAOA gates==5', r.p.gateList.length === 5, 'got ' + r.p.gateList.length);
  }
  // 3-body 解析细节
  {
    const r = pipe(PRESETS.mb3, 'mb3');
    check('3body qubits==7', r.p.algorithm.qubits === 7, 'got ' + r.p.algorithm.qubits);
    check('3body gates==5', r.p.gateList.length === 5, 'got ' + r.p.gateList.length);
  }

  // ============ 2. DSL 解析: 自定义 DSL ============
  const CUSTOM = 'H q0\\nCZ q0 q1\\nRZ q2 0.7\\nCCZ q0 q1 q2';
  {
    const r = pipe(CUSTOM, 'custom');
    check('custom ok', !r.parseError, r.parseError);
    check('custom qubits==3', r.p.algorithm.qubits === 3, 'got ' + r.p.algorithm.qubits);
    check('custom gates==4', r.p.gateList.length === 4, 'got ' + r.p.gateList.length);
    check('custom type 多体对角电路', r.p.algorithm.type === '多体对角电路', r.p.algorithm.type);
    // RZ 0.7 角度应正确解析
    const rz = r.p.gateList.find(g => g.name === 'RZ');
    check('custom RZ angle==0.7', rz && approxEq(rz.angle, 0.7, 1e-12), rz && rz.angle);
  }

  // ============ 3. 相位超图: 累加/归一化/决策 (独立 oracle) ============
  // QRAM: 期望 6 超边, 5 原生 1 分解, 多体3, 原生多体2
  {
    const r = pipe(PRESETS.qram, 'qram');
    const hg = r.hg;
    check('QRAM edges==6', hg.edges.length === 6, 'got ' + hg.edges.length);
    check('QRAM nativeCount==5', hg.nativeCount === 5, 'got ' + hg.nativeCount);
    check('QRAM decomposeCount==1', hg.decomposeCount === 1, 'got ' + hg.decomposeCount);
    check('QRAM multiBodyCount==3', hg.multiBodyCount === 3, 'got ' + hg.multiBodyCount);
    check('QRAM nativeMultiBody==2', hg.nativeMultiBodyEdges === 2, 'got ' + hg.nativeMultiBodyEdges);
    check('QRAM czEq==11', hg.czEquivalentGates === 11, 'got ' + hg.czEquivalentGates);
    // 4-body 边 [0,1,2,3] 应判定 decompose
    const e4 = hg.edges.find(e => e.support.join(',') === '0,1,2,3');
    check('QRAM 4-body edge decomposed', e4 && e4.decision === 'decompose', e4 && e4.decision);
  }
  // 3-body: CP 0.25 + CCZ(pi) 在同一支撑集 [0,1,2] 应累加后归一化到 (-pi,pi]
  {
    const r = pipe(PRESETS.mb3, 'mb3');
    const hg = r.hg;
    check('3body edges==4', hg.edges.length === 4, 'got ' + hg.edges.length);
    check('3body nativeCount==4', hg.nativeCount === 4, 'got ' + hg.nativeCount);
    check('3body decomposeCount==0', hg.decomposeCount === 0, 'got ' + hg.decomposeCount);
    check('3body nativeMultiBody==3', hg.nativeMultiBodyEdges === 3, 'got ' + hg.nativeMultiBodyEdges);
    check('3body czEq==7', hg.czEquivalentGates === 7, 'got ' + hg.czEquivalentGates);
    const e = hg.edges.find(x => x.support.join(',') === '0,1,2');
    // 0.25 + pi = 3.39159 -> normalize: 3.39159 > pi => -2.8916
    check('3body [0,1,2] accumulated+normalized angle ~ -2.8916',
      e && approxEq(e.angle, 0.25 + Math.PI - 2 * Math.PI, 1e-4), e && e.angle);
  }

  // ============ 4. 脉冲: 零面积 & 对称 ============
  for (const key of ['qram', 'qaoa', 'mb3']) {
    const r = pipe(PRESETS[key], key);
    const p = r.pulse;
    check('pulse[' + key + '] isZeroArea', p.isZeroArea === true,
      'residual=' + (p.areaResidual));
    // PRD 期望 ~1e-13..1e-14；实测因 Ω(t) 解析奇函数+对称梯形积分, 残差更优 (≈1e-17)
    check('pulse[' + key + '] areaResidual 接近0 (实测≈1e-17, 优于预期1e-13)',
      p.areaResidual >= 0 && p.areaResidual < 1e-9,
      'residual=' + p.areaResidual);
    check('pulse[' + key + '] symmetryResidual small',
      p.symmetryResidual < 1e-9, 'sym=' + p.symmetryResidual);
    check('pulse[' + key + '] samples==200', p.samples === 200, 'got ' + p.samples);
  }

  // ============ 5. 保真度: 公式 + 三预设数值 + 达标 ============
  const EXPECT = {
    qram: { cz: '0.99993', ccz: '0.99913' },
    qaoa: { cz: '0.99995', ccz: '0.99935' },
    mb3:  { cz: '0.99994', ccz: '0.99917' },
  };
  for (const key of ['qram', 'qaoa', 'mb3']) {
    const r = pipe(PRESETS[key], key);
    const f = r.fid;
    check('FID[' + key + '] cz==' + EXPECT[key].cz, f.cz.toFixed(5) === EXPECT[key].cz,
      'got ' + f.cz.toFixed(5));
    check('FID[' + key + '] ccz==' + EXPECT[key].ccz, f.ccz.toFixed(5) === EXPECT[key].ccz,
      'got ' + f.ccz.toFixed(5));
    check('FID[' + key + '] meetCZ', f.meetCZ === true);
    check('FID[' + key + '] meetCCZ', f.meetCCZ === true);
    check('FID[' + key + '] robustnessFloor>0.999', f.robustnessFloor > 0.999,
      'floor=' + f.robustnessFloor);
    // 公式独立复算
    const expCz = +(0.99997 - 0.000004 * r.hg.czEquivalentGates).toFixed(5);
    const expCcz = +(0.99935 - 0.00006 * r.hg.nativeMultiBodyEdges - 0.00010 * r.hg.decomposeCount).toFixed(5);
    check('FID[' + key + '] formula cz matches', f.cz.toFixed(5) === expCz.toFixed(5),
      'file=' + f.cz.toFixed(5) + ' ora=' + expCz.toFixed(5));
    check('FID[' + key + '] formula ccz matches', f.ccz.toFixed(5) === expCcz.toFixed(5),
      'file=' + f.ccz.toFixed(5) + ' ora=' + expCcz.toFixed(5));
  }

  // 自定义 DSL 保真度公式复算
  {
    const r = pipe(CUSTOM, 'custom');
    const f = r.fid;
    const expCz = +(0.99997 - 0.000004 * r.hg.czEquivalentGates).toFixed(5);
    const expCcz = +(0.99935 - 0.00006 * r.hg.nativeMultiBodyEdges - 0.00010 * r.hg.decomposeCount).toFixed(5);
    check('custom formula cz', f.cz.toFixed(5) === expCz.toFixed(5),
      'file=' + f.cz.toFixed(5) + ' ora=' + expCz.toFixed(5));
    check('custom formula ccz', f.ccz.toFixed(5) === expCcz.toFixed(5),
      'file=' + f.ccz.toFixed(5) + ' ora=' + expCcz.toFixed(5));
  }

  // ============ 6. 边界: 大电路 CZ 跌破 0.9999 (等效2比特>=20) ============
  {
    // 20 条不同支撑集的 2-body 原生门 -> czEq=20 -> cz 应 < 0.9999
    let big = '';
    for (let i = 0; i < 20; i++) big += 'CZ q' + (2 * i) + ' q' + (2 * i + 1) + '\\n';
    const r = pipe(big, 'custom');
    check('big circuit parsed', !r.parseError, r.parseError);
    check('big circuit czEq==20', r.hg.czEquivalentGates === 20, 'got ' + r.hg.czEquivalentGates);
    check('big circuit CZ<0.9999 (跌破阈值)', r.fid.cz < 0.9999, 'cz=' + r.fid.cz.toFixed(5));
    // 边界精确点: 注意 buildFidelity 先 toFixed(5) 再用 cz>0.9999 判定。
    //   czEq=16 -> 0.999906 -> "0.99991" -> 达标; czEq=17 -> 0.999902 -> "0.99990" -> 未达标。
    //   即真实跌破点为 czEq>=17 (PRD 所述 "≥20" 为充分非必要条件, 仍成立)。
    let b16 = '', b17 = '', b18 = '';
    for (let i = 0; i < 16; i++) b16 += 'CZ q' + (2 * i) + ' q' + (2 * i + 1) + '\\n';
    for (let i = 0; i < 17; i++) b17 += 'CZ q' + (2 * i) + ' q' + (2 * i + 1) + '\\n';
    for (let i = 0; i < 18; i++) b18 += 'CZ q' + (2 * i) + ' q' + (2 * i + 1) + '\\n';
    const r16 = pipe(b16, 'custom'), r17 = pipe(b17, 'custom'), r18 = pipe(b18, 'custom');
    check('boundary czEq=16 cz=0.99991 达标', r16.fid.cz > 0.9999 && r16.fid.meetCZ, 'cz=' + r16.fid.cz.toFixed(5));
    check('boundary czEq=17 cz=0.99990 未达标', r17.fid.cz <= 0.9999 && !r17.fid.meetCZ, 'cz=' + r17.fid.cz.toFixed(5));
    check('boundary czEq=18 cz<=0.9999 (未达标)', r18.fid.cz <= 0.9999 && !r18.fid.meetCZ, 'cz=' + r18.fid.cz.toFixed(5));
    check('PRD所述 “≥20 必跌破” 成立 (czEq=20 已验)', r.fid.cz < 0.9999);
  }

  // ============ 7. 错误处理 (坏输入不白屏/不抛未捕获) ============
  function tryBad(text) {
    try { const r = parseAlgorithm(text, 'custom'); return r; }
    catch (e) { return { threw: String(e) }; }
  }
  {
    const a = tryBad('FOO q0');
    check('bad 未知门 FOO -> ok:false + 中文提示', a && a.ok === false && /未知门/.test(a.error || ''), JSON.stringify(a));
    const b = tryBad('RZ q0');
    check('bad 缺参数 RZ -> ok:false + 提示', b && b.ok === false && /相位角|缺少/.test(b.error || ''), JSON.stringify(b));
    const c = tryBad('');
    check('bad 空输入 -> ok:false + 提示', c && c.ok === false && /未解析|有效门/.test(c.error || ''), JSON.stringify(c));
    const d = tryBad('CZ q0');
    check('bad CZ 单比特 -> ok:false', d && d.ok === false, JSON.stringify(d));
    // 整批跑一遍 (含成功/失败) 确认无未捕获异常
    let noThrow = true;
    try {
      pipe(PRESETS.qram, 'qram');
      pipe(CUSTOM, 'custom');
      parseAlgorithm('FOO q0', 'custom');
      parseAlgorithm('', 'custom');
    } catch (e) { noThrow = false; results.push('  THREW ' + e); }
    check('no uncaught exceptions across batch', noThrow);
  }

  // ============ 汇总 ============
  console.log('\\n================ QA CHECK RESULTS ================');
  console.log(results.join('\\n'));
  console.log('==================================================');
  console.log('TOTAL ' + (pass + fail) + ' | PASS ' + pass + ' | FAIL ' + fail);
  if (fail > 0) { process.exitCode = 1; }
})();
`;

vm.runInThisContext(script + "\n" + tests);
