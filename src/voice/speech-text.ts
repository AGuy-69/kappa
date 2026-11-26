/** Turns a chat reply (markdown, code, links, emoji) into something worth reading aloud. */
export function cleanForSpeech(input: string, maxChars = 1500): string {
  let t = input.replace(/\r\n?/g, '\n');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' '); // fenced code, even if the closing fence never arrived
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\bhttps?:\/\/\S+/gi, 'link');
  t = t.replace(/^[\s:|-]{3,}$/gm, ' '); // table separator rows and horizontal rules
  t = t.replace(/^\s*\|(.*)\|\s*$/gm, '$1'); // table row: drop the outer pipes
  t = t.replace(/\s*\|\s*/g, ', ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  t = t.replace(/(^|\W)_+([^_\n]+)_+(?=\W|$)/g, '$1$2'); // _emphasis_ but not snake_case
  t = t.replace(/(?<=\w)_(?=\w)/g, ' '); // open_application -> open application
  t = t.replace(/(\*+|~~|`)/g, '');
  t = t.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
  t = t
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .map((l) => (/[.!?:;,…]$/.test(l) ? l : `${l}.`)) // a line break becomes a pause
    .join(' ');
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : maxChars);
}

/** Groups sentences into pieces of about `max` characters, so a long answer starts speaking before it is all synthesized. */
export function splitSentences(text: string, max = 300): string[] {
  const out: string[] = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + s.length > max) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}
