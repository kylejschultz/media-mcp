export function requestToolsEnabled() {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_REQUESTS ?? "");
}

export function requireRequestToolsEnabled() {
  if (!requestToolsEnabled()) {
    throw new Error("Request tools are disabled. Set ALLOW_REQUESTS=true to enable media request writes.");
  }
}

export function safetyStatus() {
  const requestsEnabled = requestToolsEnabled();
  return {
    mode: requestsEnabled ? "read+request" : "read-only",
    writeToolsEnabled: requestsEnabled,
    requestToolsEnabled: requestsEnabled,
    destructiveActionsEnabled: false,
  } as const;
}
