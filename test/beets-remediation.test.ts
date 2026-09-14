import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MusicRemediationService,
  musicRemediationManifestSchema,
} from "../src/beets-remediation.js";
import { apps } from "../src/config.js";
import type { MusicAuditService } from "../src/music-audit.js";
import { createMediaMcpServer } from "../src/server.js";

const hash = "a".repeat(64);
const releaseId = "51f1f007-ea77-483e-9560-220e4c30cf8d";
const albumId = "alb_ceb0175f3fb6d87a79c41606";
const trackPath = "2 Chainz/Based on a T.R.U. Story/01 Yuck.flac";
const sidecarPath = "2 Chainz/Based on a T.R.U. Story/cover.png";
const decision = {
  albums: [{
    albumId,
    genres: ["Hip-Hop & Rap", "Soundtrack & Musical"],
    art: {
      source: "caa" as const,
      url: `https://coverartarchive.org/release/${releaseId}/30550660152.png`,
      expected_sha256: hash,
    },
  }],
};
const snapshot = {
  scanId: "b652dc32-62d7-49a8-8f57-a63c002cb72f",
  albums: [{
    id: albumId,
    musicBrainzReleaseId: releaseId,
    directories: ["2 Chainz/Based on a T.R.U. Story"],
    tracks: [{ path: trackPath, genres: decision.albums[0]!.genres, embeddedArt: [{ sha256: hash }] }],
    sidecars: [{ filename: sidecarPath, sha256: hash }],
  }],
};
const audit = {
  remediationSnapshot: async () => snapshot,
  remediationFileSha256: async () => hash,
} as unknown as MusicAuditService;

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  token: process.env.BEETS_FLASK_REMEDIATION_TOKEN,
  hmac: process.env.BEETS_REMEDIATION_MANIFEST_HMAC_KEY,
  genres: process.env.BEETS_REMEDIATION_GENRES_JSON,
  requests: process.env.ALLOW_REQUESTS,
  beets: process.env.ALLOW_WRITE_BEETS_FLASK,
};
const beetsApp = apps.find((app) => app.name === "beets-flask")!;
const originalUrl = beetsApp.url;

