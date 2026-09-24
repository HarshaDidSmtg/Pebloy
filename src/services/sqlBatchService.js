function splitGoBatches(text) {
  const batches = [];
  let current = "";
  let quote = null;
  let commentDepth = 0;
  for (const rawLine of String(text || "").match(/[^\n]*(?:\n|$)/g) || []) {
    const line = rawLine.replace(/\r?\n$/, "");
    const separator = !quote && commentDepth === 0
      ? line.match(/^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*;?[ \t]*(?:--[^\r\n]*)?$/i)
      : null;
    if (separator) {
      batches.push({ sql: current.replace(/\r?\n$/, ""), separator: line.trim(), repeat: Number(separator[1] || 1) });
      current = "";
      continue;
    }
    current += rawLine;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (commentDepth > 0) {
        if (char === "/" && next === "*") { commentDepth += 1; index += 1; }
        else if (char === "*" && next === "/") { commentDepth -= 1; index += 1; }
      } else if (quote) {
        if (char === quote) {
          if (next === quote) index += 1;
          else quote = null;
        }
      } else if (char === "-" && next === "-") {
        break;
      } else if (char === "/" && next === "*") {
        commentDepth += 1;
        index += 1;
      } else if (char === "'" || char === '"' || char === "[") {
        quote = char === "[" ? "]" : char;
      }
    }
  }
  batches.push({ sql: current, separator: null, repeat: 1 });
  return batches;
}

function splitSqlBatches(text) {
  return splitGoBatches(text).flatMap(({ sql, repeat }) => {
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 1000) {
      throw new Error("GO repeat count must be between 1 and 1000.");
    }
    return sql.trim() ? Array(repeat).fill(sql.trim()) : [];
  });
}

function replaceSqlCode(value, pattern, replacement) {
  const text = String(value || "");
  const masked = text.split("");
  let quote = null;
  let commentDepth = 0;
  let lineComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment && (character === "\r" || character === "\n")) lineComment = false;
    if (lineComment) {
      masked[index] = "\0";
    } else if (commentDepth) {
      masked[index] = "\0";
      if (character === "/" && next === "*") { commentDepth += 1; masked[++index] = "\0"; }
      else if (character === "*" && next === "/") { commentDepth -= 1; masked[++index] = "\0"; }
    } else if (quote) {
      masked[index] = "\0";
      if (character === quote) {
        if (next === quote) masked[++index] = "\0";
        else quote = null;
      }
    } else if (character === "-" && next === "-") {
      lineComment = true;
      masked[index] = masked[++index] = "\0";
    } else if (character === "/" && next === "*") {
      commentDepth = 1;
      masked[index] = masked[++index] = "\0";
    } else if (character === "'" || character === '"' || character === "[") {
      quote = character === "[" ? "]" : character;
      masked[index] = "\0";
    }
  }
  let cursor = 0;
  let output = "";
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of masked.join("").matchAll(matcher)) {
    output += text.slice(cursor, match.index) + (typeof replacement === "function" ? replacement(...match) : replacement);
    cursor = match.index + match[0].length;
    if (!pattern.global) break;
  }
  return output + text.slice(cursor);
}

module.exports = { splitGoBatches, splitSqlBatches, replaceSqlCode };