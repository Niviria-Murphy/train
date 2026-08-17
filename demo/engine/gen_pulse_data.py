# -*- coding: utf-8 -*-
"""
gen_pulse_data.py — 量脉 QuantPulse 离线数据生成与注入
======================================================

运行真实数值引擎（quantpulse_engine.py），对 3 个预设电路（QRAM / QAOA-MaxCut /
3-body CCZ）做 *真实* 薛定谔演化，得到权威的 CZ/CCZ 保真度、反绝热提升、零面积
残差、噪声鲁棒下界与脉冲采样；并与网页 prototype.html 内 JS 简化模型做对照
（JS 为闭式理想估值，真实演化给出物理上更保守、更诚实的数值）。

产出：
  * pulse_data.json            —— 权威数据（供下载 / 透明审阅）
  * fidelity_compare.svg       —— 传统绝热 vs 反绝热 RAP 对比图（手写 SVG）
  * 内联注入 prototype.html    —— 真实数值引擎背书区 + 内联对比 SVG / 关键数值
                                （仅注入内联 JSON/SVG，保持单文件、零外部依赖、双击即开）

运行：
  C:\\Users\\Lenovo\\workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe gen_pulse_data.py
"""

from __future__ import annotations

import json
import os
import datetime

import numpy as np
import quantpulse_engine as q

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO_DIR = os.path.abspath(os.path.join(HERE, "..", "demo"))
HTML_PATH = os.path.join(DEMO_DIR, "prototype.html")
OUT_JSON = os.path.join(HERE, "pulse_data.json")
OUT_SVG = os.path.join(HERE, "fidelity_compare.svg")

# ---------------------------------------------------------------------------
# 复刻网页 JS 模型（与 prototype.html 内的 PRESETS / buildPulse / buildFidelity
# 完全一致），用于拿到 *精确* 的脉冲参数与 JS 保真度，做诚实对照。
# ---------------------------------------------------------------------------
PRESETS = {
    "qram": """// QRAM 地址→数据 多体对角编码
CP 0.30 q0 q1
CP 0.50 q2 q3
CP 0.20 q1 q2 q3
CP 0.40 q0 q1 q2 q3
CP 0.10 q4 q5
CP 0.15 q5 q6 q7""",
    "qaoa": """// QAOA-MaxCut 代价哈密顿量对角项
RZZ 0.35 q0 q1
RZZ 0.35 q1 q2
RZZ 0.35 q2 q0
RZZ 0.20 q0 q3
RZZ 0.20 q3 q4""",
    "mb3": """// 3 体对角线路
CP 0.25 q0 q1 q2
CP 0.40 q3 q4 q5
CCZ q0 q1 q2
CZ q4 q5
CP 0.12 q2 q4 q6""",
}
PRESET_META = {
    "qram": "QRAM 地址编码电路",
    "qaoa": "QAOA-MaxCut 电路",
    "mb3": "3 体对角线路",
}
NATIVE_THRESHOLD = 0.0016  # 多体原生门误差代价阈值（与 JS 一致）


def _try_parse_angle(tok: str):
    try:
        v = eval(tok.replace("pi", "3.141592653589793"), {"__builtins__": {}}, {})
        return float(v) if isinstance(v, (int, float)) else None
    except Exception:
        return None


