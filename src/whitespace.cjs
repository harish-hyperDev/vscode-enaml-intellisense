const width = text => [...text].reduce((n, c) => c === '\t' ? n + 8 - n % 8 : n + 1, 0);

// Physical lines are checked only at the beginning of a logical statement.
// Parenthesized expressions, backslash continuations and string contents keep their alignment.
function layout(text, scanned, offsets) {
  const lines = scanned.mask.split('\n'), levels = [0], issues = [], structural = new Set();
  let depth = 0, continuation = false, statement = null, previous = null, stringIndex = 0;
  for (let n = 0; n < lines.length; n++) {
    const start = offsets[n], line = lines[n], end = start + line.length;
    while (stringIndex < scanned.strings.length && scanned.strings[stringIndex].end <= start) stringIndex++;
    const string = scanned.strings[stringIndex];
    const insideString = string && string.start < start && string.end > start;
    const significant = line.trim() || (string && string.start >= start && string.start < end);
    if (!significant && !insideString) continue;
    if (!depth && !continuation && !insideString) {
      const indentText = /^[ \t]*/.exec(text.slice(start, end))[0], indent = width(indentText);
      structural.add(n);
      const report = message => issues.push({ start, end: start + Math.max(1, indentText.length), message });
      if (indentText.includes(' ') && indentText.includes('\t')) report('Mixed tabs and spaces in indentation.');
      if (!previous && indent > 0) report('Unexpected indentation at the top level.');
      if (previous?.opensBlock && indent <= previous.indent) report('Expected an indented block.');
      if (previous && indent > previous.indent && !previous.opensBlock) report('Unexpected indentation; the previous line does not start a block.');
      while (levels.length > 1 && indent < levels.at(-1)) levels.pop();
      if (indent < (previous?.indent || 0) && indent !== levels.at(-1)) report('Indentation does not match any outer block.');
      if (indent > levels.at(-1)) levels.push(indent);
      statement = { indent, start: start + indentText.length, end, opensBlock: false };
    }
    for (const ch of line) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    }
    continuation = /\\\s*$/.test(line);
    const spanningString = string && string.start < end && string.end > end;
    if (statement && !depth && !continuation && !spanningString) {
      statement.opensBlock = /:\s*$/.test(line);
      previous = statement;
      statement = null;
    } else if (statement && spanningString) {
      previous = statement;
    }
  }
  if (previous?.opensBlock) issues.push({ start: previous.start, end: previous.end, message: 'Expected an indented block.' });
  return { issues, structural };
}

module.exports = { layout, width };
