/**
 * Minimal self-contained Wyoming `describe` client.
 *
 * Sends a header-only `describe` event and incrementally decodes events off
 * the socket until an `info` event arrives (skipping anything else), then
 * resolves with the parsed info data. This is deliberately tiny and has NO
 * runtime dependency on the signalk-wyoming package — the full protocol
 * implementation lives there; service plugins only ever need this one
 * request/response for readiness gating and health checks.
 *
 * Wire format (rhasspy/wyoming): `<header JSON>\n` + optional data JSON block
 * of `data_length` bytes + optional payload of `payload_length` bytes.
 */

import net from "node:net";

export interface DescribeResult {
  /** Wyoming protocol version from the info event header, if present. */
  version?: string;
  /** The info event's data block (wire-shaped, snake_case). */
  info: Record<string, unknown>;
}

export interface DescribeOptions {
  /** Overall deadline for connect + response. Default 5000. */
  timeoutMs?: number;
}

interface Header {
  type: string;
  version?: string;
  dataLength: number;
  payloadLength: number;
  inlineData?: Record<string, unknown>;
}

/** Send `describe` to a Wyoming service and await its `info` response. */
export function describeService(
  host: string,
  port: number,
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise<DescribeResult>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let header: Header | null = null;
    let done = false;

    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      fail(new Error(`describe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(result: DescribeResult): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    function fail(err: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }

    socket.on("connect", () => {
      socket.write('{"type": "describe"}\n');
    });
    socket.on("error", (err) => fail(err));
    socket.on("close", () =>
      fail(new Error("connection closed before info response")),
    );
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        processBuffer();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    function processBuffer(): void {
      for (;;) {
        if (header === null) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          header = parseHeader(buf.subarray(0, nl).toString("utf8"));
          buf = buf.subarray(nl + 1);
        }
        const total = header.dataLength + header.payloadLength;
        if (buf.length < total) return;
        if (header.type === "info") {
          let data = header.inlineData ?? {};
          if (header.dataLength > 0) {
            const raw = buf.subarray(0, header.dataLength).toString("utf8");
            const block: unknown = JSON.parse(raw);
            if (block === null || typeof block !== "object") {
              throw new Error("malformed info data block");
            }
            data = { ...data, ...(block as Record<string, unknown>) };
          }
          const result: DescribeResult = { info: data };
          if (header.version !== undefined) result.version = header.version;
          finish(result);
          return;
        }
        // Not info: skip this event entirely and keep reading.
        buf = buf.subarray(total);
        header = null;
      }
    }
  });
}

function parseHeader(line: string): Header {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("malformed Wyoming event header");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Wyoming event header is not a JSON object");
  }
  const h = parsed as Record<string, unknown>;
  if (typeof h.type !== "string" || h.type === "") {
    throw new Error('Wyoming event header missing "type"');
  }
  const header: Header = {
    type: h.type,
    dataLength: lengthField(h.data_length),
    payloadLength: lengthField(h.payload_length),
  };
  if (typeof h.version === "string") header.version = h.version;
  if (h.data !== null && typeof h.data === "object" && !Array.isArray(h.data)) {
    header.inlineData = h.data as Record<string, unknown>;
  }
  return header;
}

function lengthField(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error("invalid Wyoming event length field");
  }
  return v;
}

/** Wake model names advertised in an info response (`wake[].models[].name`). */
export function wakeModelNames(info: Record<string, unknown>): string[] {
  const names: string[] = [];
  const wake = info.wake;
  if (!Array.isArray(wake)) return names;
  for (const program of wake) {
    if (program === null || typeof program !== "object") continue;
    const models = (program as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (model === null || typeof model !== "object") continue;
      const name = (model as Record<string, unknown>).name;
      if (typeof name === "string" && name !== "") names.push(name);
    }
  }
  return names;
}

/** True when the info response advertises at least one wake program. */
export function hasWakePrograms(info: Record<string, unknown>): boolean {
  return Array.isArray(info.wake) && info.wake.length > 0;
}
