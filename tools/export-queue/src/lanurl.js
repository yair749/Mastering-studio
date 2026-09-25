// Works out the address designers should open. The first network address is often the wrong
// one: Hyper-V, WSL, VirtualBox and VPN adapters all add their own, and a PC that has just
// booted may only have a 169.254.x.x address. Worked out again on every call, because the
// address can change after start-up (DHCP) and the queue runs for weeks.
import os from "node:os";

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vboxnet|vmware|vmnet|wsl|hyper-v|loopback|tailscale|zerotier|docker|virbr/i;

function isPrivate(ip) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const subnet24 = (ip) => ip.split(".").slice(0, 3).join(".");

// IPv4 addresses of the file servers ("\\192.168.1.13\MG_Mega" -> 192.168.1.13).
export function serverAddresses(paths) {
    const out = new Set();
    for (const p of paths) {
        const m = /^(?:\\\\|\/\/)(\d{1,3}(?:\.\d{1,3}){3})[\\/]/.exec(String(p).trim());
        if (m) out.add(m[1]);
    }
    return [...out];
}

// Prefers a private IPv4 on the same /24 as the file servers (that's the office network),
// then any private IPv4, then the PC's name.
export function pickLanUrl({ interfaces, serverIps = [], port, hostname, host = "0.0.0.0", publicUrl = "" }) {
    if (publicUrl) return publicUrl;
    if (host && !["0.0.0.0", "::", "localhost", "127.0.0.1", "::1"].includes(host)) return `http://${host}:${port}/`;
    const candidates = [];
    for (const [name, addresses] of Object.entries(interfaces || {})) {
        if (VIRTUAL_ADAPTER.test(name)) continue;
        for (const a of addresses || []) {
            if (!a || (a.family !== "IPv4" && a.family !== 4) || a.internal) continue;
            if (a.address.startsWith("127.") || a.address.startsWith("169.254.") || !isPrivate(a.address)) continue;
            candidates.push(a.address);
        }
    }
    const servers = new Set(serverIps.map(subnet24));
    const ip = candidates.find((c) => servers.has(subnet24(c))) ?? candidates[0];
    return ip ? `http://${ip}:${port}/` : `http://${hostname}:${port}/`;
}

export function createLanUrl(config) {
    const serverIps = serverAddresses([...config.allowedRoots, ...(config.drives || []).map((d) => d.path)]);
    return () => {
        let interfaces = {};
        try {
            interfaces = os.networkInterfaces();
        } catch {
            // Rare (e.g. no permission to list adapters): fall back to the PC's name.
        }
        return pickLanUrl({ interfaces, serverIps, port: config.port, hostname: os.hostname(), host: config.host, publicUrl: config.publicUrl });
    };
}
