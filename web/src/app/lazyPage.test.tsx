import { Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lazyPage } from "./lazyPage";

function Page({ label }: { label: string }) {
  return <p>{label}</p>;
}

describe("lazyPage", () => {
  // A committed fallback is not free: React holds it for its throttle window afterwards, so a
  // page that flashes a skeleton waits that window out even when its chunk is already in memory.
  it("renders without suspending once the chunk has been preloaded", async () => {
    const { Component, preload } = lazyPage(async () => ({ Page }), (module) => module.Page);
    await preload();

    const html = renderToStaticMarkup(
      <Suspense fallback={<span>skeleton</span>}><Component label="loaded" /></Suspense>
    );

    expect(html).toBe("<p>loaded</p>");
  });

  it("falls back while the chunk is still on its way", () => {
    const { Component } = lazyPage(() => new Promise<never>(() => undefined), () => Page);

    const html = renderToStaticMarkup(
      <Suspense fallback={<span>skeleton</span>}><Component label="loaded" /></Suspense>
    );

    expect(html).toBe("<span>skeleton</span>");
  });

  it("loads the chunk once however many times it is preloaded", async () => {
    let loads = 0;
    const { preload } = lazyPage(async () => { loads += 1; return { Page }; }, (module) => module.Page);

    await Promise.all([preload(), preload()]);
    await preload();

    expect(loads).toBe(1);
  });

  // A chunk request that fails because the connection dropped or a deploy replaced the file has
  // to stay retryable; caching the rejection would strand the page for the rest of the session.
  it("lets a failed chunk be requested again", async () => {
    let attempts = 0;
    const { preload } = lazyPage(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network");
        return { Page };
      },
      (module) => module.Page
    );

    await expect(preload()).rejects.toThrow("network");
    await expect(preload()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
