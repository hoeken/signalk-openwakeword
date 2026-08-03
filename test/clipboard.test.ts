/**
 * The clipboard fallback matters more than it looks: a boat's Signal K server
 * is normally reached over plain HTTP at a LAN address, which is NOT a secure
 * context, so `navigator.clipboard` does not exist at all and the copy button
 * silently did nothing.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { copyText } from "../src/webapp/clipboard.js";

interface DocStub {
  body: { appendChild: (n: unknown) => void; removeChild: () => void };
  activeElement: null;
  createElement: () => Record<string, unknown>;
  execCommand: () => boolean;
}

let doc: DocStub | null = null;

function stubDocument(execResult: boolean | (() => boolean)) {
  const appended: unknown[] = [];
  doc = {
    body: {
      appendChild: (node: unknown) => appended.push(node),
      removeChild: () => {},
    },
    activeElement: null,
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: () => {},
      value: "",
    }),
    execCommand:
      typeof execResult === "function" ? execResult : () => execResult,
  };
  vi.stubGlobal("document", doc);
  return { appended };
}

afterEach(() => {
  doc = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the clipboard API when the page is in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubDocument(false);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  // The real-world case: plain HTTP on a LAN address.
  it("falls back to execCommand when navigator.clipboard is missing", async () => {
    vi.stubGlobal("navigator", {});
    const { appended } = stubDocument(true);

    await expect(copyText("two lines")).resolves.toBe(true);
    expect(appended).toHaveLength(1);
  });

  it("falls back when the clipboard API exists but rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    stubDocument(true);

    await expect(copyText("x")).resolves.toBe(true);
  });

  it("reports failure so the caller can tell the user to copy by hand", async () => {
    vi.stubGlobal("navigator", {});
    stubDocument(false);

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("reports failure when execCommand throws", async () => {
    vi.stubGlobal("navigator", {});
    stubDocument(() => {
      throw new Error("not allowed");
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("always removes the scratch textarea, even when copying fails", async () => {
    vi.stubGlobal("navigator", {});
    let removed = 0;
    stubDocument(false);
    doc!.body.removeChild = () => {
      removed += 1;
    };

    await copyText("x");
    expect(removed).toBe(1);
  });

  it("returns false rather than throwing when there is no DOM at all", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    await expect(copyText("x")).resolves.toBe(false);
  });
});
