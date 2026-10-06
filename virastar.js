/* Persian text cleanup ("ویراستار"): Arabic letters and digits, half-spaces
   (ZWNJ), and spacing around punctuation. Code, links and math are left
   untouched, and every rule is conservative so Latin text is never changed. */
(function (global) {
  const ZWNJ = "‌";
  const FA = "؀-ۿ"; // Persian/Arabic letters
  const LETTER = `[${FA}]`;

  // Pieces that must survive byte-for-byte: fenced code, inline code, math, URLs.
  const PROTECTED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|https?:\/\/\S+|www\.\S+/g;

  const PLURAL_SUFFIXES = "ها|های|هایی|هایم|هایت|هایش|هایمان|هایتان|هایشان|تر|ترین|تری";

  /** [label, pattern, replacement] — applied in order; counted per label. */
  const RULES = [
    ["arabic", /ي|ى/g, "ی"],
    ["arabic", /ك/g, "ک"],
    ["arabic", /[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) + 0x6F0 - 0x660)],
    ["tatweel", new RegExp(`(${LETTER})ـ+(?=${LETTER})`, "g"), "$1"],
    // Half-spaces: prefixes (می/نمی) and suffixes (ها، تر، ترین …).
    ["zwnj", new RegExp(`(^|[^${FA}])(ن?می) +(?=${LETTER})`, "gm"), `$1$2${ZWNJ}`],
    ["zwnj", new RegExp(`(${LETTER}) +(${PLURAL_SUFFIXES})(?=$|[^${FA}])`, "gm"), `$1${ZWNJ}$2`],
    ["zwnj", /‌{2,}/g, ZWNJ],
    ["zwnj", / ‌|‌ /g, " "],
    // Latin punctuation between Persian words becomes Persian punctuation.
    ["punctuation", new RegExp(`(${LETTER}) *, *(?=${LETTER})`, "g"), "$1، "],
    ["punctuation", new RegExp(`(${LETTER}) *; *(?=${LETTER})`, "g"), "$1؛ "],
    ["punctuation", new RegExp(`(${LETTER}) *\\?(?=\\s|$)`, "gm"), "$1؟"],
    // No space before punctuation, one space after it.
    ["spacing", new RegExp(`(${LETTER}) +([،؛؟!:.])(?=\\s|$)`, "gm"), "$1$2"],
    ["spacing", new RegExp(`([،؛؟])(?=${LETTER})`, "g"), "$1 "],
    ["spacing", new RegExp(`(${LETTER}) {2,}(?=${LETTER})`, "g"), "$1 "],
  ];

  function persianCleanup(input) {
    const saved = [];
    let text = String(input).replace(PROTECTED, match => {
      saved.push(match);
      return `${saved.length - 1}`;
    });
    const changes = { arabic: 0, tatweel: 0, zwnj: 0, punctuation: 0, spacing: 0 };
    for (const [label, pattern, replacement] of RULES) {
      text = text.replace(pattern, (...args) => {
        const match = args[0];
        const result = typeof replacement === "function"
          ? replacement(...args)
          : replacement.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? "");
        if (result !== match) changes[label] += 1;
        return result;
      });
    }
    text = text.replace(/(\d+)/g, (_, i) => saved[Number(i)]);
    const total = Object.values(changes).reduce((sum, n) => sum + n, 0);
    return { text, changes, total };
  }

  global.persianCleanup = persianCleanup;
})(typeof window !== "undefined" ? window : globalThis);
