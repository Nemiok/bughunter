export function normalizeQwenTranscript(text) {
  const events = [];
  let normalizedAgents = 0;
  let normalizedExplorers = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block.type !== 'tool_use' || block.name !== 'Agent') continue;
      if (block.input?.subagent_type === 'bughunter:bh-explorer-node') {
        block.input = { ...block.input, subagent_type: 'bughunter:bh-explorer' };
        normalizedExplorers += 1;
      }
      if (block.input?.run_in_background === undefined) {
        block.input = { ...block.input, run_in_background: false };
        normalizedAgents += 1;
      }
    }
    events.push(JSON.stringify(event));
  }
  return {
    text: `${events.join('\n')}${events.length > 0 ? '\n' : ''}`,
    events: events.length,
    normalizedAgents,
    normalizedExplorers,
  };
}
