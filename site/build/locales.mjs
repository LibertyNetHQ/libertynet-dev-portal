/**
 * Locale registry for the documentation site.
 *
 * Mirrors `operator-console/i18n/config.ts` exactly — same codes, same order,
 * same RTL flag, same default. One vocabulary across the whole product: a reader
 * who picks 日本語 in the Console should not have to pick it differently here.
 *
 * Adding a language is: add an entry here, drop `site/i18n/<code>.json`, and
 * optionally translate pages under `docs-site/<code>/`. Nothing else changes —
 * untranslated pages fall back to English with a visible notice rather than
 * disappearing or, worse, silently showing stale content.
 */

export const LOCALES = [
  { code: "en",    label: "English",    dir: "ltr", intl: "en-US" },
  { code: "zh-CN", label: "简体中文",     dir: "ltr", intl: "zh-CN" },
  { code: "zh-TW", label: "繁體中文",     dir: "ltr", intl: "zh-TW" },
  { code: "ja",    label: "日本語",       dir: "ltr", intl: "ja-JP" },
  { code: "ko",    label: "한국어",       dir: "ltr", intl: "ko-KR" },
  { code: "es",    label: "Español",    dir: "ltr", intl: "es-ES" },
  { code: "pt",    label: "Português",  dir: "ltr", intl: "pt-BR" },
  { code: "de",    label: "Deutsch",    dir: "ltr", intl: "de-DE" },
  { code: "fr",    label: "Français",   dir: "ltr", intl: "fr-FR" },
  { code: "ar",    label: "العربية",     dir: "rtl", intl: "ar-SA" },
  { code: "hi",    label: "हिन्दी",       dir: "ltr", intl: "hi-IN" },
];

export const DEFAULT_LOCALE = "en";

/** Cookie remembering a manual choice — cookie, not localStorage, per the Console. */
export const LOCALE_COOKIE = "LN_LOCALE";

export const byCode = Object.fromEntries(LOCALES.map((l) => [l.code, l]));

export function isRtl(code) {
  return byCode[code]?.dir === "rtl";
}
