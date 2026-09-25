// Guards for file-system calls on the client drives. On Windows, a stat of a share whose NAS
// has gone away can block for tens of seconds; a timeout turns that into a clear message
// instead of a frozen request. The stuck call still occupies one of Node's file threads until
// Windows gives up, so code that touches many paths also limits how many calls run at once.

export const NETWORK_TIMEOUT_MS = 15_000;

export class FsTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.timedOut = true;
    }
}

// Rejects with FsTimeoutError if `promise` hasn't settled after `ms`. A late rejection of the
// original promise is still handled (Promise.race subscribes to it), so nothing leaks.
export function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FsTimeoutError(message)), ms);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// At most `max` tasks at once; the rest wait in order.
export function createLimiter(max) {
    let active = 0;
    const queue = [];

    function next() {
        while (active < max && queue.length) {
            const entry = queue.shift();
            if (entry.cancelled) continue;
            active++;
            entry.start();
        }
    }

    // `fn` gets `ms` to finish, counted from when it starts. Its slot stays taken until it
    // really settles, even after the caller got the timeout, so hung calls can't pile up on
    // Node's file threads. With `maxWaitMs`, a caller that can't get a slot in time gets
    // `waitMessage` instead of waiting behind a hung drive indefinitely.
    function runTimed(fn, ms, message, { maxWaitMs, waitMessage } = {}) {
        return new Promise((resolve, reject) => {
            let waitTimer = null;
            const entry = {
                cancelled: false,
                start() {
                    clearTimeout(waitTimer);
                    const work = Promise.resolve().then(fn);
                    const timer = setTimeout(() => reject(new FsTimeoutError(message)), ms);
                    timer.unref?.();
                    work.then(resolve, reject).finally(() => clearTimeout(timer));
                    work.catch(() => {}).finally(() => { active--; next(); });
                },
            };
            if (maxWaitMs !== undefined) {
                waitTimer = setTimeout(() => {
                    entry.cancelled = true;
                    reject(new FsTimeoutError(waitMessage || message));
                }, maxWaitMs);
                waitTimer.unref?.();
            }
            queue.push(entry);
            next();
        });
    }

    return {
        runTimed,
        get active() { return active; },
        get waiting() { return queue.filter((e) => !e.cancelled).length; },
    };
}

// Like Promise.all(items.map(fn)), but with at most `limit` calls in flight.
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let index = 0;
    async function lane() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
    return results;
}
