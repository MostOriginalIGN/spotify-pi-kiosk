export class EventBus {
  constructor() {
    this.clients = new Set();
    this.lastEvent = null;
    this.heartbeatTimer = setInterval(() => this.ping(), 15000);
  }

  ping() {
    for (const client of this.clients) {
      client.write(": heartbeat\n\n");
    }
  }

  connect(res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 2000\n\n");
    if (this.lastEvent) this.sendTo(res, this.lastEvent);
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  emit(type, payload = {}) {
    const event = { type, payload, at: new Date().toISOString() };
    this.lastEvent = event;
    for (const client of this.clients) this.sendTo(client, event);
  }

  sendTo(res, event) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
