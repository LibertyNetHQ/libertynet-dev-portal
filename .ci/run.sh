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
#   3. `published artifacts` 与 `implemented audit` 都要 `mcp/libertynet-mcp.mjs`
#      存在，而产出它的是 check-all 里**更靠后**的那个 `mcp bundle build` 套件。
#      全新 checkout 上这两个套件必然先红 —— 这是顺序依赖，不是代码坏。
#
# 三件都是「环境没齐」，不是「代码有问题」。配方把环境备齐，剩下的红就都是真红。
#
# 机器前置（ci-wdc2 已做，2026-11-25）：
#   sudo PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
#     npx --yes playwright@1.62.1 install --with-deps chromium
#   sudo chmod -R a+rX /opt/pw-browsers
#
# 实测基线（全新 clone，严格无残留状态）：
#   只装根目录依赖                      → 3 红 2 跳
#   + sdk/typescript 依赖               → 1 红（browser smoke 缺浏览器）
#   + chromium，但不先建 bundle          → 2 of 23 failed（就是第 3 条）
#   + 先建 bundle                        → ✓ all 23 suites passed，退出码 0
#
# 第 3 条是本配方第一版漏掉的，而且漏的方式值得写下来：本地验证时我连跑了两次
# check-all，第一次里 `mcp bundle build` 把产物留在磁盘上，第二次才全绿 ——
# 那个「全绿」是被上一次的状态污染出来的。ci-wdc2 首跑立刻红，复现靠的是
# 一个全新 clone。教训：验证一道闸必须在干净检出上跑，连跑两次不算。

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

echo "=== 3/5 浏览器二进制"
if [ ! -d "$PW_PATH" ]; then
    die_setup "$PW_PATH 不存在（browser smoke 需要 Playwright 的 chromium）"
fi
echo "    $PW_PATH 就位：$(ls "$PW_PATH" 2>/dev/null | tr '\n' ' ')"

echo "=== 4/5 先建 MCP bundle（published artifacts / implemented audit 依赖它）"
node tools/bundle-mcp.mjs || die_setup "tools/bundle-mcp.mjs 失败，产物建不出来"

echo
echo "=== 5/5 完整质检闸：node tools/check-all.mjs"
echo "（它会把每一个失败的完整输出都打出来，不止第一个）"
echo
node tools/check-all.mjs
rc=$?
echo
echo "=== check-all 退出码 $rc ==="
exit $rc