def parse_to_edges(dsl_text: str):
    """复刻 JS parseAlgorithm + buildHypergraph：返回相位超边列表。"""
    diagonals = []
    for line in dsl_text.split("\n"):
        line = line.split("//")[0].strip()
        if not line:
            continue
        toks = line.split()
        name = toks[0].upper()
        qargs, angle = [], None
        for t in toks[1:]:
            import re
            m = re.match(r"^q?(\d+)$", t)
            if m:
                qargs.append(int(m.group(1)))
            else:
                a = _try_parse_angle(t)
                if a is not None:
                    angle = a
        if name in ("RZ", "P"):
            diagonals.append((tuple(sorted(qargs)), angle, name))
        elif name == "Z":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793, "Z"))
        elif name == "S":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793 / 2, "S"))
        elif name == "T":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793 / 4, "T"))
        elif name == "CZ":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793, "CZ"))
        elif name == "RZZ":
            diagonals.append((tuple(sorted(qargs)), angle, "RZZ"))
        elif name in ("CP", "CPHASE"):
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793 if angle is None else angle, "CP"))
        elif name == "CCZ":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793, "CCZ"))
        elif name == "CCP":
            diagonals.append((tuple(sorted(qargs)), 3.141592653589793 if angle is None else angle, "CCP"))
        # 非对角门（H/X/...）无对角相位项，忽略

    acc = {}
    for sup, ang, gate in diagonals:
        key = ",".join(str(x) for x in sup)
        if key not in acc:
            acc[key] = {"support": sup, "angle": 0.0, "gates": []}
        acc[key]["angle"] += ang
        acc[key]["gates"].append(gate)

    edges = []
    for e in acc.values():
        s = len(e["support"])
        if s <= 2:
            cost = 0.0008 * (s - 1)
        else:
            cost = 0.0014 + 0.0012 * (s - 3)
        decision = "native" if s <= 2 or cost <= NATIVE_THRESHOLD else "decompose"
        edges.append({
            "support": e["support"], "size": s, "cost": cost,
            "decision": decision, "is_multi": s >= 3,
        })
    edges.sort(key=lambda e: (e["size"], ",".join(map(str, e["support"]))))
    return edges


def build_pulse_params(edges):
    """复刻 JS buildPulse：返回 (T, tau, Omega0, Delta0)。"""
    n_edges = len(edges)
    n_multi = sum(1 for e in edges if e["is_multi"])
    T = round(120 + 10 * n_edges + 14 * n_multi)
    tau = max(18, round(T / 4.2))
    omega0 = round(6.0 + 0.18 * n_edges, 2)
    delta0 = round(1.6 * omega0, 2)
    return T, tau, omega0, delta0


def js_fidelity(edges):
    """复刻 JS buildFidelity：返回 (cz_js, ccz_js, cz_eq, native_mb, dec)。"""
    cz_eq = 0
    for e in edges:
        s = e["size"]
        if s <= 2:
            cz_eq += 1
        elif e["decision"] == "native":
            cz_eq += (s - 1)
        else:
            cz_eq += (s - 1) + 1
    native_mb = sum(1 for e in edges if e["is_multi"] and e["decision"] == "native")
    dec = sum(1 for e in edges if e["decision"] == "decompose")
    cz_js = round(0.99997 - 0.000004 * cz_eq, 5)
    ccz_js = round(0.99935 - 0.00006 * native_mb - 0.00010 * dec, 5)
    return cz_js, ccz_js, cz_eq, native_mb, dec


def sample_pulse(T, tau, omega0, delta0, n=200):
    """采样 Ω(t)/Δ(t)（与网页 JS 模型同形）。"""
    t = np.linspace(0.0, T, n)
    return {
        "t": [round(float(x), 3) for x in t],
        "omega": [round(float(q.rabi(x, T, tau, omega0)), 4) for x in t],
        "delta": [round(float(q.detune(x, T, tau, delta0)), 4) for x in t],
    }


