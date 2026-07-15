let ioInstance = null;

export function setSocketServer(io) {
  ioInstance = io;
}

export function getSocketServer() {
  return ioInstance;
}

export function emitToClient(clientId, eventName, payload) {
  if (!ioInstance || !clientId) {
    return;
  }

  ioInstance.to(clientId).emit(eventName, payload);
}

export function broadcast(eventName, payload) {
  if (!ioInstance) {
    return;
  }

  ioInstance.emit(eventName, payload);
}
