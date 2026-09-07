import { describe, expect, it } from "vitest";
import { extractCrawlerToken, identifyCaller } from "./identify";

const req = (headers: Record<string, string>) =>
  new Request("https://example.com/article/x", { headers });

describe("extractCrawlerToken", () => {
  it("finds known crawler tokens case-insensitively", () => {
    expect(extractCrawlerToken("Mozilla/5.0 (compatible; GPTBot/1.2)")).toBe("gptbot");
    expect(extractCrawlerToken("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
    expect(extractCrawlerToken("ClaudeBot")).toBe("claudebot");
  });

  it("falls back to a truncated UA for unknown callers", () => {
    expect(extractCrawlerToken("curl/8.0.1")).toBe("curl/8.0.1");
    expect(extractCrawlerToken("")).toBe("unknown");
  });
});

describe("identifyCaller", () => {
  it("is unverified by default for plain user agents", () => {
    const id = identifyCaller(req({ "user-agent": "GPTBot" }));
    expect(id).toMatchObject({ crawler: "gptbot", verified: false });
  });

  it("honors the demo verification override", () => {
    const id = identifyCaller(req({ "user-agent": "GPTBot", "x-sim-verified": "1" }));
    expect(id.verified).toBe(true);
  });

  it("uses X-BUYER-ID when provided, else ip:crawler", () => {
    expect(identifyCaller(req({ "user-agent": "GPTBot", "x-buyer-id": "lab-1" })).buyerId).toBe("lab-1");
    expect(
      identifyCaller(req({ "user-agent": "GPTBot", "cf-connecting-ip": "1.2.3.4" })).buyerId,
    ).toBe("1.2.3.4:gptbot");
  });
});
