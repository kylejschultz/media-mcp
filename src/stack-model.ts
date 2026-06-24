import type { AppName } from "./config.js";

type MediaFlow = {
  label: string;
  managers: string[];
  indexers?: string[];
  downloaders: string[];
  staging: string[];
  importAuthority: string[];
  library: string[];
  servedBy: string[];
  notes: string[];
};

type ExpectedServiceIssue = {
  service: AppName;
  source?: string;
  messageIncludes: string;
  interpretation: string;
  verifyWith: string[];
};

export const stackModel = {
  schema: "media-mcp.stack-model.v1",
  title: "Media Stack Overview",
  source: {
    kind: "notion",
    title: "Media Stack Overview",
    pageId: "38002dbf303781228cc0e69d0da220fd",
    lastReviewed: "2026-06-24",
  },
  platform: {
    host: "Unraid",
    address: "10.10.10.10",
    containerNetwork: "docker-network",
  },
  storage: {
    libraryRoot: "/mnt/user/media-stack",
    downloadsRoot: "/mnt/user/media-downloads",
    appdataRoot: "/mnt/user/appdata/media-stack",
    libraries: {
      tv: "/mnt/user/media-stack/tv",
      movies: "/mnt/user/media-stack/movies",
      music: "/mnt/user/media-stack/music",
    },
    staging: {
      video: "/mnt/user/media-downloads/video",
      musicInbox: "/mnt/user/media-downloads/music/inbox",
      slskdInbox: "/mnt/user/media-downloads/music/inbox/slskd",
    },
  },
  flows: {
    tv: {
      label: "TV",
      managers: ["sonarr"],
      indexers: ["prowlarr"],
      downloaders: ["sabnzbd"],
      staging: ["/mnt/user/media-downloads/video"],
      importAuthority: ["sonarr"],
      library: ["/mnt/user/media-stack/tv"],
      servedBy: ["jellyfin"],
      notes: ["Sonarr owns TV import, rename, and organization after SABnzbd completes downloads."],
    },
    movies: {
      label: "Movies",
      managers: ["radarr"],
      indexers: ["prowlarr"],
      downloaders: ["sabnzbd"],
      staging: ["/mnt/user/media-downloads/video"],
      importAuthority: ["radarr"],
      library: ["/mnt/user/media-stack/movies"],
      servedBy: ["jellyfin"],
      notes: ["Radarr owns movie import, rename, and organization after SABnzbd completes downloads."],
    },
    music: {
      label: "Music",
      managers: ["lidarr"],
      indexers: ["prowlarr"],
      downloaders: ["sabnzbd", "slskd"],
      staging: ["/mnt/user/media-downloads/music/inbox", "/mnt/user/media-downloads/music/inbox/slskd"],
      importAuthority: ["beets-flask"],
      library: ["/mnt/user/media-stack/music"],
      servedBy: ["jellyfin", "lidarr"],
      notes: [
        "Lidarr manages artist/library intent, but beets-flask is the music tagging/import authority.",
        "Music imports may require beets-flask approval before landing in the final library.",
      ],
    },
  } satisfies Record<string, MediaFlow>,
  serviceRoles: {
    sonarr: ["tv manager", "tv import authority"],
    radarr: ["movie manager", "movie import authority"],
    lidarr: ["music manager", "artist/library intent"],
    prowlarr: ["indexer hub", "no media storage responsibility"],
    sabnzbd: ["usenet downloader", "video staging", "music inbox contributor"],
    jellyfin: ["media server", "library reader"],
    slskd: ["soulseek downloader", "music inbox contributor"],
    "beets-flask": ["music metadata/tagging", "music import authority"],
    recyclarr: ["quality profile sync for Sonarr/Radarr"],
    dispatcharr: ["IPTV proxy for Jellyfin"],
    jellyplexsync: ["watched-state sync"],
  },
  expectations: {
    serviceIssues: [
      {
        service: "lidarr",
        source: "ImportMechanismCheck",
        messageIncludes: "Completed Download Handling",
        interpretation:
          "Expected by stack design when beets-flask is handling music imports; verify beets-flask inbox/import health instead of treating Lidarr as the import authority.",
        verifyWith: ["beets-flask", "music inbox", "jellyfin music library"],
      },
    ] satisfies ExpectedServiceIssue[],
    notApplicable: [
      {
        service: "prowlarr",
        capability: "diskspace",
        interpretation: "Prowlarr manages indexers only and does not own media storage paths.",
      },
    ],
  },
} as const;

export type StackFlowName = keyof typeof stackModel.flows;

export function getStackModel() {
  return stackModel;
}

export function getStackFlow(mediaType?: StackFlowName) {
  if (mediaType) return stackModel.flows[mediaType];
  return stackModel.flows;
}

export function expectedServiceIssue(service: AppName, issue: { source?: unknown; message?: unknown }) {
  const source = typeof issue.source === "string" ? issue.source : undefined;
  const message = typeof issue.message === "string" ? issue.message : "";
  return stackModel.expectations.serviceIssues.find((expectation) => {
    if (expectation.service !== service) return false;
    if (expectation.source && expectation.source !== source) return false;
    return message.includes(expectation.messageIncludes);
  });
}

