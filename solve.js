// site-generator-speed-01-run-20261122 — v2
// A fast, dependency-free reimplementation of makefun-site 1.0.0's build().
// Same answers, byte for byte; structured for speed:
// - templates are parsed once, then compiled to flat op lists; rendering is a
//   tight program-counter loop, and each for-loop reuses one mutable scope frame
//   across its iterations instead of allocating a scope per element;
// - Markdown lines are classified once into kinds, then blocks render straight
//   from the kinds (no token objects, no re-scanning a line to decide whether it
//   ends a paragraph);
// - inline markup is one single pass over a character range: plain runs are
//   flushed through the HTML escaper, nested strong/em/links recurse on ranges
//   (no substring copies), and backslash/code/emphasis/link handling matches the
//   reference exactly;
// - slugs are cached per build; strings are built with array push + join.
// Node 22 stdlib only.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Per-build slug cache (titles / tag names / headings repeat across a site). */
let SLUG_CACHE = new Map();

// ---------------------------------------------------------------- text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text` with & < > " and ' escaped. Returns the input untouched when clean. */
export function escapeHtml(text) {
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let r;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    if (out === null) out = [];
    if (i > last) out.push(text.slice(last, i));
    out.push(r);
    last = i + 1;
  }
  if (out === null) return text;
  if (last < text.length) out.push(text.slice(last));
  return out.join('');
}

/** Escape the slice text[a..b) into the output array. */
function escRange(text, a, b, out) {
  let last = a;
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    let r;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    if (i > last) out.push(text.slice(last, i));
    out.push(r);
    last = i + 1;
  }
  if (last < b) out.push(text.slice(last, b));
}

const MARK_RE = /\p{M}/gu;
const ASCII_RE = /^[\x00-\x7F]*$/;

