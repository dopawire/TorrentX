/**
 * Single source of truth for every source domain/mirror TorrentX may contact.
 *
 * Adapters import their mirror list from here and dns-warmup.ts derives its
 * DNS pre-resolution list from the same arrays — so adding or removing a
 * mirror in one place keeps both in sync (they used to drift apart).
 */

// ---- multi-mirror sources (raced by raceMirrors) ----

export const YTS_DOMAINS = [
  "movies-api.accel.li",
  "yts.lt",
  "yts.gg",
  "yts.mx",
  "yts.am",
  "yts.do",
];

export const LEET1337X_DOMAINS = [
  "1337x.to",
  "1337x.st",
  "1337x.gd",
  "1337x.is",
];

export const EZTV_DOMAINS = [
  "eztvx.to",
  "eztv.re",
  "eztv1.xyz",
  "eztv.wf",
  "eztv.tf",
  "eztv.yt",
];

export const TORRENTGALAXY_DOMAINS = [
  "torrentgalaxy.one",
  "torrentgalaxy.to",
  "torrentgalaxy.mx",
  "tgx.rs",
];

export const SOLIDTORRENTS_DOMAINS = ["solidtorrents.to", "solidtorrents.net"];

export const LIMETORRENTS_DOMAINS = [
  "www.limetorrents.lol",
  "www.limetorrents.pro",
  "limetorrents.cc",
];

export const BITSEARCH_DOMAINS = ["bitsearch.to"];

// ---- single-endpoint sources (hostnames) ----

export const PIRATEBAY_HOST = "apibay.org";
export const NYAA_HOST = "nyaa.si";
export const SUBSPLEASE_HOST = "subsplease.org";
export const FITGIRL_HOST = "fitgirl-repacks.site";
export const FMHY_API_HOST = "api.fmhy.net";

/**
 * Every host worth pre-resolving at startup, ordered so the fastest JSON-API
 * sources come first (warmupDnsFast warms this prefix).
 */
export const ALL_SOURCE_HOSTS: string[] = [
  // JSON API sources (fastest, warm first)
  ...YTS_DOMAINS.slice(0, 2),
  NYAA_HOST,
  SUBSPLEASE_HOST,
  ...EZTV_DOMAINS.slice(0, 2),
  PIRATEBAY_HOST,
  ...SOLIDTORRENTS_DOMAINS.slice(0, 1),
  BITSEARCH_DOMAINS[0]!,
  FITGIRL_HOST,
  FMHY_API_HOST,
  // HTML scraping mirrors
  ...YTS_DOMAINS.slice(2),
  ...LEET1337X_DOMAINS,
  ...EZTV_DOMAINS.slice(2),
  ...TORRENTGALAXY_DOMAINS,
  ...SOLIDTORRENTS_DOMAINS.slice(1),
  ...LIMETORRENTS_DOMAINS,
];
