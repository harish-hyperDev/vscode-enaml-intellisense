// Index keyword labels once per immutable document, using masked source so
// delimiters inside comments and strings cannot affect the call stack.
function keywordCalls(doc) {
  if (doc.keywordCalls) return doc.keywordCalls;
  const calls = new Map(), stack = [];
  let tokenIndex = -1;
  for (let offset = 0; offset < doc.mask.length; offset++) {
    while (tokenIndex + 1 < doc.tokens.length && doc.tokens[tokenIndex + 1].end <= offset) tokenIndex++;
    const ch = doc.mask[offset], token = doc.tokens[tokenIndex];
    if ('([{'.includes(ch)) {
      const callable = ch === '(' && token && /^\w+$/.test(token.value) && /^\s*$/.test(doc.mask.slice(token.end, offset)) && !doc.declaredAt.has(token.start);
      stack.push({ call: callable ? token.start : null, argumentStart: offset + 1 });
    } else if (')]}'.includes(ch)) stack.pop();
    else if (ch === ',' && stack.length) stack.at(-1).argumentStart = offset + 1;
    else if (ch === '=' && doc.mask[offset + 1] !== '=') {
      const context = stack.at(-1);
      if (context?.call != null && token && /^\w+$/.test(token.value) && token.start >= context.argumentStart &&
          /^\s*$/.test(doc.mask.slice(context.argumentStart, token.start)) && /^\s*$/.test(doc.mask.slice(token.end, offset))) calls.set(token.start, context.call);
    }
  }
  doc.keywordCalls = calls;
  return calls;
}

module.exports = { keywordCalls };
