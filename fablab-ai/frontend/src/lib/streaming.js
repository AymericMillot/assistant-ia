async function readTextStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    onChunk(decoder.decode(value, { stream: true }));
  }
}

export async function consumeSseResponse(response, handlers) {
  let buffer = "";

  await readTextStream(response, (chunk) => {
    buffer += chunk;
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const eventBlock of events) {
      const lines = eventBlock.split("\n").filter(Boolean);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      const eventName = eventLine ? eventLine.replace("event:", "").trim() : "message";
      const data = dataLine ? JSON.parse(dataLine.replace("data:", "").trim()) : {};

      if (handlers[eventName]) {
        handlers[eventName](data);
      }
    }
  });
}

export async function consumeNdjsonResponse(response, onMessage) {
  let buffer = "";

  await readTextStream(response, (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      onMessage(JSON.parse(line));
    }
  });
}
