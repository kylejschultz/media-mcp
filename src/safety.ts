export function requestToolsEnabled() {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_REQUESTS ?? "");
}

export function requireRequestToolsEnabled() {
  if (!requestToolsEnabled()) {
    throw new Error("Request tools are disabled. Set ALLOW_REQUESTS=true to enable media request writes.");
  }
}

export function beetsFlaskWriteEnabled() {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_WRITE_BEETS_FLASK ?? "");
}

export function requireBeetsFlaskWriteEnabled() {
  requireRequestToolsEnabled();
  if (!beetsFlaskWriteEnabled()) {
    throw new Error("beets-flask remediation writes are disabled. Set ALLOW_WRITE_BEETS_FLASK=true in addition to ALLOW_REQUESTS=true.");
  }
}

export function safetyStatus() {
  const requestsEnabled = requestToolsEnabled();
  const beetsWritesEnabled = requestsEnabled && beetsFlaskWriteEnabled();
  return {
    mode: requestsEnabled ? "read+request" : "read-only",
    writeToolsEnabled: requestsEnabled,
    requestToolsEnabled: requestsEnabled,
    beetsFlaskWriteEnabled: beetsWritesEnabled,
    destructiveActionsEnabled: false,
  } as const;
}
