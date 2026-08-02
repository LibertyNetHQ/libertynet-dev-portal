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

/**
 * How much prose a locale needs before it appears in the language menu.
 *
 * Every locale here is real: it routes, it has a translated interface, and its
 * untranslated pages fall back to English with a notice. But offering eleven
 * options when nine of them lead to English prose makes the menu a promise the
 * site does not keep — the reader picks 日本語 and gets English, and finds that
 * out one page at a time.
 *
 * So the menu lists the locales that have translated prose beyond the single
 * entry page. Nine of the ten non-English locales have exactly the quickstart
 * translated; a tenth has seven pages. That is the line, and it is a count of
 * files rather than a hand-maintained list: translate a second page in a locale
 * and it returns to the menu on the next build, with nobody editing anything.
 *
 * The others stay reachable by URL, stay in `hreflang`, and stay listed with
 * their real coverage on /translations, which is where a contributor looks for
 * something to claim. Removing them from a dropdown is not removing them.
 */
export const MENU_MIN_TRANSLATED_PAGES = 2;

/**
 * Locales to offer in the menu, given a `code → translated page count` map.
 *
 * `current` is always included even when it is below the line: a reader who
 * arrived at /ja must be able to see which language they are in and switch out
 * of it. A menu that hides the page you are on is worse than a long menu.
 */
export function menuLocales(counts, current = DEFAULT_LOCALE) {
  return LOCALES.filter(
    (l) =>
      l.code === DEFAULT_LOCALE ||
      l.code === current ||
      (counts[l.code] ?? 0) >= MENU_MIN_TRANSLATED_PAGES,
  );
}

/** Cookie remembering a manual choice — cookie, not localStorage, per the Console. */
export const LOCALE_COOKIE = "LN_LOCALE";

export const byCode = Object.fromEntries(LOCALES.map((l) => [l.code, l]));

export function isRtl(code) {
  return byCode[code]?.dir === "rtl";
}