/** The slug of `text` (see makefun-site's README, "Text"). */
export function slugify(text) {
  const hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  // NFKD is the identity on ASCII and ASCII holds no combining marks.
  let plain = text;
  if (!ASCII_RE.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  SLUG_CACHE.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is JavaScript whitespace (the \s set). */
function isWSCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEYS_SET = new Set(KEYS);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length >= 1;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (!isAlnumCode(c) && c !== 45) { ok = false; break; }
        }
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64 && isAlnumCode(raw.charCodeAt(0));
      if (ok) {
        let prevDash = false;
        for (let i = 1; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if (isAlnumCode(c)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  // Find the closing --- line.
  let lineStart = firstNl === -1 ? text.length : firstNl + 1;
  let lineIdx = 1;
  let close = -1;
  let closeBodyStart = text.length;
  while (lineStart <= text.length) {
    let eol = text.indexOf('\n', lineStart);
    if (eol === -1) eol = text.length;
    if (text.slice(lineStart, eol) === '---') {
      close = lineIdx;
      closeBodyStart = eol + 1;
      break;
    }
    if (eol === text.length) break;
    lineStart = eol + 1;
    lineIdx++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  lineStart = firstNl === -1 ? text.length : firstNl + 1;
  lineIdx = 1;
  while (lineIdx < close) {
    let eol = text.indexOf('\n', lineStart);
    if (eol === -1) eol = text.length;
    const line = text.slice(lineStart, eol);
    const n = lineIdx + 1;
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${n} is not "key: value"` };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      raw = raw.slice(0, e);
      if (!KEYS_SET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (eol === text.length) break;
    lineStart = eol + 1;
    lineIdx++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeBodyStart) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE_CODES = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

function isEscapableCode(c) {
  return ESCAPABLE_CODES.has(c);
}

function isLangCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

function restIsSpaceTab(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangCode(line.charCodeAt(j))) j++;
  return restIsSpaceTab(line, j) ? line.slice(3, j) : null;
}

function isFenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restIsSpaceTab(line, 3);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6) return null;
  const depth = j;
  if (j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth, text: line.slice(j, e) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  return restIsSpaceTab(line, 3);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A bullet-list line's item text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered-list line's number and item text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWSCode(line.charCodeAt(j));
}

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j + what.length <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL_RE = /[\\`*[]/;
const HTML_SPECIAL_RE = /[&<>"']/;

/**
 * `s` rendered inline into `out`. Fast paths: a string with no inline construct
 * is pushed as-is (or through the escaper only when it holds HTML specials).
 */
function inlineText(s, env, out) {
  if (!INLINE_SPECIAL_RE.test(s)) {
    if (!HTML_SPECIAL_RE.test(s)) out.push(s);
    else escRange(s, 0, s.length, out);
    return;
  }
  inlineRange(s, 0, s.length, env, out);
}

/**
 * The slice s[a..b) rendered inline into `out` in a single pass; `env.link(target)`
 * is a link's href. Nested strong / emphasis / links recurse on ranges, so no
 * substring is copied for them. A character that starts no construct stays in the
 * plain run and is flushed through the HTML escaper at the next boundary.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  let plain = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < b && isEscapableCode(s.charCodeAt(i + 1))) {
      if (i > plain) escRange(s, plain, i, out);
      out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
      i += 2;
      plain = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > plain) escRange(s, plain, i, out);
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
        plain = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (i > plain) escRange(s, plain, i, out);
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        if (i > plain) escRange(s, plain, i, out);
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < b) m = mm;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !/\s/.test(target)) {
          if (i > plain) escRange(s, plain, i, out);
          out.push('<a href="');
          out.push(escapeHtml(env.link(target)));
          out.push('">');
          inlineRange(s, i + 1, k, env, out);
          out.push('</a>');
          i = m + 1;
          plain = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  if (b > plain) escRange(s, plain, b, out);
}

// Line kinds for the one-pass classification in renderMarkdown.
const KIND_BLANK = 0;
const KIND_FENCE = 1;
const KIND_HEADING = 2;
const KIND_HR = 3;
const KIND_QUOTE = 4;
const KIND_BULLET = 5;
const KIND_ORDERED = 6;
const KIND_OTHER = 7;

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * Every line is classified exactly once (blank / fence / heading / hr / quote /
 * list / other), then the blocks render straight from the kinds.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const kinds = new Uint8Array(n);
  const langs = new Array(n);
  const heads = new Array(n);
  const ordNums = new Array(n);
  const itemTexts = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (line.length === 0) continue; // blank
    // Dispatch on the first character: no kind but blank can start with a
    // space or tab, and each other kind has its own opening character.
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (!isBlankLine(line)) kinds[i] = KIND_OTHER;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        kinds[i] = KIND_FENCE;
        langs[i] = lang;
      } else kinds[i] = KIND_OTHER;
      continue;
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        kinds[i] = KIND_HEADING;
        heads[i] = h;
      } else kinds[i] = KIND_OTHER;
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        kinds[i] = KIND_HR;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        kinds[i] = KIND_BULLET;
        itemTexts[i] = bullet;
      } else kinds[i] = KIND_OTHER;
      continue;
    }
    if (c0 === 62) {
      kinds[i] = KIND_QUOTE;
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        kinds[i] = KIND_ORDERED;
        ordNums[i] = ordered.num;
        itemTexts[i] = ordered.text;
      } else kinds[i] = KIND_OTHER;
      continue;
    }
    kinds[i] = KIND_OTHER;
  }

  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const kind = kinds[i];
    if (kind === KIND_BLANK) {
      i++;
      continue;
    }
    if (kind === KIND_FENCE) {
      const lang = langs[i];
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-', lang, '"');
      parts.push('>');
      for (const l of body) {
        escRange(l, 0, l.length, parts);
        parts.push('\n');
      }
      parts.push('</code></pre>');
      blocks.push(parts.join(''), '\n');
      continue;
    }
    if (kind === KIND_HEADING) {
      const h = heads[i];
      const id = uniqueSlug(slugify(h.text), ids);
      const out = [];
      inlineText(h.text, env, out);
      const html = out.join('');
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`, '\n');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (kind === KIND_HR) {
      blocks.push('<hr>', '\n');
      i++;
      continue;
    }
    if (kind === KIND_QUOTE) {
      const body = [];
      while (i < n && kinds[i] === KIND_QUOTE) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>', '\n');
      else {
        const joined = kept.join('\n');
        const out = [];
        inlineText(joined, env, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`, '\n');
      }
      continue;
    }
    if (kind === KIND_BULLET || kind === KIND_ORDERED) {
      const isOrdered = kind === KIND_ORDERED;
      const start = isOrdered ? ordNums[i] : 1;
      const items = [];
      while (i < n) {
        const kk = kinds[i];
        if (isOrdered ? kk === KIND_ORDERED : kk === KIND_BULLET) {
          items.push([trimLine(itemTexts[i])]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const parts = [isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n'];
      for (const partsOf of items) {
        const joined = partsOf.join('\n');
        const out = [];
        inlineText(joined, env, out);
        parts.push('<li>', out.join(''), '</li>\n');
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''), '\n');
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break (quote and list lines are absorbed as text).
    const body = [trimLine(lines[i])];
    i++;
    while (i < n) {
      const kk = kinds[i];
      if (kk === KIND_BLANK || kk === KIND_FENCE || kk === KIND_HEADING || kk === KIND_HR) break;
      body.push(trimLine(lines[i++]));
    }
    const joined = body.join('\n');
    const out = [];
    inlineText(joined, env, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`, '\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Compiled op kinds: 0 text, 1 var/raw, 2 if, 3 jump, 4 for, 5 endfor, 6 include.

/** A parsed node tree compiled to a flat op list (jumps patched in place). */
function compileNodes(nodes, ops) {
  for (const n of nodes) {
    if (n.kind === 'text') ops.push({ t: 0, s: n.text });
    else if (n.kind === 'var' || n.kind === 'raw') ops.push({ t: 1, p: n.path, raw: n.kind === 'raw' ? 1 : 0 });
    else if (n.kind === 'if') {
      const ifOp = { t: 2, p: n.path, not: n.not ? 1 : 0, els: -1 };
      ops.push(ifOp);
      compileNodes(n.then, ops);
      if (n.else !== null) {
        const jmp = { t: 3, end: -1 };
        ops.push(jmp);
        ifOp.els = ops.length;
        compileNodes(n.else, ops);
        jmp.end = ops.length;
      } else {
        ifOp.els = ops.length;
      }
    } else if (n.kind === 'for') {
      const forOp = { t: 4, name: n.name, p: n.path, end: -1 };
      ops.push(forOp);
      compileNodes(n.body, ops);
      ops.push({ t: 5 });
      forOp.end = ops.length;
    } else if (n.kind === 'include') {
      ops.push({ t: 6, name: n.name });
    }
  }
  return ops;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered with `scopes` as the scope stack (top last) into `out`.
 * `templates` maps names to compiled op lists; `depth` is the include depth.
 * Each for-loop owns one mutable frame (vars + loop record) reused across its
 * iterations, so rendering a long list allocates once per loop, not per element.
 */
function renderOps(ops, templates, scopes, depth, out) {
  let pc = 0;
  const loops = [];
  while (pc < ops.length) {
    const op = ops[pc];
    switch (op.t) {
      case 0:
        out.push(op.s);
        pc++;
        break;
      case 1: {
        const v = textOf(lookup(scopes, op.p));
        out.push(op.raw ? v : escapeHtml(v));
        pc++;
        break;
      }
      case 2: {
        const v = truthy(lookup(scopes, op.p));
        pc = v !== (op.not === 1) ? pc + 1 : op.els;
        break;
      }
      case 3:
        pc = op.end;
        break;
      case 4: {
        const xs = lookup(scopes, op.p);
        if (!Array.isArray(xs) || xs.length === 0) {
          pc = op.end;
          break;
        }
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { [op.name]: xs[0], loop };
        loops.push({ arr: xs, idx: 0, end: op.end, body: pc + 1, name: op.name, vars, loop });
        scopes.push(vars);
        pc++;
        break;
      }
      case 5: {
        const frame = loops[loops.length - 1];
        const k = frame.idx + 1;
        if (k < frame.arr.length) {
          frame.idx = k;
          frame.loop.index = k + 1;
          frame.loop.first = false;
          frame.loop.last = k === frame.arr.length - 1;
          if (frame.name === '__proto__') {
            Object.defineProperty(frame.vars, frame.name, { value: frame.arr[k], writable: true, enumerable: true, configurable: true });
          } else {
            frame.vars[frame.name] = frame.arr[k];
          }
          pc = frame.body;
        } else {
          loops.pop();
          scopes.pop();
          pc++;
        }
        break;
      }
      case 6: {
        const t = templates.get(op.name);
        if (t !== undefined && depth < 8) renderOps(t, templates, scopes, depth + 1, out);
        pc++;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  SLUG_CACHE = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileNodes(parseTemplate(name, input.templates[name]), []));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const render = (name, vars) => {
      const ops = b.templates.get(name);
      if (ops === undefined) return null;
      const out = [];
      renderOps(ops, b.templates, [{ site, tags: allTags, recent, ...vars }], 0, out);
      return out.join('');
    };
    const pageOf = (s) => {
      const card = s.post ? b.cards.get(s) : cardOf(s);
      return {
        ...card,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
