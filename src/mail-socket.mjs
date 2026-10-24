// TLS is mandatory. Never log SMTP/IMAP commands: authentication contains secrets.
export async function tlsMailSocket(hostname, port) {
  const { connect } = await import('cloudflare:sockets');
  const socket = connect({ hostname, port }, { secureTransport: 'on' });
  return socket;
}
export class MailWire {
  constructor(socket) { this.socket = socket; this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter(); this.buffer = new Uint8Array(); }
  async write(value) { await this.writer.write(new TextEncoder().encode(value)); }
  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('Mail connection closed');
    if (this.buffer.length + value.length > 262144) throw new Error('Mail response exceeded limit');
    const joined = new Uint8Array(this.buffer.length + value.length); joined.set(this.buffer); joined.set(value, this.buffer.length); this.buffer = joined;
  }
  async line() {
    for (;;) {
      const end = this.buffer.findIndex((b, i) => b === 10 && i > 0 && this.buffer[i - 1] === 13);
      if (end !== -1) { const line = new TextDecoder().decode(this.buffer.slice(0, end - 1)); this.buffer = this.buffer.slice(end + 1); return line; }
      if (this.buffer.length > 16384) throw new Error('Mail line exceeded limit');
      await this.fill();
    }
  }
  async bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > 65536) throw new Error('Mail headers exceeded limit');
    while (this.buffer.length < length) await this.fill();
    const bytes = this.buffer.slice(0, length); this.buffer = this.buffer.slice(length); return bytes;
  }
  async close() { try { await this.socket.close(); } catch { /* Closing a completed transaction is best effort. */ } }
}
export async function mailDeadline(work, close, milliseconds = 20000) {
  let timer;
  try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { void close(); reject(new Error('Mail connection timed out')); }, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
