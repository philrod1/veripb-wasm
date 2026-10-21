// SharedArrayBuffer channel from the page to the classic-mode worker. The
// worker spends its life blocked inside the TUI's wasm, so it cannot receive
// messages; the page writes here and wakes it with Atomics.notify. The
// worker answers file requests with postMessage, which works while blocked.
//
// Layout: Int32 header | input ring (INPUT_SIZE bytes) | mailbox (MAIL_SIZE bytes)
//   SEQ      bumped (and notified) after every page-side change
//   COLS/ROWS terminal size; RESIZED set by the page, cleared by the worker
//   IN_HEAD  bytes written by the page (total, wraps at 2^31)
//   IN_TAIL  bytes consumed by the worker
//   MAIL     0 idle, 1 request waiting; requests are MAIL_OP with MAIL_ID,
//            name (NAME_LEN bytes) and data (DATA_LEN bytes) in the mailbox.
//   WAITING  1 while the worker is blocked waiting for input (for tests).

const SEQ = 0, COLS = 1, ROWS = 2, RESIZED = 3, IN_HEAD = 4, IN_TAIL = 5;
const MAIL = 6, MAIL_OP = 7, MAIL_ID = 8, NAME_LEN = 9, DATA_LEN = 10, WAITING = 11;
const HEADER_INTS = 16;
const HEADER_BYTES = HEADER_INTS * 4;
export const INPUT_SIZE = 64 * 1024;
export const MAIL_SIZE = 32 * 1024 * 1024;
export const MAIL_PUT = 1, MAIL_GET = 2, MAIL_DUMP = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createChannelBuffer() {
  return new SharedArrayBuffer(HEADER_BYTES + INPUT_SIZE + MAIL_SIZE);
}

function views(buffer) {
  return {
    header: new Int32Array(buffer, 0, HEADER_INTS),
    input: new Uint8Array(buffer, HEADER_BYTES, INPUT_SIZE),
    mail: new Uint8Array(buffer, HEADER_BYTES + INPUT_SIZE, MAIL_SIZE),
  };
}

/** Page side. */
export class ChannelWriter {
  constructor(buffer) {
    Object.assign(this, views(buffer));
    this.pendingInput = [];
  }

  #wake() {
    Atomics.add(this.header, SEQ, 1);
    Atomics.notify(this.header, SEQ);
  }

  setSize(cols, rows) {
    const changed = Atomics.load(this.header, COLS) !== cols || Atomics.load(this.header, ROWS) !== rows;
    Atomics.store(this.header, COLS, cols);
    Atomics.store(this.header, ROWS, rows);
    if (changed) {
      Atomics.store(this.header, RESIZED, 1);
      this.#wake();
    }
  }

  /** Queues `text` (string or bytes) as terminal input. */
  writeInput(text) {
    this.pendingInput.push(typeof text === "string" ? encoder.encode(text) : text);
    this.flushInput();
  }

  /** Copies queued input into the ring as space allows; retries later if full. */
  flushInput() {
    let wrote = false;
    while (this.pendingInput.length) {
      const bytes = this.pendingInput[0];
      const head = Atomics.load(this.header, IN_HEAD);
      const tail = Atomics.load(this.header, IN_TAIL);
      const free = INPUT_SIZE - ((head - tail) | 0);
      const n = Math.min(free, bytes.length);
      if (n === 0) break;
      for (let i = 0; i < n; i++) this.input[(head + i) % INPUT_SIZE] = bytes[i];
      Atomics.store(this.header, IN_HEAD, (head + n) | 0);
      wrote = true;
      if (n === bytes.length) this.pendingInput.shift();
      else this.pendingInput[0] = bytes.subarray(n);
    }
    if (wrote) this.#wake();
    if (this.pendingInput.length) setTimeout(() => this.flushInput(), 10);
  }

  /** Whether the worker is blocked waiting with no unread input. */
  workerWaiting() {
    return Atomics.load(this.header, WAITING) === 1
      && Atomics.load(this.header, IN_HEAD) === Atomics.load(this.header, IN_TAIL)
      && !this.pendingInput.length;
  }

  mailboxIdle() {
    return Atomics.load(this.header, MAIL) === 0;
  }

  /** Posts a mailbox request; the caller makes sure the mailbox is idle. */
  sendMail(op, id, name = "", data = new Uint8Array()) {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length + data.length > MAIL_SIZE) throw new Error(`${name}: larger than ${MAIL_SIZE} bytes`);
    this.mail.set(nameBytes, 0);
    this.mail.set(data, nameBytes.length);
    Atomics.store(this.header, MAIL_OP, op);
    Atomics.store(this.header, MAIL_ID, id);
    Atomics.store(this.header, NAME_LEN, nameBytes.length);
    Atomics.store(this.header, DATA_LEN, data.length);
    Atomics.store(this.header, MAIL, 1);
    this.#wake();
  }
}

/** Worker side. */
export class ChannelReader {
  constructor(buffer) {
    Object.assign(this, views(buffer));
  }

  size() {
    return [Atomics.load(this.header, COLS), Atomics.load(this.header, ROWS)];
  }

  /** Clears and returns the resize flag. */
  takeResized() {
    return Atomics.exchange(this.header, RESIZED, 0) === 1;
  }

  /** Copies up to `max` input bytes into `target`; returns the count. */
  readInput(target, max) {
    const head = Atomics.load(this.header, IN_HEAD);
    const tail = Atomics.load(this.header, IN_TAIL);
    const n = Math.min((head - tail) | 0, max);
    for (let i = 0; i < n; i++) target[i] = this.input[(tail + i) % INPUT_SIZE];
    Atomics.store(this.header, IN_TAIL, (tail + n) | 0);
    return n;
  }

  /** The waiting mailbox request {op, id, name, data}, or null. */
  takeMail() {
    if (Atomics.load(this.header, MAIL) !== 1) return null;
    const nameLen = Atomics.load(this.header, NAME_LEN);
    const dataLen = Atomics.load(this.header, DATA_LEN);
    const request = {
      op: Atomics.load(this.header, MAIL_OP),
      id: Atomics.load(this.header, MAIL_ID),
      name: decoder.decode(this.mail.slice(0, nameLen)),
      data: this.mail.slice(nameLen, nameLen + dataLen),
    };
    Atomics.store(this.header, MAIL, 0);
    return request;
  }

  /** Current change sequence number. */
  seq() {
    return Atomics.load(this.header, SEQ);
  }

  /** Blocks until the page changes something after `seq`, or `timeoutMs` passes. */
  wait(seq, timeoutMs) {
    Atomics.store(this.header, WAITING, 1);
    Atomics.wait(this.header, SEQ, seq, timeoutMs < 0 ? Infinity : timeoutMs);
    Atomics.store(this.header, WAITING, 0);
  }
}
