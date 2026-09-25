// Server-Sent Events: pushes job changes to every open dashboard the moment they happen
// (no polling, no extra library). Browsers reconnect by themselves if the server restarts.
export function createEventHub(log) {
    const clients = new Set();

    const heartbeat = setInterval(() => {
        for (const res of clients) res.write(": keepalive\n\n");
    }, 25_000);
    heartbeat.unref();

    return {
        subscribe(req, res) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write("retry: 3000\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
        },
        publish(type, data) {
            const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
            for (const res of clients) {
                try {
                    res.write(payload);
                } catch (err) {
                    log.warn(`Dropping a dashboard connection: ${err.message}`);
                    clients.delete(res);
                }
            }
        },
        get clientCount() {
            return clients.size;
        },
        close() {
            clearInterval(heartbeat);
            for (const res of clients) res.end();
            clients.clear();
        },
    };
}