beforeEach(() => {
  beetsApp.url = "http://beets-flask:5001";
  process.env.BEETS_FLASK_REMEDIATION_TOKEN = "x".repeat(32);
  process.env.BEETS_REMEDIATION_MANIFEST_HMAC_KEY = "h".repeat(32);
  process.env.BEETS_REMEDIATION_GENRES_JSON = '["Hip-Hop & Rap","Soundtrack & Musical"]';
  process.env.ALLOW_REQUESTS = "";
  process.env.ALLOW_WRITE_BEETS_FLASK = "";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  beetsApp.url = originalUrl;
  for (const [name, value] of Object.entries({
    BEETS_FLASK_REMEDIATION_TOKEN: originalEnvironment.token,
    BEETS_REMEDIATION_MANIFEST_HMAC_KEY: originalEnvironment.hmac,
    BEETS_REMEDIATION_GENRES_JSON: originalEnvironment.genres,
    ALLOW_REQUESTS: originalEnvironment.requests,
    ALLOW_WRITE_BEETS_FLASK: originalEnvironment.beets,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response(value: object) {
  return new Response(JSON.stringify({ ok: true, ...value }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function preparedService() {
  const store = await mkdtemp(path.join(os.tmpdir(), "music-remediation-"));
  const service = new MusicRemediationService(audit, store);
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://beets-flask:5001/api_v1/remediation/art-digest");
    return response({ sha256: hash, bytes: 123, width: 10, height: 10, format: "png" });
  };
  const prepared = await service.prepare(decision) as any;
  return { service, store, prepared };
}

describe("beets-flask remediation client", () => {
  it("requires reviewed CAA bytes in the manifest schema", () => {
    const manifest = {
      schema: "music-remediation-manifest.v1",
      snapshot_id: snapshot.scanId,
      albums: [{
        album_id: albumId,
        album_path: snapshot.albums[0]!.directories[0],
        musicbrainz_release_id: releaseId,
        tracks: [{ path: trackPath, expected_file_sha256: hash, expected_embedded_sha256: [hash] }],
        sidecar: { path: sidecarPath, expected_sha256: hash },
        genres: decision.albums[0]!.genres,
        art: decision.albums[0]!.art,
      }],
    };
    assert.equal(musicRemediationManifestSchema.safeParse(manifest).success, true);
    const missing = structuredClone(manifest) as any;
    delete missing.albums[0].art.expected_sha256;
    assert.equal(musicRemediationManifestSchema.safeParse(missing).success, false);
  });

  it("prepares and signs a canonical manifest from snapshot IDs only", async () => {
    const { store, prepared } = await preparedService();
    assert.match(prepared.manifestId, /^mrm_[a-f0-9]{24}$/);
    assert.equal(prepared.snapshotId, snapshot.scanId);
    assert.equal(prepared.trackCount, 1);
    const envelope = JSON.parse(await readFile(path.join(store, `${prepared.manifestId}.json`), "utf8"));
    assert.equal(envelope.manifest.albums[0].tracks[0].path, trackPath);
    assert.equal(envelope.manifest.albums[0].art.expected_sha256, hash);
    assert.match(envelope.signature, /^[a-f0-9]{64}$/);
  });

  it("reloads signed manifests by ID and rejects tampering or stale snapshots", async () => {
    const { service, store, prepared } = await preparedService();
    let sent: any;
    globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return response({ schema: "beets-flask-remediation.preview.v1" });
    };
    await service.preview(prepared.manifestId);
    assert.equal(sent.manifest.manifest_id, prepared.manifestId);
    const file = path.join(store, `${prepared.manifestId}.json`);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.manifest.albums[0].genres = ["Rock"];
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(service.preview(prepared.manifestId), /signature or digest/);
  });

  it("rejects a tampered manifest HMAC even when the manifest bytes are unchanged", async () => {
    const { service, store, prepared } = await preparedService();
    const file = path.join(store, `${prepared.manifestId}.json`);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.signature = "0".repeat(64);
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(service.preview(prepared.manifestId), /signature or digest/);
  });

  it("rejects a stored manifest after the latest snapshot changes", async () => {
    const { service, prepared } = await preparedService();
    const original = snapshot.scanId;
    snapshot.scanId = "11111111-1111-4111-8111-111111111111";
    try {
      await assert.rejects(service.preview(prepared.manifestId), /not bound to the latest snapshot/);
    } finally {
      snapshot.scanId = original;
    }
  });

  it("uses client operation IDs and requires both write gates", async () => {
    const { service, prepared } = await preparedService();
    const operationId = "b".repeat(32);
    assert.throws(() => service.rollback(operationId), /ALLOW_REQUESTS/);
    process.env.ALLOW_REQUESTS = "true";
    await assert.rejects(service.apply(prepared.manifestId, operationId), /ALLOW_WRITE_BEETS_FLASK/);
    process.env.ALLOW_WRITE_BEETS_FLASK = "true";
    let body: any;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return response({ status: "applied" });
    };
    await service.apply(prepared.manifestId, operationId);
    assert.equal(body.operation_id, operationId);
    assert.equal(body.manifest.manifest_id, prepared.manifestId);
  });

  it("rejects a reviewed CAA digest mismatch", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "music-remediation-"));
    const service = new MusicRemediationService(audit, store);
    globalThis.fetch = async () => response({ sha256: "0".repeat(64), bytes: 123, width: 10, height: 10, format: "png" });
    await assert.rejects(service.prepare(decision), /reviewed hash/);
  });

  it("fails closed when v1 does not have exactly one sidecar", async () => {
    const changed = structuredClone(snapshot);
    changed.albums[0]!.sidecars.push({ filename: "2 Chainz/Based on a T.R.U. Story/folder.png", sha256: hash });
    const changedAudit = {
      remediationSnapshot: async () => changed,
      remediationFileSha256: async () => hash,
    } as unknown as MusicAuditService;
    const service = new MusicRemediationService(changedAudit, await mkdtemp(path.join(os.tmpdir(), "music-remediation-")));
    await assert.rejects(service.prepare(decision), /exactly one supported hashed sidecar/);
  });

  it("recovers an apply timeout through status using the same operation ID", async () => {
    const { service, prepared } = await preparedService();
    process.env.ALLOW_REQUESTS = "true";
    process.env.ALLOW_WRITE_BEETS_FLASK = "true";
    const operationId = "c".repeat(32);
    globalThis.fetch = async () => { throw new Error("simulated timeout"); };
    await assert.rejects(service.apply(prepared.manifestId, operationId), /simulated timeout/);
    let body: any;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "http://beets-flask:5001/api_v1/remediation/status");
      body = JSON.parse(String(init?.body));
      return response({ active: { transaction_id: operationId, status: "applied" } });
    };
    const status = await service.transaction(operationId) as any;
    assert.deepEqual(body, { transaction_id: operationId });
    assert.equal(status.active.transaction_id, operationId);
  });

  it("registers preparation, digest, stored-manifest, and transaction tools", async () => {
    const server = createMediaMcpServer(audit);
    const client = new Client({ name: "remediation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((item) => [item.name, item]));
    for (const name of [
      "music_remediation_art_digest",
      "music_remediation_prepare",
      "music_remediation_preview",
      "music_remediation_apply",
      "music_remediation_rollback",
      "music_remediation_finalize",
      "music_remediation_status",
      "music_remediation_recover",
    ]) assert.ok(tools.has(name), name);
    assert.deepEqual(Object.keys((tools.get("music_remediation_preview")!.inputSchema as any).properties), ["manifestId"]);
    assert.deepEqual(Object.keys((tools.get("music_remediation_apply")!.inputSchema as any).properties), ["manifestId", "operationId"]);
    assert.deepEqual(Object.keys((tools.get("music_remediation_finalize")!.inputSchema as any).properties), ["transactionId"]);
    await Promise.all([client.close(), server.close()]);
  });

  it("derives and signs finalize state from a distinct completed snapshot", async () => {
    process.env.ALLOW_REQUESTS = "true";
    process.env.ALLOW_WRITE_BEETS_FLASK = "true";
    const postScanId = "11111111-1111-4111-8111-111111111111";
    const changed = structuredClone(snapshot);
    changed.scanId = postScanId;
    const service = new MusicRemediationService({
      remediationSnapshot: async () => changed,
      remediationFileSha256: async () => hash,
    } as unknown as MusicAuditService);
    const expectedState = [{
      album_id: albumId,
      tracks: [{ path: trackPath, file_sha256: hash, embedded_sha256: [hash], genres: decision.albums[0]!.genres }],
      sidecar: { path: sidecarPath, sha256: hash },
    }];
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      if (url.endsWith("/finalize-state")) return response({
        schema: "beets-flask-remediation.finalize-state.v1",
        transaction_id: "d".repeat(32),
        status: "applied",
        manifest_snapshot_id: snapshot.scanId,
        expected_state: expectedState,
      });
      return response({ schema: "beets-flask-remediation.finalize.v1", status: "finalized" });
    };
    await service.finalize("d".repeat(32));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.body.attestation, {
      schema: "music-remediation-finalize-attestation.v1",
      transaction_id: "d".repeat(32),
      manifest_snapshot_id: snapshot.scanId,
      post_audit_scan_id: postScanId,
      albums: expectedState,
    });
    assert.match(requests[1]!.body.signature, /^[a-f0-9]{64}$/);
  });

  it("rejects stale and mismatched finalize snapshots before sending an attestation", async () => {
    process.env.ALLOW_REQUESTS = "true";
    process.env.ALLOW_WRITE_BEETS_FLASK = "true";
    const expectedState = [{
      album_id: albumId,
      tracks: [{ path: trackPath, file_sha256: hash, embedded_sha256: [hash], genres: decision.albums[0]!.genres }],
      sidecar: { path: sidecarPath, sha256: hash },
    }];
    let finalizeCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/finalize")) finalizeCalls += 1;
      return response({
        schema: "beets-flask-remediation.finalize-state.v1",
        transaction_id: "e".repeat(32),
        status: "applied",
        manifest_snapshot_id: snapshot.scanId,
        expected_state: expectedState,
      });
    };
    const stale = new MusicRemediationService(audit);
    await assert.rejects(stale.finalize("e".repeat(32)), /must differ/);
    const changed = structuredClone(snapshot);
    changed.scanId = "11111111-1111-4111-8111-111111111111";
    changed.albums[0]!.tracks[0]!.genres = ["Hip-Hop & Rap"];
    const mismatch = new MusicRemediationService({
      remediationSnapshot: async () => changed,
      remediationFileSha256: async () => hash,
    } as unknown as MusicAuditService);
    await assert.rejects(mismatch.finalize("e".repeat(32)), /does not exactly match/);
    assert.equal(finalizeCalls, 0);
  });
});
