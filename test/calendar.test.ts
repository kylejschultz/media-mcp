import assert from "node:assert/strict";
import { it, mock } from "node:test";

for (const app of ["SONARR", "RADARR", "LIDARR"]) {
  process.env[`${app}_URL`] = `http://${app.toLowerCase()}.test`;
  process.env[`${app}_API_KEY`] = "fixture-api-key";
}
const { calendar } = await import("../src/media.js");

it("Sonarr calendar includes an actual series title without returning unrelated series metadata", async (t) => {
  const fetch = mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("includeSeries"), "true");
    assert.equal(url.searchParams.get("start"), "2026-10-27");
    assert.equal(url.searchParams.get("end"), "2026-11-03");
    return Response.json([{ seriesId: 7, title: "Pilot", series: { title: "Fixture Show", path: "/private/library" } }]);
  });
  t.after(() => fetch.mock.restore());
  assert.deepEqual(await calendar("sonarr", "2026-10-27", "2026-11-03"), [
    { seriesId: 7, title: "Pilot", seriesTitle: "Fixture Show" },
  ]);
});

it("other calendars retain their upstream response and do not request Sonarr-only fields", async (t) => {
  const entries = [{ title: "Fixture release" }];
  const fetch = mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    assert.equal(new URL(String(input)).searchParams.has("includeSeries"), false);
    return Response.json(entries);
  });
  t.after(() => fetch.mock.restore());
  for (const app of ["radarr", "lidarr"] as const) {
    assert.deepEqual(await calendar(app, "2026-10-27", "2026-11-03"), entries);
  }
});

it("calendar does not invent a show name when upstream series metadata is missing", async (t) => {
  const fetch = mock.method(globalThis, "fetch", async () => Response.json([{ seriesId: 7, title: "Pilot" }]));
  t.after(() => fetch.mock.restore());
  assert.deepEqual(await calendar("sonarr", "2026-10-27", "2026-11-03"), [{ seriesId: 7, title: "Pilot" }]);
});
