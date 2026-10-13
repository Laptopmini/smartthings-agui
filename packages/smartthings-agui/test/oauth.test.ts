import { describe, expect, it, vi } from "vitest";
import { SmartThingsClient } from "../src/client";
import { OAuthSession, beginSignIn, type OAuthConfig } from "../src/oauth";

const CONFIG: OAuthConfig = {
  clientId: "client-1",
  redirectUri: "http://localhost:5173/",
  exchangeUrl: "http://127.0.0.1:8001",
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function exchange(responses: { access_token: string; refresh_token?: string; expires_in?: number }[]) {
  const calls: { url: string; body: Record<string, string> }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json(responses[calls.length - 1]);
  };
  return { impl, calls };
}

describe("beginSignIn", () => {
  it("builds the documented authorize URL with a state it remembers", () => {
    const storage = memoryStorage();
    const url = new URL(beginSignIn(CONFIG, storage));
    expect(url.origin + url.pathname).toBe("https://api.smartthings.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/");
    expect(url.searchParams.get("scope")).toBe("r:devices:* x:devices:* r:scenes:* x:scenes:* r:locations:*");
    expect(url.searchParams.get("state")).toBe(storage.getItem("smartthings-agui:oauth-state"));
  });
});

describe("OAuthSession", () => {
  it("ignores a normal page load", async () => {
    expect(await OAuthSession.complete(CONFIG, "", memoryStorage())).toBeNull();
  });

  it("rejects a code whose state doesn't match (CSRF)", async () => {
    const storage = memoryStorage();
    beginSignIn(CONFIG, storage);
    const { impl, calls } = exchange([{ access_token: "at" }]);
    await expect(OAuthSession.complete(CONFIG, "?code=abc&state=forged", storage, impl)).rejects.toThrow(/state/);
    expect(calls).toHaveLength(0);
  });

  it("exchanges the code through the exchange service, then refreshes near expiry", async () => {
    const storage = memoryStorage();
    const state = new URL(beginSignIn(CONFIG, storage)).searchParams.get("state");
    const { impl, calls } = exchange([
      { access_token: "at1", refresh_token: "rt1", expires_in: 86_400 },
      { access_token: "at2", expires_in: 86_400 },
    ]);
    const session = await OAuthSession.complete(CONFIG, `?code=abc&state=${state}`, storage, impl);
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8001/oauth/token",
      body: { code: "abc", redirect_uri: "http://localhost:5173/" },
    });
    expect(storage.getItem("smartthings-agui:oauth-state")).toBeNull(); // single use

    expect(await session!.accessToken()).toBe("at1");
    vi.useFakeTimers({ now: Date.now() + 86_400_000 - 60_000 }); // a minute before expiry
    try {
      expect(await session!.accessToken()).toBe("at2");
      expect(calls[1]).toEqual({ url: "http://127.0.0.1:8001/oauth/refresh", body: { refresh_token: "rt1" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("feeds the SmartThings client", async () => {
    const seen: string[] = [];
    const client = new SmartThingsClient(
      async () => "fresh-token",
      async (_input, init) => {
        seen.push((init?.headers as Record<string, string>).Authorization);
        return Response.json({ items: [], _links: {} });
      },
    );
    await client.listScenes();
    expect(seen).toEqual(["Bearer fresh-token"]);
  });
});
