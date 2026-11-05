/** Title and summary of a shared text, for link previews (og: tags) and the
 * "my links" list. Markdown markers are stripped so messengers show plain text. */
export interface SharePreview {
  readonly title: string;
  readonly description: string;
}

const TITLE_LIMIT = 80;
const DESCRIPTION_LIMIT = 200;

function plain(line: string): string {
  return line
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,،؛:!؟?])/g, "$1$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

export function sharePreview(content: string): SharePreview {
  const lines: string[] = [];
  let inFence = false;
  let headingIndex = -1;
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*\|?\s*:?-{3,}/.test(raw) || /^\s*([-*_]\s*){3,}$/.test(raw)) continue; // table rule / hr
    const text = plain(raw);
    if (!text) continue;
    if (headingIndex < 0 && /^\s{0,3}#{1,6}\s+\S/.test(raw)) headingIndex = lines.length;
    lines.push(text);
  }
  // The first markdown heading is the title when there is one, else the first line.
  const titleIndex = headingIndex >= 0 ? headingIndex : 0;
  const title = truncate(lines[titleIndex] ?? "", TITLE_LIMIT);
  const rest = lines.filter((_, index) => index !== titleIndex).join(" ");
  return { title, description: truncate(rest, DESCRIPTION_LIMIT) };
}
