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

  // Derniers octets d'un caractere multi-octets coupe en fin de flux.
  const tail = decoder.decode();
  if (tail) {
    onChunk(tail);
  }
}

function parseSseBlock(eventBlock) {
  let eventName = "message";
  const dataLines = [];

  for (const line of eventBlock.split("\n")) {
    // Ligne de commentaire (": ping" envoye par le serveur pour garder la
    // connexion ouverte pendant le chargement du modele) : ignoree.
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) {
    return eventName === "message" ? null : { eventName, data: {} };
  }

  try {
    return { eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    // Un evenement illisible (proxy, coupure) ne doit pas interrompre la reponse.
    return null;
  }
}

export async function consumeSseResponse(response, handlers) {
  let buffer = "";

  const dispatch = (eventBlock) => {
    const event = parseSseBlock(eventBlock);
    if (event && handlers[event.eventName]) {
      handlers[event.eventName](event.data);
    }
  };

  await readTextStream(response, (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    events.forEach(dispatch);
  });

  if (buffer.trim()) {
    dispatch(buffer);
  }
}

export async function consumeNdjsonResponse(response, onMessage) {
  let buffer = "";

  const parseLine = (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      onMessage(JSON.parse(line));
    } catch {
      // Ligne tronquee ou corrompue : ignoree plutot que d'arreter la lecture.
    }
  };

  await readTextStream(response, (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(parseLine);
  });

  parseLine(buffer);
}
