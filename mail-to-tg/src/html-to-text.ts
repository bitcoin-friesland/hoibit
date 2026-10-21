// postal-mime only derives `text` from HTML when the email also has a text/plain part,
// so an HTML-only email (contact forms, newsletters) needs this conversion.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  zwnj: "",
  zwj: "",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  middot: "·",
  bull: "•",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  iexcl: "¡",
  iquest: "¿",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  auml: "ä",
  euml: "ë",
  iuml: "ï",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Euml: "Ë",
  Iuml: "Ï",
  Ouml: "Ö",
  Uuml: "Ü",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Eacute: "É",
  agrave: "à",
  egrave: "è",
  ograve: "ò",
  acirc: "â",
  ecirc: "ê",
  icirc: "î",
  ocirc: "ô",
  ucirc: "û",
  ccedil: "ç",
  ntilde: "ñ",
  szlig: "ß",
  oslash: "ø",
  aring: "å"
};

function decodeEntities(text: string) {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g,
    (match, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name] ?? match;
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      // Like a browser: NUL, surrogates and out-of-range code points become U+FFFD.
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return String.fromCharCode(0xfffd);
      return String.fromCodePoint(code);
    }
  );
}

// Removes comments and <head>, <style> and <script> blocks with indexOf instead of a lazy
// regex, so a mail full of unclosed blocks cannot make this quadratic. An unclosed block
// swallows the rest of the document, as it does in a browser.
function stripBlocks(html: string) {
  // ASCII only: toLowerCase() can change the length of some characters and shift the indexes.
  const lower = html.replace(/[A-Z]/g, c => c.toLowerCase());
  const open = /<!--|<(head|style|script)\b/g;
  let out = "";
  let pos = 0;
  for (let m = open.exec(lower); m; m = open.exec(lower)) {
    out += html.slice(pos, m.index);
    const close = m[1] ? `</${m[1]}` : "-->";
    const end = lower.indexOf(close, m.index + m[0].length);
    if (end < 0) return out;
    pos = m[1] ? lower.indexOf(">", end) + 1 || lower.length : end + close.length;
    open.lastIndex = pos;
  }
  return out + html.slice(pos);
}

export function htmlToText(html: string) {
  // [^<>]* rather than [^>]* keeps each tag match bounded by the next "<" (linear time).
  const text = stripBlocks(html)
    // Source line breaks are just whitespace in HTML.
    .replace(/\s+/g, " ")
    .replace(/<br\b[^<>]*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^<>]*>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
