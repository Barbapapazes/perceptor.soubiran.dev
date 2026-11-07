import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

describe("Hello World Worker", () => {
  it("returns a plain-text greeting", async () => {
    const response = await exports.default.fetch("https://example.com/");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Hello World!");
  });
});
