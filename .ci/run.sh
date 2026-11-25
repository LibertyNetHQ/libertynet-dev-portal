#!/usr/bin/env bash
#
# ln-ci 的配方。`tools/check-all.mjs` 自述是「the gate a pull request has to
# pass」，本文件做的只是把它跑起来所需的那几步装好 —— 不替它判断，也不替它
# 兜住失败：它的退出码就是本配方的退出码。
#
# 为什么需要这个文件而不是 package.json 里一个 test script：
#
#   1. 根目录 `npm ci` 不装 `sdk/typescript` 的依赖。少了它，`canonical parity`
#      会以 `Cannot find package '@noble/ed25519'` 失败，另外两个 sdk 套件
#      直接 skipped —— 三个套件红/跳，而原因与被测代码无关。
#   2. `browser smoke` 要真浏览器。缺二进制时 Playwright 的报错是
#      「Executable doesn't exist」，读起来像站点坏了，其实是机器没装。
#
# 两件都是「环境没齐」，不是「代码有问题」。配方把环境备齐，剩下的红就都是真红。
#
# 机器前置（ci-wdc2 已做，2026-11-25）：
#   sudo PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
#     npx --yes playwright@1.62.1 install --with-deps chromium
#   sudo chmod -R a+rX /opt/pw-browsers
#
# 实测基线（装齐依赖后，本仓当前 HEAD）：21 个套件 20 通过 / 1 失败，
# 唯一失败就是 browser smoke 缺浏览器。装上之后应为 21/21。

set -uo pipefail

PW_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PLAYWRIGHT_BROWSERS_PATH="$PW_PATH"

die_setup() {
    # 机器没装好 ≠ 测试失败。说清是哪一种，并给出该跑的命令。
    echo "::error:: 机器前置缺失：$1"
    echo "           这不是被测代码的问题。该跑的命令见本文件顶部注释。"
    exit 1
}

echo "=== 1/4 根目录依赖"
npm ci --no-audit --no-fund || die_setup "根目录 npm ci 失败"

echo "=== 2/4 sdk/typescript 依赖（canonical parity 与两个 sdk 套件需要）"
if [ -d sdk/typescript ]; then
    ( cd sdk/typescript && npm ci --no-audit --no-fund ) \
        || die_setup "sdk/typescript npm ci 失败"
else
    echo "    sdk/typescript 不存在，跳过"
fi

echo "=== 3/4 浏览器二进制"
if [ ! -d "$PW_PATH" ]; then
    die_setup "$PW_PATH 不存在（browser smoke 需要 Playwright 的 chromium）"
fi
echo "    $PW_PATH 就位：$(ls "$PW_PATH" 2>/dev/null | tr '\n' ' ')"

echo
echo "=== 4/4 完整质检闸：node tools/check-all.mjs"
echo "（它会把每一个失败的完整输出都打出来，不止第一个）"
echo
node tools/check-all.mjs
rc=$?
echo
echo "=== check-all 退出码 $rc ==="
exit $rc
