import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import { InfoEvent, Pong, type Info } from "signalk-wyoming/protocol";
import {
  describeService,
  hasWakePrograms,
  wakeModelNames,
} from "../src/wyoming.js";

let server: MockWyomingServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("describeService", () => {
  it("returns the info data from a wake service", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    const result = await describeService("127.0.0.1", port);
    expect(result.version).toBe("1.10.0");
    expect(hasWakePrograms(result.info)).toBe(true);
    expect(wakeModelNames(result.info)).toEqual(["okay_nabu"]);
  });

  it("skips non-info events before the info response", async () => {
    server = new MockWyomingServer({ role: "custom", hang: true });
    const port = await server.listen();
    const pending = describeService("127.0.0.1", port, { timeoutMs: 2000 });
    await server.waitForEvent((e) => e.event.type === "describe");
    server.send(Pong("keepalive"));
    const info: Info = {
      asr: [],
      tts: [],
      handle: [],
      intent: [],
      wake: [
        {
          name: "openwakeword",
          models: [{ name: "hey_jarvis" }, { name: "okay_nabu" }],
        },
      ],
      mic: [],
      snd: [],
    };
    server.send(InfoEvent(info));
    const result = await pending;
    expect(wakeModelNames(result.info)).toEqual(["hey_jarvis", "okay_nabu"]);
  });

  it("rejects on timeout against a hung service", async () => {
    server = new MockWyomingServer({ role: "wake", hang: true });
    const port = await server.listen();
    await expect(
      describeService("127.0.0.1", port, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects when the connection is refused", async () => {
    const probe = new MockWyomingServer();
    const port = await probe.listen();
    await probe.close(); // port is now free / closed
    await expect(
      describeService("127.0.0.1", port, { timeoutMs: 500 }),
    ).rejects.toThrow();
  });

  it("rejects when the server closes before answering", async () => {
    server = new MockWyomingServer({ role: "custom", hang: true });
    const port = await server.listen();
    const pending = describeService("127.0.0.1", port, { timeoutMs: 2000 });
    await server.waitForEvent((e) => e.event.type === "describe");
    await server.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("rejects on a malformed header", async () => {
    server = new MockWyomingServer({ role: "custom", hang: true });
    const port = await server.listen();
    const pending = describeService("127.0.0.1", port, { timeoutMs: 2000 });
    await server.waitForEvent((e) => e.event.type === "describe");
    server.sendMalformedHeader();
    await expect(pending).rejects.toThrow(/malformed/);
  });

  it("reads the protocol version from a hand-rolled info frame", async () => {
    // Raw server so we control the header's version field.
    const raw = net.createServer((socket) => {
      socket.on("data", () => {
        const data = JSON.stringify({
          wake: [{ name: "oww", models: [{ name: "okay_nabu" }] }],
        });
        socket.write(
          JSON.stringify({
            type: "info",
            version: "2.0.0",
            data_length: Buffer.byteLength(data),
          }) + "\n",
        );
        socket.write(data);
      });
    });
    const port = await new Promise<number>((resolve) => {
      raw.listen(0, "127.0.0.1", () => {
        resolve((raw.address() as net.AddressInfo).port);
      });
    });
    try {
      const result = await describeService("127.0.0.1", port);
      expect(result.version).toBe("2.0.0");
      expect(wakeModelNames(result.info)).toEqual(["okay_nabu"]);
    } finally {
      raw.close();
    }
  });
});

describe("info helpers", () => {
  it("hasWakePrograms is false for empty or missing wake lists", () => {
    expect(hasWakePrograms({})).toBe(false);
    expect(hasWakePrograms({ wake: [] })).toBe(false);
    expect(hasWakePrograms({ wake: [{ name: "x" }] })).toBe(true);
  });

  it("wakeModelNames tolerates malformed entries", () => {
    expect(wakeModelNames({})).toEqual([]);
    expect(
      wakeModelNames({
        wake: [
          null,
          { name: "a" },
          { name: "b", models: [{ name: "okay_nabu" }, {}, null, { name: 3 }] },
        ],
      }),
    ).toEqual(["okay_nabu"]);
  });
});
