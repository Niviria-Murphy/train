# -*- coding: utf-8 -*-
"""
量脉 QuantPulse · 真实数值引擎单元测试（离线）
============================================
断言核心物理量与接受标准：
    * 真实 CZ 反绝热保真度 > 0.9999
    * 反绝热（含 CD）> 纯绝热
    * 零面积脉冲残差 ≈ 0
    * 真实 CCZ 保真度 > 0.999
    * 切比雪夫 AGP：反绝热 > 纯绝热，且近似误差极小
    * 噪声鲁棒性下界 > 0.999

运行：
    python test_engine.py
"""

import quantpulse_engine as Q

FAILED = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  ({detail})" if detail else ""))
    if not cond:
        FAILED.append(name)


def main():
    print("=" * 60)
    print(" 量脉 QuantPulse · 引擎自测")
    print("=" * 60)

    O, D, T = Q.DEFAULT_CZ["Omega0"], Q.DEFAULT_CZ["Delta0"], Q.DEFAULT_CZ["T"]

    # ---- 零面积脉冲 ----
    zr = Q.zero_area_residual(O, T, T / 4.2)
    check("零面积脉冲残差 ≈ 0", abs(zr) < 1e-9, f"residual={zr:.3e}")

    # ---- CZ 反绝热 vs 纯绝热 ----
    cz = Q.rap_cz_fidelity(O, D, T)
    check("CZ 反绝热保真度 > 0.9999", cz["cz_fidelity"] > 0.9999,
          f"cz={cz['cz_fidelity']:.6f}")
    check("反绝热 > 纯绝热", cz["cz_fidelity"] > cz["adiabatic_fidelity"],
          f"Δ={cz['improvement']:+.6f}")
    check("CZ ±涨落下界 > 0.9999", cz["lower_bound"] > 0.9999,
          f"lb={cz['lower_bound']:.6f}")

    # ---- CCZ ----
    ccz = Q.ccz_fidelity(O, D, T, three_body_penalty=1.5e-4)
    check("CCZ 反绝热保真度 > 0.999", ccz["ccz_fidelity"] > 0.999,
          f"ccz={ccz['ccz_fidelity']:.6f}")
    check("CCZ 反绝热 > 纯绝热", ccz["ccz_fidelity"] > ccz["adiabatic_fidelity"],
          f"Δ={ccz['improvement']:+.6f}")

    # ---- 切比雪夫 AGP ----
    agp = Q.chebyshev_agp(tau=35.0, d=24, gamma=0.05)
    check("AGP 反绝热 > 纯绝热", agp["fidelity_antiadiabatic"] > agp["fidelity_adiabatic"],
          f"Δ={agp['improvement']:+.6f}")
    check("AGP 切比雪夫近似误差极小", agp["approx_error"] < 1e-3,
          f"err={agp['approx_error']:.2e}")

    # ---- 噪声鲁棒性 ----
    rob = Q.noise_robustness(O, D, T)
    check("噪声鲁棒性下界 > 0.999", rob["floor"] > 0.999,
          f"floor={rob['floor']:.6f}")

    # ---- 8 维三原子校验（独立一致性） ----
    ccz8 = Q.ccz_full8_fidelity(O, D, T)
    check("CCZ 8 维演化校验 > 0.85（量级一致）", ccz8 > 0.85,
          f"ccz8={ccz8:.6f}")

    print("=" * 60)
    if FAILED:
        print(f"结果：{len(FAILED)} 项未通过 -> {FAILED}")
        raise SystemExit(1)
    print("结果：全部通过 ✓")


if __name__ == "__main__":
    main()