# ---------------------------------------------------------------------------
# 手写 SVG 对比图：传统绝热 vs 反绝热 RAP（含切比雪夫 AGP 组）
# ---------------------------------------------------------------------------
def build_comparison_svg(groups, threshold=0.999, W=620, H=340):
    """groups: [{"name":str,"bars":[{"label","value","color"}]}, ...]"""
    ymin, ymax = 0.80, 1.002
    pad_l, pad_r, pad_t, pad_b = 46, 18, 26, 54

    def my(v):
        return pad_t + (ymax - v) / (ymax - ymin) * (H - pad_t - pad_b)

    svg = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
           f'role="img" aria-label="传统绝热 vs 反绝热 RAP 保真度对比">']
    # 阈值线
    svg.append(f'<line x1="{pad_l}" y1="{my(threshold):.1f}" x2="{W-pad_r}" y2="{my(threshold):.1f}" '
               f'stroke="#3ddc97" stroke-width="1.5" stroke-dasharray="6 4"/>')
    svg.append(f'<text x="{W-pad_r}" y="{my(threshold)-6:.1f}" fill="#3ddc97" font-size="11" '
               f'text-anchor="end" font-family="sans-serif">达标阈值 {threshold}</text>')
    # y 轴刻度
    for v in (0.85, 0.90, 0.95, 1.0):
        svg.append(f'<line x1="{pad_l}" y1="{my(v):.1f}" x2="{W-pad_r}" y2="{my(v):.1f}" '
                   f'stroke="rgba(255,255,255,.08)" stroke-width="1"/>')
        svg.append(f'<text x="{pad_l-6}" y="{my(v)+4:.1f}" fill="#9aa6c4" font-size="10" '
                   f'text-anchor="end" font-family="sans-serif">{v:.2f}</text>')
    # 分组柱
    n_g = len(groups)
    gw = (W - pad_l - pad_r) / n_g
    bw = 56
    for gi, g in enumerate(groups):
        gx = pad_l + gi * gw + gw / 2
        svg.append(f'<text x="{gx:.1f}" y="{H-pad_b+20:.1f}" fill="#e8ecf6" font-size="12" '
                   f'text-anchor="middle" font-weight="700" font-family="sans-serif">{g["name"]}</text>')
        nb = len(g["bars"])
        total = nb * bw + (nb - 1) * 16
        x0 = gx - total / 2
        for bi, bar in enumerate(g["bars"]):
            x = x0 + bi * (bw + 16)
            y = my(bar["value"])
            h = H - pad_b - y
            svg.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw}" height="{max(h,0):.1f}" '
                       f'rx="6" fill="{bar["color"]}"/>')
            svg.append(f'<text x="{x+bw/2:.1f}" y="{y-8:.1f}" fill="#e8ecf6" font-size="13" '
                       f'text-anchor="middle" font-weight="700" font-family="sans-serif">{bar["value"]:.4f}</text>')
            svg.append(f'<text x="{x+bw/2:.1f}" y="{H-pad_b+38:.1f}" fill="#9aa6c4" font-size="11" '
                       f'text-anchor="middle" font-family="sans-serif">{bar["label"]}</text>')
    svg.append('</svg>')
    return "".join(svg)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    print("=" * 68)
    print(" 量脉 QuantPulse · 离线数据生成（真实数值引擎）")
    print("=" * 68)

    # 1) 高保真反绝热工作区（DEFAULT_CZ：Δ0/Ω0≈3，gap 主导，CD 驱动无差）
    hf = q.DEFAULT_CZ
    cz = q.rap_cz_fidelity(hf["Omega0"], hf["Delta0"], hf["T"])
    cc = q.ccz_fidelity(hf["Omega0"], hf["Delta0"], hf["T"])
    hf_demo = {
        "params": {"Omega0": hf["Omega0"], "Delta0": hf["Delta0"], "T": hf["T"],
                   "tau": round(hf["T"] / 4.2, 1)},
        "cz_fidelity": round(cz["cz_fidelity"], 6),
        "adiabatic_fidelity": round(cz["adiabatic_fidelity"], 6),
        "improvement": round(cz["improvement"], 6),
        "lower_bound": round(cz["lower_bound"], 6),
        "zero_area_residual": float(cz["zero_area_residual"]),
        "ccz_fidelity": round(cc["ccz_fidelity"], 6),
        "ccz_lower_bound": round(cc["lower_bound"], 6),
        "pulse_samples": sample_pulse(hf["T"], round(hf["T"] / 4.2), hf["Omega0"], hf["Delta0"]),
    }
    print(f"[高保真] CZ={hf_demo['cz_fidelity']:.6f}  传统绝热={hf_demo['adiabatic_fidelity']:.6f}  "
          f"提升={hf_demo['improvement']:+.6f}  CCZ={hf_demo['ccz_fidelity']:.6f}  零面积={hf_demo['zero_area_residual']:.2e}")

    # 2) 切比雪夫 AGP 演示（Omega0=6, Delta0=18, tau=35, d=24, gamma=0.05）
    agp = q.chebyshev_agp(tau=35.0, d=24, gamma=0.05, Omega0=6.0, Delta0=18.0, T=140.0)
    agp_demo = {
        "tau": agp["params"]["tau"], "N": agp["params"]["N"], "gamma": agp["params"]["gamma"],
        "fidelity_adiabatic": round(agp["fidelity_adiabatic"], 6),
        "fidelity_antiadiabatic": round(agp["fidelity_antiadiabatic"], 6),
        "improvement": round(agp["improvement"], 6),
        "agp_norm": round(agp["agp_norm"], 4),
        "approx_error": float(agp["approx_error"]),
    }
    print(f"[AGP   ] 传统绝热={agp_demo['fidelity_adiabatic']:.6f}  反绝热={agp_demo['fidelity_antiadiabatic']:.6f}  "
          f"提升={agp_demo['improvement']:+.6f}  切比雪夫误差={agp_demo['approx_error']:.2e}")

    # 3) 三预设：真实演化 vs JS 简化模型
    presets_out = {}
    print("-" * 68)
    for key in ("qram", "qaoa", "mb3"):
        edges = parse_to_edges(PRESETS[key])
        T, tau, omega0, delta0 = build_pulse_params(edges)
        cz_js, ccz_js, cz_eq, native_mb, dec = js_fidelity(edges)

        rcz = q.rap_cz_fidelity(omega0, delta0, T)
        rcc = q.ccz_fidelity(omega0, delta0, T)
        rnoise = q.noise_robustness(omega0, delta0, T)

        cz_real = round(rcz["cz_fidelity"], 6)
        ccz_real = round(rcc["ccz_fidelity"], 6)

        presets_out[key] = {
            "name": PRESET_META[key],
            "params": {"Omega0": omega0, "Delta0": delta0, "T": T, "tau": tau,
                       "ratio": round(delta0 / omega0, 3)},
            "cz_real": cz_real,
            "cz_adiabatic": round(rcz["adiabatic_fidelity"], 6),
            "cz_improvement": round(rcz["improvement"], 6),
            "cz_lower_bound": round(rcz["lower_bound"], 6),
            "ccz_real": ccz_real,
            "ccz_lower_bound": round(rcc["lower_bound"], 6),
            "zero_area_residual": float(rcz["zero_area_residual"]),
            "robustness_floor": round(rnoise["floor"], 6),
            "cz_js": cz_js,
            "ccz_js": ccz_js,
            "cz_eq": cz_eq,
            "deviation_cz": round(cz_real - cz_js, 5),
            "deviation_ccz": round(ccz_real - ccz_js, 5),
            "pulse_samples": sample_pulse(T, tau, omega0, delta0),
        }
        print(f"[{key:5s}] 参数 Ω0={omega0} Δ0={delta0}(比{delta0/omega0:.1f}) T={T}")
        print(f"         CZ 真实={cz_real:.6f}  JS={cz_js:.5f}  偏差={cz_real-cz_js:+.5f}")
        print(f"         CCZ 真实={ccz_real:.6f} JS={ccz_js:.5f}  偏差={ccz_real-ccz_js:+.5f}")

    # 4) 对比图（传统绝热 vs 反绝热 RAP / AGP）
    chart = {
        "threshold": 0.999,
        "groups": [
            {"name": "CZ 门 · 反绝热 RAP", "bars": [
                {"label": "传统绝热", "value": hf_demo["adiabatic_fidelity"], "color": "#9aa6c4"},
                {"label": "反绝热 RAP", "value": hf_demo["cz_fidelity"], "color": "#3ddc97"},
            ]},
            {"name": "切比雪夫 AGP", "bars": [
                {"label": "传统绝热", "value": agp_demo["fidelity_adiabatic"], "color": "#9aa6c4"},
                {"label": "反绝热 AGP", "value": agp_demo["fidelity_antiadiabatic"], "color": "#4fd6e0"},
            ]},
        ],
    }
    svg_str = build_comparison_svg(chart["groups"], chart["threshold"])
    with open(OUT_SVG, "w", encoding="utf-8") as f:
        f.write(svg_str)
    print(f"\n[写出] {OUT_SVG}")

    # 5) 汇总 JSON
    data = {
        "meta": {
            "engine": "quantpulse_engine.py",
            "method": ("真实薛定谔演化（矩阵指数中点传播 U=∏expm(−iH·dt)）"
                       " + 局域精确对易-无差（CD）反绝热项；切比雪夫级数逼近 AGP 中 1/ω² 奇异项"),
            "python": "3.13.12", "numpy": np.__version__,
            "units": "Rabi/失谐幅度单位 MHz；哈密顿量内部换算为 ns^-1（ω[rad/ns]=2π·f[MHz]·1e-3）",
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "regime_note": ("网页 JS 模型用 Δ0≈1.6·Ω0 的闭式理想估值（CZ≈0.9999）；"
                           "真实演化在该比下受失谐零交叉导致的非绝热泄漏限制（CZ≈0.93–0.98）。"
                           "在 gap 主导区 Δ0≈3·Ω0 用反绝热 CD 驱动可达 CZ>0.9999、CCZ>0.999。"),
        },
        "high_fidelity_demo": hf_demo,
        "agp": agp_demo,
        "presets": presets_out,
        "chart": chart,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[写出] {OUT_JSON}")

    # 6) 内联注入 prototype.html（单文件、零外部依赖）
    inject_into_html(HTML_PATH, data, svg_str)
    print("=" * 68)
    print("完成：数据已生成并内联注入 prototype.html（仍为单文件、零依赖、双击即开）。")


def inject_into_html(html_path, data, svg_str):
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 所有已知注入标记（含旧版 PYTHON_ENGINE_ENDORSEMENT）。运行前先移除任何
    # 既有 Python 注入区块（从标记到其后的 </script> 闭合标签），保证幂等、
    # 不残留重复区块、锚点名与团队要求一致（QUANTPULSE_PYTHON_DATA）。
    _known_markers = [
        "<!-- QUANTPULSE_PYTHON_DATA -->",
        "<!-- PYTHON_ENGINE_ENDORSEMENT -->",
    ]
    for _mk in _known_markers:
        if _mk in html:
            _start = html.index(_mk)
            _end = html.index("</script>", _start) + len("</script>")
            html = html[:_start] + html[_end:]
    marker = "<!-- QUANTPULSE_PYTHON_DATA -->"

    hf = data["high_fidelity_demo"]
    agp = data["agp"]
    p = data["presets"]
    metrics_html = "".join([
        _chip("CZ 反绝热", f"{hf['cz_fidelity']:.6f}", True),
        _chip("CZ 传统绝热", f"{hf['adiabatic_fidelity']:.6f}", False),
        _chip("反绝热提升", f"{hf['improvement']:+.5f}", True),
        _chip("CCZ 反绝热", f"{hf['ccz_fidelity']:.6f}", True),
        _chip("±涨落下界", f"{hf['lower_bound']:.6f}", True),
        _chip("零面积残差", f"{hf['zero_area_residual']:.1e}", True),
        _chip("AGP 反绝热", f"{agp['fidelity_antiadiabatic']:.6f}", False),
        _chip("AGP 近似误差", f"{agp['approx_error']:.1e}", True),
    ])

    rows = "".join(
        f"<tr><td>{p[k]['name']}</td>"
        f"<td>{p[k]['params']['Omega0']}/{p[k]['params']['Delta0']} (×{p[k]['params']['ratio']})</td>"
        f"<td>{p[k]['cz_real']:.4f}</td><td>{p[k]['cz_js']:.4f}</td>"
        f"<td class=\"{'ok' if p[k]['deviation_cz']<0 else ''}\">{p[k]['deviation_cz']:+.4f}</td>"
        f"<td>{p[k]['ccz_real']:.4f}</td><td>{p[k]['ccz_js']:.4f}</td></tr>"
        for k in ("qram", "qaoa", "mb3")
    )
    table_html = (
        "<table style='width:100%;border-collapse:collapse;margin-top:10px;font-size:12px'>"
        "<thead><tr style='color:#9aa6c4;text-align:left'>"
        "<th>预设</th><th>Ω0/Δ0(比)</th><th>CZ真实</th><th>CZ(JS)</th><th>偏差</th>"
        "<th>CCZ真实</th><th>CCZ(JS)</th></tr></thead><tbody>" + rows +
        "</tbody></table>"
    )

    cz_real_min = min(p[k]["cz_real"] for k in ("qram", "qaoa", "mb3"))
    cz_real_max = max(p[k]["cz_real"] for k in ("qram", "qaoa", "mb3"))
    note = ("真实演化（Python/numpy/scipy）在高保真反绝热工作区（Δ₀≈3Ω₀）给出 "
            "CZ=%.5f、CCZ=%.5f，且反绝热较传统绝热提升 +%.4f。网页 JS 模型在 Δ₀≈1.6Ω₀ 下"
            "以闭式理想估值给出 CZ≈0.9999，但真实演化受失谐零交叉的非绝热泄漏限制"
            "（预设电路真实 CZ≈%.3f–%.3f）。二者差异属物理真实差异，非凑数：反绝热 CD 驱动"
            "正是为抑制此类泄漏而设计。"
            % (hf["cz_fidelity"], hf["ccz_fidelity"], hf["improvement"], cz_real_min, cz_real_max))

    json_escaped = json.dumps(data, ensure_ascii=False)

    section = f"""
{marker}
<section class="wrap" id="pythonEngineSection" style="margin-top:30px">
  <div class="sec-title">权威真实数值校验 · Python 离线反绝热引擎</div>
  <div class="sec-sub">以下数据由 Python（numpy / scipy）离线真实薛定谔演化算出，<b>内联注入</b>本页；
    网页自身仍是单文件、零外部依赖、双击即开（浏览器不运行 numpy）。自定义 DSL 交互仍由网页 JS 模型负责。</div>
  <div class="badge pass">✓ 真实数值引擎背书 · 非预设动画</div>
  <div class="split2" style="margin-top:16px">
    <div class="card">
      <div class="layer" style="color:var(--orange)">传统绝热 vs 反绝热 RAP · CZ 保真度对比</div>
      <div class="pychart">{svg_str}</div>
      <div class="legend">
        <span><i style="background:#9aa6c4"></i>传统绝热（无 CD）</span>
        <span><i style="background:#3ddc97"></i>反绝热 RAP（含 CD）</span>
        <span><i style="background:#4fd6e0"></i>切比雪夫 AGP</span>
      </div>
    </div>
    <div class="card">
      <div class="layer" style="color:var(--cyan)">关键真实数值（高保真工作区 Δ₀≈3Ω₀）</div>
      <div class="metric">{metrics_html}</div>
      <p class="sub" style="margin-top:12px">{note}</p>
    </div>
  </div>
  <div class="card" style="margin-top:18px">
    <div class="layer" style="color:var(--purple2)">三预设 · 真实演化 vs 网页 JS 简化模型</div>
    {table_html}
    <p class="sub" style="margin-top:10px">偏差 = 真实演化 − JS 估值。JS 为闭式理想上限；真实数值含非绝热泄漏与噪声涨落下界，更为保守诚实。</p>
  </div>
</section>
<script>const PYTHON_PULSE_DATA = {json_escaped};</script>
"""
    html = html.replace("</body>", section + "\n</body>", 1)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[注入] {html_path}（内联 SVG + JSON，单文件零依赖）")


def _chip(label, value, ok):
    cls = "ok" if ok else ""
    return (f'<div class="m"><div class="v {cls}">{value}</div>'
            f'<div class="l">{label}</div></div>')


if __name__ == "__main__":
    main()
