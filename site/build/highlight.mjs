/**
 * Syntax highlighting, dependency-free.
 *
 * Deliberately small: a docs site that pulls a 200 KB highlighter to colour six
 * languages has made a bad trade. This covers what actually appears in these
 * docs — bash, json, js/ts, python, yaml — and degrades to plain escaped text for
 * anything else rather than mangling it.
 *
 * The token classes map onto the palette in `theme.css`, where every colour was
 * measured for contrast against the code background.
 */

const COMMON = {
  js: {
    keywords:
      "await async break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield as satisfies interface type enum implements readonly declare namespace",
    literals: "true false null undefined NaN Infinity",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    strings: ["'", '"', "`"],
  },
  python: {
    keywords:
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    literals: "True False None self cls",
    lineComment: "#",
    blockComment: null,
    strings: ["'", '"'],
  },
  bash: {
    keywords:
      "if then else elif fi for while do done case esac function return in select until export local readonly declare set unset source eval exec trap shift break continue",
    literals: "true false",
    lineComment: "#",
    blockComment: null,
    strings: ["'", '"'],
  },
  json: {
    keywords: "",
    literals: "true false null",
    lineComment: null,
    blockComment: null,
    strings: ['"'],
  },
  yaml: {
    keywords: "",
    literals: "true false null yes no on off",
    lineComment: "#",
    blockComment: null,
    strings: ["'", '"'],
  },
};

const ALIASES = {
  javascript: "js",
  jsx: "js",
  typescript: "js",
  ts: "js",
  tsx: "js",
  mjs: "js",
  node: "js",
  py: "python",
  sh: "bash",
  shell: "bash",
  console: "bash",
  zsh: "bash",
  yml: "yaml",
  curl: "bash",
};

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(cls, text) {
  return `<span class="t-${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Tokenise one line at a time.
 *
 * Line-based rather than a full parser: it cannot get multi-line strings exactly
 * right, but it also cannot run away and mis-colour an entire file after one
 * unbalanced quote — which is the failure mode that actually hurts a reader.
 */
export function highlight(code, lang) {
  const key = ALIASES[lang] ?? lang;
  const rules = COMMON[key];

  if (!rules) return escapeHtml(code);

  const keywords = new Set(rules.keywords.split(/\s+/).filter(Boolean));
  const literals = new Set(rules.literals.split(/\s+/).filter(Boolean));

  let out = "";
  let inBlockComment = false;

  for (const line of code.split("\n")) {
    let i = 0;
    let buffer = "";

    const flush = () => {
      if (!buffer) return;
      if (keywords.has(buffer)) out += span("kw", buffer);
      else if (literals.has(buffer)) out += span("lit", buffer);
      else if (/^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(buffer)) out += span("num", buffer);
      else out += escapeHtml(buffer);
      buffer = "";
    };

    while (i < line.length) {
      const rest = line.slice(i);

      if (inBlockComment) {
        const end = rest.indexOf(rules.blockComment[1]);
        if (end === -1) {
          out += span("cmt", rest);
          i = line.length;
        } else {
          out += span("cmt", rest.slice(0, end + 2));
          i += end + 2;
          inBlockComment = false;
        }
        continue;
      }

      if (rules.blockComment && rest.startsWith(rules.blockComment[0])) {
        flush();
        inBlockComment = true;
        continue;
      }

      if (rules.lineComment && rest.startsWith(rules.lineComment)) {
        flush();
        out += span("cmt", rest);
        i = line.length;
        continue;
      }

      const quote = rules.strings.find((q) => rest.startsWith(q));
      if (quote) {
        flush();
        let j = 1;
        while (j < rest.length) {
          if (rest[j] === "\\") j += 2;
          else if (rest[j] === quote) { j++; break; }
          else j++;
        }
        out += span("str", rest.slice(0, j));
        i += j;
        continue;
      }

      const ch = line[i];

      if (/[A-Za-z0-9_$@.-]/.test(ch)) {
        buffer += ch;
        i++;
        continue;
      }

      flush();

      // A word followed by `(` reads as a call — worth distinguishing.
      if (ch === "(" && out.endsWith("</span>") === false) {
        out += span("punct", ch);
      } else if (/[{}[\]()<>,;:]/.test(ch)) {
        out += span("punct", ch);
      } else if (/[=+\-*/%!&|^~?]/.test(ch)) {
        out += span("op", ch);
      } else {
        out += escapeHtml(ch);
      }
      i++;
    }

    flush();
    out += "\n";
  }

  return out.replace(/\n$/, "");
}

/** Languages we actually colour. Used by the build to warn on unknown fences. */
export const SUPPORTED = new Set([...Object.keys(COMMON), ...Object.keys(ALIASES)]);
