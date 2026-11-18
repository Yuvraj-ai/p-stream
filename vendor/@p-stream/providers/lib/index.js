import * as cheerio from "cheerio";
import { load } from "cheerio";
import ISO6391 from "iso-639-1";
import { customAlphabet } from "nanoid";
import * as unpacker from "unpacker";
import { unpack as unpack$2 } from "unpacker";
import CryptoJS from "crypto-js";
import Fuse from "fuse.js";
import { parse, stringify } from "hls-parser";
import FormData from "form-data";
class NotFoundError extends Error {
  constructor(reason) {
    super(`Couldn't find a stream: ${reason ?? "not found"}`);
    this.name = "NotFoundError";
  }
}
function formatSourceMeta(v) {
  const types = [];
  if (v.scrapeMovie) types.push("movie");
  if (v.scrapeShow) types.push("show");
  return {
    type: "source",
    id: v.id,
    rank: v.rank,
    name: v.name,
    flags: v.flags,
    mediaTypes: types
  };
}
function formatEmbedMeta(v) {
  return {
    type: "embed",
    id: v.id,
    rank: v.rank,
    name: v.name,
    flags: v.flags
  };
}
function getAllSourceMetaSorted(list) {
  return list.sources.sort((a, b) => b.rank - a.rank).map(formatSourceMeta);
}
function getAllEmbedMetaSorted(list) {
  return list.embeds.sort((a, b) => b.rank - a.rank).map(formatEmbedMeta);
}
function getSpecificId(list, id) {
  const foundSource = list.sources.find((v) => v.id === id);
  if (foundSource) {
    return formatSourceMeta(foundSource);
  }
  const foundEmbed = list.embeds.find((v) => v.id === id);
  if (foundEmbed) {
    return formatEmbedMeta(foundEmbed);
  }
  return null;
}
function makeFullUrl(url, ops) {
  let leftSide = (ops == null ? void 0 : ops.baseUrl) ?? "";
  let rightSide = url;
  if (leftSide.length > 0 && !leftSide.endsWith("/")) leftSide += "/";
  if (rightSide.startsWith("/")) rightSide = rightSide.slice(1);
  const fullUrl = leftSide + rightSide;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://") && !fullUrl.startsWith("data:"))
    throw new Error(`Invald URL -- URL doesn't start with a http scheme: '${fullUrl}'`);
  const parsedUrl = new URL(fullUrl);
  Object.entries((ops == null ? void 0 : ops.query) ?? {}).forEach(([k, v]) => {
    parsedUrl.searchParams.set(k, v);
  });
  return parsedUrl.toString();
}
function makeFetcher(fetcher) {
  const newFetcher = (url, ops) => {
    return fetcher(url, {
      headers: (ops == null ? void 0 : ops.headers) ?? {},
      method: (ops == null ? void 0 : ops.method) ?? "GET",
      query: (ops == null ? void 0 : ops.query) ?? {},
      baseUrl: (ops == null ? void 0 : ops.baseUrl) ?? "",
      readHeaders: (ops == null ? void 0 : ops.readHeaders) ?? [],
      body: ops == null ? void 0 : ops.body,
      credentials: ops == null ? void 0 : ops.credentials
    });
  };
  const output = async (url, ops) => (await newFetcher(url, ops)).body;
  output.full = newFetcher;
  return output;
}
const flags = {
  // CORS are set to allow any origin
  CORS_ALLOWED: "cors-allowed",
  // the stream is locked on IP, so only works if
  // request maker is same as player (not compatible with proxies)
  IP_LOCKED: "ip-locked",
  // The source/embed is blocking cloudflare ip's
  // This flag is not compatible with a proxy hosted on cloudflare
  CF_BLOCKED: "cf-blocked",
  // Streams and sources with this flag wont be proxied
  // And will be exclusive to the extension
  PROXY_BLOCKED: "proxy-blocked",
  // The stream is MKV format and requires a player that supports it.
  // Most browsers cannot play MKV; native/desktop/mobile apps with proper players can.
  MKV_REQUIRED: "mkv-required"
};
const targets = {
  // browser with CORS restrictions
  BROWSER: "browser",
  // browser, but no CORS restrictions through a browser extension
  BROWSER_EXTENSION: "browser-extension",
  // native app, so no restrictions in what can be played
  NATIVE: "native",
  // any target, no target restrictions
  ANY: "any"
};
const targetToFeatures = {
  browser: {
    requires: [flags.CORS_ALLOWED],
    disallowed: [flags.MKV_REQUIRED]
  },
  "browser-extension": {
    requires: [],
    disallowed: [flags.MKV_REQUIRED]
  },
  native: {
    requires: [],
    disallowed: []
  },
  any: {
    requires: [],
    disallowed: [flags.MKV_REQUIRED]
  }
};
function getTargetFeatures(target, consistentIpForRequests, proxyStreams) {
  const features = targetToFeatures[target];
  if (!consistentIpForRequests) features.disallowed.push(flags.IP_LOCKED);
  if (proxyStreams) features.disallowed.push(flags.PROXY_BLOCKED);
  return features;
}
function flagsAllowedInFeatures(features, inputFlags) {
  const hasAllFlags = features.requires.every((v) => inputFlags.includes(v));
  if (!hasAllFlags) return false;
  const hasDisallowedFlag = features.disallowed.some((v) => inputFlags.includes(v));
  if (hasDisallowedFlag) return false;
  return true;
}
const DEFAULT_PROXY_URL = "https://proxy.example.com";
let CONFIGURED_M3U8_PROXY_URL = "https://proxy.example.com";
function setM3U8ProxyUrl(proxyUrl) {
  CONFIGURED_M3U8_PROXY_URL = proxyUrl;
}
function getM3U8ProxyUrl() {
  return CONFIGURED_M3U8_PROXY_URL;
}
function requiresProxy(stream) {
  if (!stream.flags.includes(flags.CORS_ALLOWED) || !!(stream.headers && Object.keys(stream.headers).length > 0))
    return true;
  return false;
}
function setupProxy(stream) {
  const headers2 = stream.headers && Object.keys(stream.headers).length > 0 ? stream.headers : void 0;
  const options = {
    ...stream.type === "hls" && { depth: stream.proxyDepth ?? 0 }
  };
  const payload = {
    headers: headers2,
    options
  };
  if (stream.type === "hls") {
    payload.type = "hls";
    payload.url = stream.playlist;
    stream.playlist = `${DEFAULT_PROXY_URL}?${new URLSearchParams({ payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })}`;
  }
  if (stream.type === "file") {
    payload.type = "mp4";
    Object.entries(stream.qualities).forEach((entry) => {
      payload.url = entry[1].url;
      entry[1].url = `${DEFAULT_PROXY_URL}?${new URLSearchParams({ payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })}`;
    });
  }
  stream.headers = {};
  stream.flags = [flags.CORS_ALLOWED];
  return stream;
}
function createM3U8ProxyUrl(url, features, headers2 = {}) {
  if (features && !features.requires.includes(flags.CORS_ALLOWED)) {
    return url;
  }
  const encodedUrl = encodeURIComponent(url);
  const encodedHeaders = encodeURIComponent(JSON.stringify(headers2));
  return `${CONFIGURED_M3U8_PROXY_URL}/m3u8-proxy?url=${encodedUrl}${headers2 ? `&headers=${encodedHeaders}` : ""}`;
}
function updateM3U8ProxyUrl(url) {
  if (url.includes("/m3u8-proxy?url=")) {
    return url.replace(/https:\/\/[^/]+\/m3u8-proxy/, `${CONFIGURED_M3U8_PROXY_URL}/m3u8-proxy`);
  }
  return url;
}
function makeSourcerer(state) {
  const mediaTypes = [];
  if (state.scrapeMovie) mediaTypes.push("movie");
  if (state.scrapeShow) mediaTypes.push("show");
  return {
    ...state,
    type: "source",
    disabled: state.disabled ?? false,
    externalSource: state.externalSource ?? false,
    mediaTypes
  };
}
function makeEmbed(state) {
  return {
    ...state,
    type: "embed",
    disabled: state.disabled ?? false,
    mediaTypes: void 0
  };
}
async function comboScraper$y(ctx) {
  const embedPage = await ctx.proxiedFetcher(
    `https://bombthe.irish/embed/${ctx.media.type === "movie" ? `movie/${ctx.media.tmdbId}` : `tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`
  );
  const $ = load(embedPage);
  const embeds = [];
  $("#dropdownMenu a").each((_, element) => {
    const url = new URL($(element).data("url")).searchParams.get("url");
    if (!url) return;
    embeds.push({ embedId: $(element).text().toLowerCase(), url: atob(url) });
  });
  return { embeds };
}
const bombtheirishScraper = makeSourcerer({
  id: "bombtheirish",
  name: "bombthe.irish",
  rank: 100,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$y,
  scrapeShow: comboScraper$y
});
const providers$5 = [
  {
    id: "streamtape",
    name: "Streamtape",
    rank: 160
  },
  {
    id: "streamtape-latino",
    name: "Streamtape (Latino)",
    rank: 159
  }
];
function embed$4(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    flags: [flags.CORS_ALLOWED],
    // No longer IP locked
    async scrape(ctx) {
      var _a;
      const embedHtml = await ctx.proxiedFetcher(ctx.url);
      const match = embedHtml.match(/robotlink'\).innerHTML = (.*)'/);
      if (!match) throw new Error("No match found");
      const [fh, sh] = ((_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.split("+ ('")) ?? [];
      if (!fh || !sh) throw new Error("No match found");
      const url = `https:${fh == null ? void 0 : fh.replace(/'/g, "").trim()}${sh == null ? void 0 : sh.substring(3).trim()}`;
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            flags: [flags.CORS_ALLOWED],
            // No longer IP locked
            captions: [],
            qualities: {
              unknown: {
                type: "mp4",
                url
              }
            },
            preferredHeaders: {
              Referer: "https://streamtape.com"
            }
          }
        ]
      };
    }
  });
}
const [streamtapeScraper, streamtapeLatinoScraper] = providers$5.map(embed$4);
const warezcdnBase = "https://embed.warezcdn.link";
const warezcdnPlayerBase = "https://warezcdn.link/player";
const warezcdnWorkerProxy = "https://workerproxy.warezcdn.workers.dev";
function decrypt$1(input) {
  let output = atob(input);
  output = output.trim();
  output = output.split("").reverse().join("");
  let last = output.slice(-5);
  last = last.split("").reverse().join("");
  output = output.slice(0, -5);
  return `${output}${last}`;
}
async function getDecryptedId(ctx) {
  var _a;
  const page = await ctx.proxiedFetcher(`/player.php`, {
    baseUrl: warezcdnPlayerBase,
    headers: {
      Referer: `${warezcdnPlayerBase}/getEmbed.php?${new URLSearchParams({
        id: ctx.url,
        sv: "warezcdn"
      })}`
    },
    query: {
      id: ctx.url
    }
  });
  const allowanceKey = (_a = page.match(/let allowanceKey = "(.*?)";/)) == null ? void 0 : _a[1];
  if (!allowanceKey) throw new NotFoundError("Failed to get allowanceKey");
  const streamData = await ctx.proxiedFetcher("/functions.php", {
    baseUrl: warezcdnPlayerBase,
    method: "POST",
    body: new URLSearchParams({
      getVideo: ctx.url,
      key: allowanceKey
    })
  });
  const stream = JSON.parse(streamData);
  if (!stream.id) throw new NotFoundError("can't get stream id");
  const decryptedId = decrypt$1(stream.id);
  if (!decryptedId) throw new NotFoundError("can't get file id");
  return decryptedId;
}
const cdnListing = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64];
async function checkUrls(ctx, fileId) {
  for (const id of cdnListing) {
    const url = `https://cloclo${id}.cloud.mail.ru/weblink/view/${fileId}`;
    const response = await ctx.proxiedFetcher.full(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-1"
      }
    });
    if (response.statusCode === 206) return url;
  }
  return null;
}
const warezcdnembedMp4Scraper = makeEmbed({
  id: "warezcdnembedmp4",
  // WarezCDN is both a source and an embed host
  name: "WarezCDN MP4",
  // method no longer works
  rank: 82,
  flags: [flags.CORS_ALLOWED],
  disabled: true,
  async scrape(ctx) {
    const decryptedId = await getDecryptedId(ctx);
    if (!decryptedId) throw new NotFoundError("can't get file id");
    const streamUrl = await checkUrls(ctx, decryptedId);
    if (!streamUrl) throw new NotFoundError("can't get stream id");
    return {
      stream: [
        {
          id: "primary",
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: `${warezcdnWorkerProxy}/?${new URLSearchParams({
                url: streamUrl
              })}`
            }
          },
          type: "file",
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const SKIP_VALIDATION_CHECK_IDS = [
  warezcdnembedMp4Scraper.id,
  streamtapeScraper.id
  // deltaScraper.id,
  // alphaScraper.id,
  // novaScraper.id,
  // astraScraper.id,
  // orionScraper.id,
];
const UNPROXIED_VALIDATION_CHECK_IDS = [
  // sources here are always proxied, so we dont need to validate with a proxy
  bombtheirishScraper.id
  // this one is dead, but i'll keep it here for now
];
function isValidStream(stream) {
  if (!stream) return false;
  if (stream.type === "hls") {
    if (!stream.playlist) return false;
    return true;
  }
  if (stream.type === "file") {
    const validQualities = Object.values(stream.qualities).filter((v) => v.url.length > 0);
    if (validQualities.length === 0) return false;
    return true;
  }
  return false;
}
function isAlreadyProxyUrl(url) {
  return url.includes("/m3u8-proxy?url=") || url.includes("shegu.net");
}
function isErrorResponse(result) {
  if (result.statusCode === 403) return true;
  const bodyStr = typeof result.body === "string" ? result.body : String(result.body);
  if (result.statusCode === 200 && bodyStr.trim() === "error_wrong_ip") return true;
  if (result.statusCode === 200) {
    try {
      const parsed = JSON.parse(bodyStr);
      if (parsed.status === 403 && parsed.msg === "Access Denied") return true;
    } catch {
    }
  }
  return false;
}
async function validatePlayableStream(stream, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return stream;
  if (stream.skipValidation) return stream;
  const alwaysUseNormalFetch = UNPROXIED_VALIDATION_CHECK_IDS.includes(sourcererId);
  if (stream.type === "hls") {
    if (stream.playlist.startsWith("data:")) return stream;
    const useNormalFetch = alwaysUseNormalFetch || isAlreadyProxyUrl(stream.playlist);
    let result;
    if (useNormalFetch) {
      try {
        const response = await fetch(stream.playlist, {
          method: "GET",
          headers: {
            ...stream.preferredHeaders,
            ...stream.headers
          },
          signal: AbortSignal.timeout(2e4)
        });
        result = {
          statusCode: response.status,
          body: await response.text(),
          finalUrl: response.url
        };
      } catch (error) {
        return null;
      }
    } else {
      try {
        result = await Promise.race([
          ops.proxiedFetcher.full(stream.playlist, {
            method: "GET",
            headers: {
              ...stream.preferredHeaders,
              ...stream.headers
            }
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), 2e4);
          })
        ]);
      } catch {
        return null;
      }
    }
    if (result.statusCode < 200 || result.statusCode >= 400 || isErrorResponse(result)) return null;
    return stream;
  }
  if (stream.type === "file") {
    const validQualitiesResults = await Promise.all(
      Object.values(stream.qualities).map(async (quality) => {
        const useNormalFetch = alwaysUseNormalFetch || isAlreadyProxyUrl(quality.url);
        if (useNormalFetch) {
          try {
            const response = await fetch(quality.url, {
              method: "GET",
              headers: {
                ...stream.preferredHeaders,
                ...stream.headers,
                Range: "bytes=0-1"
              },
              signal: AbortSignal.timeout(2e4)
            });
            return {
              statusCode: response.status,
              body: await response.text(),
              finalUrl: response.url
            };
          } catch (error) {
            return { statusCode: 500, body: "", finalUrl: quality.url };
          }
        }
        try {
          return await Promise.race([
            ops.proxiedFetcher.full(quality.url, {
              method: "GET",
              headers: {
                ...stream.preferredHeaders,
                ...stream.headers,
                Range: "bytes=0-1"
              }
            }),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("Timeout")), 2e4);
            })
          ]);
        } catch {
          return { statusCode: 500, body: "", finalUrl: quality.url };
        }
      })
    );
    const validQualities = stream.qualities;
    Object.keys(stream.qualities).forEach((quality, index) => {
      if (validQualitiesResults[index].statusCode < 200 || validQualitiesResults[index].statusCode >= 400 || isErrorResponse(validQualitiesResults[index])) {
        delete validQualities[quality];
      }
    });
    if (Object.keys(validQualities).length === 0) return null;
    return { ...stream, qualities: validQualities };
  }
  return null;
}
async function validatePlayableStreams(streams, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return streams;
  return (await Promise.all(streams.map((stream) => validatePlayableStream(stream, ops, sourcererId)))).filter(
    (v) => v !== null
  );
}
async function scrapeInvidualSource(list, ops) {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper) throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie) throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow) throw new Error("Source is not compatible with shows");
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    features: ops.features,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: sourceScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  };
  let output = null;
  if (ops.media.type === "movie" && sourceScraper.scrapeMovie)
    output = await sourceScraper.scrapeMovie({
      ...contextBase,
      media: ops.media
    });
  else if (ops.media.type === "show" && sourceScraper.scrapeShow)
    output = await sourceScraper.scrapeShow({
      ...contextBase,
      media: ops.media
    });
  if (output == null ? void 0 : output.stream) {
    output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
    output.stream = output.stream.map(
      (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
    );
  }
  if (!output) throw new Error("output is null");
  output.embeds = output.embeds.filter((embed2) => {
    const e = list.embeds.find((v) => v.id === embed2.embedId);
    if (!e || e.disabled) return false;
    return true;
  });
  if ((!output.stream || output.stream.length === 0) && output.embeds.length === 0)
    throw new NotFoundError("No streams found");
  if (output.stream && output.stream.length > 0 && output.embeds.length === 0) {
    const playableStreams = await validatePlayableStreams(output.stream, ops, sourceScraper.id);
    if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
    output.stream = playableStreams;
  }
  return output;
}
async function scrapeIndividualEmbed(list, ops) {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper) throw new Error("Embed with ID not found");
  const url = ops.url;
  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    features: ops.features,
    url,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: embedScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  });
  output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
  if (output.stream.length === 0) throw new NotFoundError("No streams found");
  output.stream = output.stream.map(
    (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
  );
  const playableStreams = await validatePlayableStreams(output.stream, ops, embedScraper.id);
  if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
  output.stream = playableStreams;
  return output;
}
function reorderOnIdList(order, list) {
  const copy = [...list];
  copy.sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
    if (bIndex >= 0) return 1;
    if (aIndex >= 0) return -1;
    return b.rank - a.rank;
  });
  return copy;
}
async function runAllProviders(list, ops) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((source) => {
    if (ops.media.type === "movie") return !!source.scrapeMovie;
    if (ops.media.type === "show") return !!source.scrapeShow;
    return false;
  });
  const embeds = reorderOnIdList(ops.embedOrder ?? [], list.embeds);
  const embedIds = embeds.map((embed2) => embed2.id);
  let lastId = "";
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    features: ops.features,
    progress(val) {
      var _a2, _b2;
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.update) == null ? void 0 : _b2.call(_a2, {
        id: lastId,
        percentage: val,
        status: "pending"
      });
    }
  };
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  for (const source of sources) {
    (_d = (_c = ops.events) == null ? void 0 : _c.start) == null ? void 0 : _d.call(_c, source.id);
    lastId = source.id;
    let output = null;
    try {
      if (ops.media.type === "movie" && source.scrapeMovie)
        output = await source.scrapeMovie({
          ...contextBase,
          media: ops.media
        });
      else if (ops.media.type === "show" && source.scrapeShow)
        output = await source.scrapeShow({
          ...contextBase,
          media: ops.media
        });
      if (output) {
        output.stream = (output.stream ?? []).filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        output.stream = output.stream.map(
          (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
        );
      }
      if (!output || !((_e = output.stream) == null ? void 0 : _e.length) && !output.embeds.length) {
        throw new NotFoundError("No streams found");
      }
    } catch (error) {
      const updateParams = {
        id: source.id,
        percentage: 100,
        status: error instanceof NotFoundError ? "notfound" : "failure",
        reason: error instanceof NotFoundError ? error.message : void 0,
        error: error instanceof NotFoundError ? void 0 : error
      };
      (_g = (_f = ops.events) == null ? void 0 : _f.update) == null ? void 0 : _g.call(_f, updateParams);
      continue;
    }
    if (!output) throw new Error("Invalid media type");
    if ((_h = output.stream) == null ? void 0 : _h[0]) {
      try {
        const playableStream = await validatePlayableStream(output.stream[0], ops, source.id);
        if (!playableStream) throw new NotFoundError("No streams found");
        return {
          sourceId: source.id,
          stream: playableStream
        };
      } catch (error) {
        const updateParams = {
          id: source.id,
          percentage: 100,
          status: error instanceof NotFoundError ? "notfound" : "failure",
          reason: error instanceof NotFoundError ? error.message : "Stream validation failed",
          error: error instanceof NotFoundError ? void 0 : error
        };
        (_j = (_i = ops.events) == null ? void 0 : _i.update) == null ? void 0 : _j.call(_i, updateParams);
      }
    }
    const sortedEmbeds = output.embeds.filter((embed2) => {
      const e = list.embeds.find((v) => v.id === embed2.embedId);
      return e && !e.disabled;
    }).sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));
    if (sortedEmbeds.length > 0) {
      (_l = (_k = ops.events) == null ? void 0 : _k.discoverEmbeds) == null ? void 0 : _l.call(_k, {
        embeds: sortedEmbeds.map((embed2, i) => ({
          id: [source.id, i].join("-"),
          embedScraperId: embed2.embedId
        })),
        sourceId: source.id
      });
    }
    for (const [ind, embed2] of sortedEmbeds.entries()) {
      const scraper = embeds.find((v) => v.id === embed2.embedId);
      if (!scraper) throw new Error("Invalid embed returned");
      const id = [source.id, ind].join("-");
      (_n = (_m = ops.events) == null ? void 0 : _m.start) == null ? void 0 : _n.call(_m, id);
      lastId = id;
      let embedOutput;
      try {
        embedOutput = await scraper.scrape({
          ...contextBase,
          url: embed2.url
        });
        embedOutput.stream = embedOutput.stream.filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        embedOutput.stream = embedOutput.stream.map(
          (stream) => requiresProxy(stream) && ops.proxyStreams ? setupProxy(stream) : stream
        );
        if (embedOutput.stream.length === 0) {
          throw new NotFoundError("No streams found");
        }
        const playableStream = await validatePlayableStream(embedOutput.stream[0], ops, embed2.embedId);
        if (!playableStream) throw new NotFoundError("No streams found");
        embedOutput.stream = [playableStream];
      } catch (error) {
        const updateParams = {
          id,
          percentage: 100,
          status: error instanceof NotFoundError ? "notfound" : "failure",
          reason: error instanceof NotFoundError ? error.message : void 0,
          error: error instanceof NotFoundError ? void 0 : error
        };
        (_p = (_o = ops.events) == null ? void 0 : _o.update) == null ? void 0 : _p.call(_o, updateParams);
        continue;
      }
      return {
        sourceId: source.id,
        embedId: scraper.id,
        stream: embedOutput.stream[0]
      };
    }
  }
  return null;
}
function makeControls(ops) {
  const list = {
    embeds: ops.embeds,
    sources: ops.sources
  };
  const providerRunnerOps = {
    features: ops.features,
    fetcher: makeFetcher(ops.fetcher),
    proxiedFetcher: makeFetcher(ops.proxiedFetcher ?? ops.fetcher),
    proxyStreams: ops.proxyStreams
  };
  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    }
  };
}
const captionTypes = {
  srt: "srt",
  vtt: "vtt"
};
function getCaptionTypeFromUrl(url) {
  const extensions = Object.keys(captionTypes);
  const type = extensions.find((v) => url.endsWith(`.${v}`));
  if (!type) return null;
  return type;
}
function labelToLanguageCode(label) {
  const languageMap = {
    "chinese - hong kong": "zh",
    "chinese - traditional": "zh",
    czech: "cs",
    danish: "da",
    dutch: "nl",
    english: "en",
    "english - sdh": "en",
    finnish: "fi",
    french: "fr",
    german: "de",
    greek: "el",
    hungarian: "hu",
    italian: "it",
    korean: "ko",
    norwegian: "no",
    polish: "pl",
    portuguese: "pt",
    "portuguese - brazilian": "pt",
    romanian: "ro",
    "spanish - european": "es",
    "spanish - latin american": "es",
    spanish: "es",
    swedish: "sv",
    turkish: "tr",
    اَلْعَرَبِيَّةُ: "ar",
    বাংলা: "bn",
    filipino: "tl",
    indonesia: "id",
    اردو: "ur",
    English: "en",
    Arabic: "ar",
    Bosnian: "bs",
    Bulgarian: "bg",
    Croatian: "hr",
    Czech: "cs",
    Danish: "da",
    Dutch: "nl",
    Estonian: "et",
    Finnish: "fi",
    French: "fr",
    German: "de",
    Greek: "el",
    Hebrew: "he",
    Hungarian: "hu",
    Indonesian: "id",
    Italian: "it",
    Norwegian: "no",
    Persian: "fa",
    "farsi/persian": "fa",
    Polish: "pl",
    Portuguese: "pt",
    "Protuguese (BR)": "pt-br",
    Romanian: "ro",
    Russian: "ru",
    russian: "ru",
    Serbian: "sr",
    Slovenian: "sl",
    Spanish: "es",
    Swedish: "sv",
    Thai: "th",
    Turkish: "tr",
    // Simple language codes
    ng: "en",
    re: "fr",
    pa: "es"
  };
  const mappedCode = languageMap[label.toLowerCase()];
  if (mappedCode) return mappedCode;
  const code = ISO6391.getCode(label);
  if (code.length === 0) return null;
  return code;
}
function removeDuplicatedLanguages(list) {
  const beenSeen = {};
  return list.filter((sub) => {
    if (beenSeen[sub.language]) return false;
    beenSeen[sub.language] = true;
    return true;
  });
}
function headersToPlain(headers2) {
  if (!headers2) return {};
  if (typeof headers2.entries === "function") {
    try {
      return Object.fromEntries(headers2.entries());
    } catch {
    }
  }
  if (typeof headers2 === "object") return { ...headers2 };
  return {};
}
const ZANGETSU_READ_HEADERS = [
  "location",
  "hx-redirect",
  "set-cookie",
  "cookie",
  "content-type",
  "content-length",
  "accept-ranges",
  "x-final-destination",
  "x-set-cookie"
];
function makeZangetsuFetch(fetcher) {
  return async (url, options) => {
    const headers2 = { ...(options == null ? void 0 : options.headers) ?? {} };
    if ((options == null ? void 0 : options.followRedirects) === false) headers2["X-No-Follow"] = "1";
    const timeoutMs = Number((options == null ? void 0 : options.timeoutMs) ?? 0);
    const request = fetcher.full(url, {
      method: (options == null ? void 0 : options.method) ?? "GET",
      headers: headers2,
      body: typeof (options == null ? void 0 : options.body) === "string" ? options.body : void 0,
      readHeaders: ZANGETSU_READ_HEADERS
    });
    const res = timeoutMs > 0 ? await Promise.race([
      request,
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)
      )
    ]) : await request;
    const rawBody = res.body;
    const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? "");
    return {
      ok: res.statusCode >= 200 && res.statusCode < 400,
      status: res.statusCode,
      statusText: "",
      headers: headersToPlain(res.headers),
      url: res.finalUrl || url,
      body,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  };
}
function htmlText(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>/g, "").replace(
    /&#x([0-9a-fA-F]+);/g,
    (_, h) => String.fromCodePoint(parseInt(h, 16))
  ).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();
}
function absUrl(href, base) {
  if (!href) return "";
  const h = String(href);
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return `https:${h}`;
  if (!base) return h;
  if (h.startsWith("/")) {
    const m = base.match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] + h : h;
  }
  return `${base.replace(/\/$/, "")}/${h}`;
}
function unpackJs(source) {
  const s = String(source);
  const open = s.indexOf("}('");
  const close = s.indexOf(".split('|'),0{}))");
  const markerEnd = s.indexOf(".split('|')");
  if (open === -1 || markerEnd <= open) return s;
  const end = close !== -1 && close > open ? close : markerEnd;
  const body = s.slice(open + 3, end);
  let idx = 0;
  while (idx < body.length && body.charAt(idx) !== "'") {
    idx += body.charAt(idx) === "\\" ? 2 : 1;
  }
  if (body.charAt(idx + 1) !== ",") return s;
  const payload = body.slice(0, idx).replace(/\\'/g, "'");
  const tail = body.slice(idx + 2);
  let radix = parseInt(tail, 10);
  if (!(radix >= 2 && radix <= 62)) radix = 62;
  const dictStart = tail.indexOf("'");
  const dictEnd = tail.lastIndexOf("'");
  if (dictStart === -1 || dictEnd <= dictStart) return s;
  const dict = tail.slice(dictStart + 1, dictEnd).split("|");
  const unbase = (t) => {
    let a = 0;
    for (const c of t) {
      const d = c <= "9" ? c.charCodeAt(0) - 48 : c >= "a" ? c.charCodeAt(0) - 87 : c.charCodeAt(0) - 29;
      if (d >= radix) return -1;
      a = a * radix + d;
    }
    return a;
  };
  return payload.replace(/[0-9A-Za-z]+/g, (k) => {
    const i = unbase(k);
    return i >= 0 && i < dict.length && dict[i] !== "" ? dict[i] : k;
  });
}
function base64ToBytes(b64) {
  const s = String(b64 ?? "");
  try {
    const bin = atob(s);
    const out = [];
    for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i) & 255);
    return out;
  } catch {
    return [];
  }
}
function bytesToB64(bytes) {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b & 255);
  });
  return btoa(bin);
}
function bytesToHex(bytes) {
  return bytes.map((b) => (b & 255).toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(message) {
  const data = new TextEncoder().encode(String(message));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function aesCtrDecrypt(opts) {
  const key2 = new Uint8Array(
    opts.keyHex.match(/.{2}/g).map((h) => parseInt(h, 16))
  );
  const counter = new Uint8Array(
    opts.counterHex.match(/.{2}/g).map((h) => parseInt(h, 16))
  );
  const data = new Uint8Array(base64ToBytes(opts.dataB64));
  const imported = await crypto.subtle.importKey(
    "raw",
    key2,
    { name: "AES-CTR" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter, length: 32 },
    imported,
    data
  );
  return new TextDecoder().decode(plain);
}
async function aesCbcDecryptB64Url(dataB64Url, keyStr, ivStr) {
  const s = String(dataB64Url ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const ct = new Uint8Array(base64ToBytes(s));
  const keyBytes = new Uint8Array(32);
  const ivBytes = new Uint8Array(16);
  const keyRaw = String(keyStr ?? "");
  const ivRaw = String(ivStr ?? "");
  for (let i = 0; i < keyRaw.length && i < 32; i++)
    keyBytes[i] = keyRaw.charCodeAt(i) & 255;
  for (let i = 0; i < ivRaw.length && i < 16; i++)
    ivBytes[i] = ivRaw.charCodeAt(i) & 255;
  const imported = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    imported,
    ct
  );
  return new TextDecoder().decode(plain);
}
function loadZangetsuProvider(sourceId, js, fetcher, settings = {}) {
  const collector = `;
    return {
      getInfo: typeof getInfo === 'function' ? getInfo : null,
      getHome: typeof getHome === 'function' ? getHome : null,
      search: typeof search === 'function' ? search : null,
      popular: typeof popular === 'function' ? popular : null,
      getDetail: typeof getDetail === 'function' ? getDetail : null,
      getEpisodes: typeof getEpisodes === 'function' ? getEpisodes : null,
      getVideoSources: typeof getVideoSources === 'function' ? getVideoSources : null,
    };`;
  const shimConsole = {
    log: (...args) => console.log(`[zangetsu/${sourceId}]`, ...args),
    warn: (...args) => console.warn(`[zangetsu/${sourceId}]`, ...args),
    error: (...args) => console.error(`[zangetsu/${sourceId}]`, ...args)
  };
  const factory = new Function(
    "__SOURCE_ID",
    "__settings",
    "fetch",
    "htmlText",
    "absUrl",
    "unpackJs",
    "console",
    "base64ToBytes",
    "bytesToB64",
    "bytesToHex",
    "sha256Hex",
    "aesCtrDecrypt",
    "aesCbcDecryptB64Url",
    `${js}${collector}`
  );
  return factory(
    sourceId,
    settings,
    makeZangetsuFetch(fetcher),
    htmlText,
    absUrl,
    unpackJs,
    shimConsole,
    base64ToBytes,
    bytesToB64,
    bytesToHex,
    sha256Hex,
    aesCtrDecrypt,
    aesCbcDecryptB64Url
  );
}
function b64urlEncode(input) {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function normalizeTitle$7(title) {
  return String(title ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}
function cleanHeaders(headers2) {
  const out = {};
  if (!headers2) return out;
  Object.entries(headers2).forEach(([k, v]) => {
    if (typeof v === "string" && v.trim().length > 0) out[k] = v;
  });
  return out;
}
function scoreItem(item, title, year) {
  const itemTitle = normalizeTitle$7(item.title);
  const wanted = normalizeTitle$7(title);
  if (!itemTitle || !wanted) return 0;
  let score = 0;
  if (itemTitle === wanted) score = 100;
  else if (itemTitle.startsWith(wanted) || wanted.startsWith(itemTitle)) score = 80;
  else if (itemTitle.includes(wanted) || wanted.includes(itemTitle)) score = 60;
  if (score > 0 && year && itemTitle.includes(String(year))) score += 15;
  return score;
}
function pickBestItem(results, title, year) {
  let best = null;
  let bestScore = 0;
  results.forEach((item) => {
    if (!item || item.url == null && item.id == null) return;
    const score = scoreItem(item, title, year);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  });
  return best;
}
function pickEpisode(episodes, seasonNumber, episodeNumber) {
  const usable = episodes.filter(
    (ep) => ep && ep.url != null && Number(ep.number) === Number(episodeNumber)
  );
  if (usable.length === 0) return null;
  const withSeason = usable.filter(
    (ep) => ep.season != null && Number(ep.season) === Number(seasonNumber)
  );
  if (withSeason.length > 0) return withSeason[0];
  const withoutSeason = usable.filter((ep) => ep.season == null);
  return withoutSeason[0] ?? usable[0];
}
const QUALITY_MAP = {
  "360": "360",
  "360p": "360",
  "480": "480",
  "480p": "480",
  "720": "720",
  "720p": "720",
  "1080": "1080",
  "1080p": "1080",
  "2160": "4k",
  "2160p": "4k",
  "4k": "4k"
};
function mapQuality(quality) {
  const q = String(quality ?? "").toLowerCase();
  return QUALITY_MAP[q] ?? "unknown";
}
function mapSubtitles(sourceId, streamIdx, subs, streamHeaders) {
  return (subs ?? []).filter((sub) => sub && sub.url).map((sub, i) => {
    const type = ["srt", "vtt"].includes(String(sub.format)) ? sub.format : getCaptionTypeFromUrl(String(sub.url)) ?? "vtt";
    const language = (sub.lang ?? "").length > 0 ? sub.lang : labelToLanguageCode(String(sub.label ?? "")) ?? "en";
    const captionHeaders = {
      Referer: streamHeaders.Referer || streamHeaders.referer || "",
      Origin: streamHeaders.Origin || streamHeaders.origin || "",
      "User-Agent": streamHeaders["User-Agent"] || streamHeaders["user-agent"] || ""
    };
    return {
      id: `${sourceId}-${streamIdx}-sub-${i}`,
      type,
      url: String(sub.url),
      hasCorsRestrictions: true,
      language,
      // Store headers for caption download (used by p-stream's downloadCaption)
      headers: captionHeaders
    };
  });
}
function mapVideoSources(entry, sources, browserNeedsProxy) {
  const proxyBase = getM3U8ProxyUrl().replace(/\/$/, "");
  const streams = [];
  (sources ?? []).forEach((source, idx) => {
    if (!source || typeof source.url !== "string" || source.url.length === 0) return;
    const headers2 = cleanHeaders(source.headers);
    const hasHeaders = Object.keys(headers2).length > 0;
    const container = String(source.container ?? "").toLowerCase();
    const isHls = container === "hls" || /\.m3u8(\?|$)/i.test(source.url);
    const captions = mapSubtitles(entry.id, idx, source.subtitles, headers2);
    const streamId = `${entry.id}-${idx}`;
    if (isHls) {
      const playlist = browserNeedsProxy ? createM3U8ProxyUrl(source.url, { requires: [flags.CORS_ALLOWED] }, headers2) : source.url;
      streams.push({
        type: "hls",
        id: streamId,
        playlist,
        flags: [flags.CORS_ALLOWED],
        captions,
        headers: headers2,
        preferredHeaders: void 0,
        proxyDepth: 0
      });
      return;
    }
    const quality = mapQuality(source.quality);
    let url = source.url;
    if (browserNeedsProxy) {
      const params = new URLSearchParams({ destination: source.url });
      if (hasHeaders) params.set("h", b64urlEncode(JSON.stringify(headers2)));
      url = `${proxyBase}/proxy?${params.toString()}`;
    }
    streams.push({
      type: "file",
      id: streamId,
      qualities: { [quality]: { type: "mp4", url } },
      flags: [flags.CORS_ALLOWED],
      captions,
      headers: headers2,
      preferredHeaders: void 0
    });
  });
  return streams;
}
async function loadResults(provider, title) {
  if (!provider.search) return [];
  const rows = await provider.search(title, 1, {});
  return Array.isArray(rows) ? rows : [];
}
async function loadEpisodes(provider, itemUrl) {
  if (provider.getDetail) {
    const detail = await provider.getDetail(String(itemUrl), {});
    if (detail && Array.isArray(detail.episodes) && detail.episodes.length > 0) {
      return detail.episodes;
    }
  }
  if (provider.getEpisodes) {
    const eps = await provider.getEpisodes(String(itemUrl), {});
    if (Array.isArray(eps)) return eps;
  }
  return [];
}
async function resolveSources(entry, provider, ctx) {
  var _a;
  const browserNeedsProxy = ctx.features.requires.includes(flags.CORS_ALLOWED);
  const results = await loadResults(provider, ctx.media.title);
  const item = pickBestItem(results, ctx.media.title, ctx.media.releaseYear);
  if (!item) throw new NotFoundError(`no ${entry.name} result for "${ctx.media.title}"`);
  let episodeUrl = null;
  if (ctx.media.type === "show") {
    const episodes = await loadEpisodes(provider, item.url ?? item.id);
    const ep = pickEpisode(episodes, ctx.media.season.number, ctx.media.episode.number);
    if (!ep) throw new NotFoundError(`episode ${ctx.media.episode.number} not found on ${entry.name}`);
    episodeUrl = String(ep.url);
  } else {
    const episodes = await loadEpisodes(provider, item.url ?? item.id);
    episodeUrl = ((_a = episodes[0]) == null ? void 0 : _a.url) != null ? String(episodes[0].url) : String(item.url);
  }
  if (!provider.getVideoSources) throw new NotFoundError(`${entry.name} cannot resolve streams`);
  const videoSources = await provider.getVideoSources(episodeUrl, {});
  const streams = mapVideoSources(entry, Array.isArray(videoSources) ? videoSources : [], browserNeedsProxy);
  if (streams.length === 0) throw new NotFoundError(`${entry.name} returned no streams`);
  return { embeds: [], stream: streams };
}
function makeZangetsuSourcerer(entry) {
  const scrape2 = (ctx) => resolveSources(entry, loadZangetsuProvider(entry.id, entry.js, ctx.proxiedFetcher), ctx);
  return {
    id: `zangetsu-${entry.id}`,
    name: entry.name,
    rank: entry.rank,
    disabled: false,
    externalSource: false,
    flags: [flags.CORS_ALLOWED],
    mediaTypes: ["movie", "show"],
    type: "source",
    scrapeMovie: (ctx) => {
      ctx.progress(10);
      return scrape2(ctx);
    },
    scrapeShow: (ctx) => {
      ctx.progress(10);
      return scrape2(ctx);
    }
  };
}
const ZANGETSU_SOURCES = [
  {
    id: "anikoto",
    name: "AniKoto",
    kind: "anime",
    lang: "en",
    rank: 1e3,
    js: `// AniKoto — anime source for the Zangetsu provider repo (anikototv.to).
//
// anikototv.to is an aniwatch-style site. Streams are NOT keyed by the episode
// id — each episode carries an encrypted \`data-ids\` (server_ids) blob, and the
// real player is resolved through the site's own two-step server chain, then
// extracted from the embed host (plain m3u8 + subtitle tracks):
//   /filter?keyword=            -> slug
//   /watch/<slug>               -> anime id (data-id) + metadata
//   /ajax/episode/list/<id>     -> [{ data-id, num, sub, dub, data-ids(server_ids) }]
//   /ajax/server/list?servers=<server_ids> -> server list (VidPlay/HD/Vidstream/…)
//   /ajax/server?get=<link_id>  -> { url: <player embed>, skip_data }
//   <embed host>/stream/getSources(New)?id=<embed data-id> -> m3u8 + subs
//   (MegaPlay/VidWish: both getSources and getSourcesNew now return an AES-CBC
//    \`enc\` blob instead of plain sources.file — decrypted with the player's own
//    TRUST_AES_KEY/IV from megaplay's newclient. VidPlay/vidtube still plain.)
//
// Some episodes only list servers that no longer hand back a plain file. For
// those the site's own player asks a mapper API for EXTRA servers, keyed by the
// <mal>/<episode>/<timestamp> the episode anchors already carry, so we carry
// those three through the episode url and ask the same API when the episode's
// own servers all come up empty.
//
// Home = /home spotlight (hero) + recent from the JSON API (anikotoapi.site);
// slugs are shared with the site, so those cards resolve through getDetail.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'anikoto';

var SITE = 'https://anikototv.to';
var API = 'https://anikotoapi.site';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Embed hosts that hand back a plain m3u8 (via getSources or getSourcesNew).
var PLAYER_RE = /^https?:\\/\\/(?:[a-z0-9-]+\\.)?(?:vidtube\\.[a-z]+|megaplay\\.[a-z]+|vidwish\\.[a-z]+)/i;
// Extra servers the episode's own list doesn't offer, keyed <mal>/<ep>/<ts>.
var MAPPER = 'https://mapper.nekostream.site/api/mal/';

function getInfo() {
  return { name: 'AniKoto', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.8' };
}

// MegaPlay/VidWish: getSourcesNew is the endpoint their player hits; both routes
// now encrypt the file into \`enc\`. VidPlay (vidtube) only exposes getSources.
function _sourcesUrl(base, dataId, type) {
  var path = /(?:megaplay|vidwish)\\.[a-z]+/i.test(String(base || ''))
    ? '/stream/getSourcesNew' : '/stream/getSources';
  return base + path + '?id=' + dataId + '&type=' + type;
}

// MegaPlay player defaults (newclient.min.js TRUST_AES_KEY / TRUST_AES_IV).
// Sandbox only bridges AES-CTR, so CBC is pure JS below (same as hdhub4u).
var MEGA_AES_KEY = 'i?LMTAx0Q6,:}50U';
var MEGA_AES_IV = "W0;27ToaUpl_P%'c";

function _padBytes(s, n) {
  var out = [], i;
  for (i = 0; i < n; i++) out[i] = 0;
  var b = String(s || '');
  for (i = 0; i < b.length && i < n; i++) out[i] = b.charCodeAt(i) & 0xff;
  return out;
}
function _b64urlBytes(s) {
  var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  var pad = (4 - (t.length % 4)) % 4;
  while (pad--) t += '=';
  try { return base64ToBytes(t); } catch (e) { return []; }
}
// Plain sources.file when present; otherwise AES-CBC-decrypt \`enc\` → {file}.
function _fileFromSources(j) {
  var s = j && j.sources;
  var file = s ? (s.file || (s[0] && s[0].file)) : null;
  if (file) return file;
  if (!j || !j.enc) return null;
  try {
    var ct = _b64urlBytes(j.enc);
    if (!ct.length || ct.length % 16 !== 0) return null;
    var pt = _bytesToStr(_aesCbcDecrypt(ct, _padBytes(MEGA_AES_KEY, 32), _padBytes(MEGA_AES_IV, 16)));
    var o = JSON.parse(pt);
    if (!o) return null;
    if (o.file) return o.file;
    s = o.sources;
    return s ? (s.file || (s[0] && s[0].file)) : null;
  } catch (e) { return null; }
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. \`xhr\` sets the ajax header the /ajax routes expect.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  });
}
// The site's /ajax routes wrap their payload in { status, result }. \`result\` is
// an HTML string (episode/server list) or an object (server?get).
function _ajax(path) {
  return _get(SITE + path, SITE + '/', true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  }).catch(function () { return null; });
}

function _year(s) { var m = String(s || '').match(/(19|20)\\d{2}/); return m ? m[0] : null; }
function _slugFromWatch(href) {
  var m = String(href || '').match(/\\/watch\\/([^/"?#]+)/);
  return m ? m[1] : null;
}

// ── Search: scrape /filter?keyword= result cards ────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/filter?keyword=' + encodeURIComponent(q) + '&page=' + (page || 1);
  return _get(url, SITE + '/').then(function (html) {
    var out = [], seen = {};
    var chunks = html.split('<div class="item');
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i];
      var slug = _slugFromWatch((c.match(/href="([^"]*\\/watch\\/[^"]+)"/) || [])[1]);
      if (!slug || seen[slug]) continue;
      var title = (c.match(/class="name d-title"[^>]*>([^<]+)</) || [])[1]
        || (c.match(/data-jp="([^"]+)"/) || [])[1];
      var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
      if (!title) continue;
      seen[slug] = 1;
      out.push({ id: slug, title: htmlText(title).trim(), url: slug,
        cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
    }
    return out;
  }).catch(function () { return []; });
}

// ── Home: /home spotlight (hero) + recent from the JSON API ──────────────────
function _apiCard(a) {
  if (!a || !a.slug) return null;
  return { id: a.slug, title: a.title || a.alternative || a.slug, url: a.slug,
    cover: a.poster || null, type: 'anime', sourceId: SOURCE_ID,
    subCount: a.is_sub ? 1 : 0, dubCount: 0 };
}
// Slice the /home page into its section containers (#hotest / #top-anime /
// #recent-update), each bounded by the next section so cards don't bleed across.
function _sections(html) {
  var ids = ['hotest', 'top-anime', 'recent-update'], marks = [];
  for (var i = 0; i < ids.length; i++) {
    var k = html.indexOf('id="' + ids[i] + '"');
    if (k >= 0) marks.push({ id: ids[i], at: k });
  }
  marks.sort(function (a, b) { return a.at - b.at; });
  var res = {};
  for (var j = 0; j < marks.length; j++) {
    var end = (j + 1 < marks.length) ? marks[j + 1].at : marks[j].at + 30000;
    res[marks[j].id] = html.substring(marks[j].at, end);
  }
  return res;
}
// Spotlight (#hotest) cards carry the title in an <h2 …d-title> + a bg-image.
function _spotlight(seg) {
  var out = [], seen = {}, chunks = seg.split('swiper-slide item');
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\\/watch\\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="title d-title"[^>]*>\\s*([^<]+?)\\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    if (!title) continue;
    var img = (c.match(/background-image:\\s*url\\(([^)]+)\\)/)
      || c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (img) img = img.replace(/^['"]|['"]$/g, '');
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: img || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
// Generic grid (#top-anime a.item, #recent-update div.item) → cards.
function _gridCards(seg) {
  var out = [], seen = {}, items = String(seg || '').split('class="item');
  for (var i = 1; i < items.length; i++) {
    var c = items[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\\/watch\\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="(?:name|title)[^"]*d-title"[^>]*>\\s*([^<]+?)\\s*</) || [])[1]
      || (c.match(/class="name"[^>]*>\\s*([^<]+?)\\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
function getHome(opts) {
  return _get(SITE + '/home', SITE + '/').then(function (html) {
    var s = _sections(html), rows = [];
    var spot = _spotlight(s.hotest || html);
    if (spot.length) rows.push({ title: 'Spotlight', items: spot });
    var top = _gridCards(s['top-anime']);
    if (top.length) rows.push({ title: 'Top Anime', items: top });
    var recent = _gridCards(s['recent-update']);
    if (recent.length) rows.push({ title: 'Recently Updated', items: recent });
    return rows;
  }).catch(function () { return []; }).then(function (rows) {
    if (rows.length) return rows;
    // Fallback: the JSON API's recent list if the /home scrape yielded nothing.
    return _json(API + '/recent-anime?page=1&per_page=24').then(function (j) {
      var data = (j && j.data) || [], items = [];
      for (var k = 0; k < data.length; k++) { var cc = _apiCard(data[k]); if (cc) items.push(cc); }
      return items.length ? [{ title: 'Recently Updated', items: items }] : [];
    }).catch(function () { return []; });
  });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _cleanTitle(og) {
  var t = String(og || '');
  t = t.replace(/\\s*[|-]\\s*Anikoto.*$/i, '');        // trailing site name
  t = t.replace(/^Watch\\s+/i, '').replace(/^Anime\\s+/i, ''); // leading fluff
  t = t.replace(/\\s+Anime\\s+Online.*$/i, '');         // "X Anime Online …"
  t = t.replace(/\\s+Watch\\s+Online.*$/i, '');         // "X Watch Online Free"
  t = t.replace(/\\s+Online\\s+(with|free)\\b.*$/i, ''); // "X Online with SUB/DUB"
  return t.trim();
}
function _genres(html) {
  var g = [], re = /href="[^"]*\\/genre\\/[^"]*"[^>]*>([^<]+)</g, m;
  while ((m = re.exec(html)) !== null && g.length < 8) {
    var t = htmlText(m[1]).trim(); if (t) g.push(t);
  }
  return g;
}

// Episode url: anikoto://<cat>/<encoded server_ids>/<sub><dub>/<num>, then the
// mapper token <mal>/<ep>/<timestamp> when the episode list carries it. The
// player rewrites the leading <cat> segment for its Sub/Dub toggle;
// getVideoSources resolves the server list from the (per-episode) server_ids
// blob. The token is appended, never inserted, so urls saved before it existed
// (history, downloads) still resolve — they just skip the mapper fallback.
function _epUrl(cat, serverIds, sub, dub, num, token) {
  return 'anikoto://' + cat + '/' + encodeURIComponent(serverIds) + '/'
    + (sub ? 1 : 0) + (dub ? 1 : 0) + '/' + num
    + (token ? '/' + token : '');
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _get(SITE + '/watch/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var animeId = (html.match(/data-id="(\\d+)"/) || [])[1];
    // The canonical clean title is the <h1 class="… d-title">; og:title is
    // marketing fluff ("Watch X Anime Online Free"), used only as a fallback.
    var title = htmlText((html.match(/<h1[^>]*class="[^"]*d-title[^"]*"[^>]*>([^<]+)<\\/h1>/) || [])[1] || '').trim()
      || _cleanTitle((html.match(/og:title"\\s+content="([^"]+)"/) || [])[1]) || slug;
    var poster = (html.match(/og:image"\\s+content="([^"]+)"/) || [])[1] || null;
    var synopsis = (html.match(/class="synopsis[^"]*"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '';
    var base = {
      id: slug, title: title, url: slug, cover: poster,
      description: htmlText(synopsis).trim(), status: 'unknown',
      genres: _genres(html), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(html), malId: null, subCount: 0, dubCount: 0
    };
    if (!animeId) return base;
    return _ajax('/ajax/episode/list/' + animeId).then(function (j) {
      var lhtml = (j && typeof j.result === 'string') ? j.result : '';
      var out = [], subN = 0, dubN = 0, mal = null;
      var re = /<a\\b([^>]*\\bdata-id="\\d+"[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var serverIds = (attrs.match(/data-ids="([^"]+)"/) || [])[1];
        if (!serverIds) continue; // no servers → not playable
        var num = parseInt((attrs.match(/data-num="(\\d+)"/) || [])[1] || '0', 10);
        var sub = (attrs.match(/data-sub="(\\d+)"/) || [])[1] === '1';
        var dub = (attrs.match(/data-dub="(\\d+)"/) || [])[1] === '1';
        if (!sub && !dub) continue;
        // The mapper is keyed per episode, so slug/timestamp come off THIS
        // anchor; data-slug is the episode number the API wants, not the show
        // slug. All three or none — a partial token is a 404.
        var epMal = (attrs.match(/data-mal="(\\d+)"/) || [])[1];
        var epSlug = (attrs.match(/data-slug="([^"]+)"/) || [])[1];
        var epTs = (attrs.match(/data-timestamp="(\\d+)"/) || [])[1];
        var token = (epMal && epSlug && epTs)
          ? (epMal + '/' + encodeURIComponent(epSlug) + '/' + epTs) : null;
        if (!mal) mal = epMal || null;
        if (sub) subN++;
        if (dub) dubN++;
        var initCat = (cat === 'dub' && dub) || (cat === 'sub' && !sub && dub) ? 'dub' : 'sub';
        var title2 = (attrs.match(/title="([^"]+)"/) || [])[1];
        out.push({ id: cat + ':' + num, number: num,
          title: title2 ? htmlText(title2).trim() : ('Episode ' + num),
          url: _epUrl(initCat, serverIds, sub, dub, num, token) });
      }
      base.episodes = out;
      base.subCount = subN;
      base.dubCount = dubN;
      base.malId = mal ? parseInt(mal, 10) : null;
      return base;
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server_ids → server list → server?get → embed getSources(New) ───
function _parseServers(html) {
  var servers = [], re = /data-type="(\\w+)"([\\s\\S]*?)(?=data-type="|$)/g, tm;
  while ((tm = re.exec(html)) !== null) {
    var type = tm[1], block = tm[2], lm, lre = /data-link-id="([^"]+)"[^>]*>([^<]*)</g;
    while ((lm = lre.exec(block)) !== null) {
      servers.push({ type: type, linkId: lm[1], name: (lm[2] || '').trim() });
    }
  }
  return servers;
}
// Prefer VidPlay; Vidstream/HD (MegaPlay) work again via enc decrypt.
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidplay') > -1) return 0;
  if (n.indexOf('vidstream') > -1) return 1;
  if (n.indexOf('hd') > -1) return 2;
  if (n.indexOf('vidcloud') > -1) return 3;
  return 5;
}

function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('anikoto://', '');
  var parts = raw.split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var serverIds = parts[1] ? decodeURIComponent(parts[1]) : '';
  // <mal>/<ep>/<timestamp>, already url-safe from _epUrl. Absent on urls saved
  // before the token existed, which just means no mapper fallback for them.
  var token = (parts[4] && parts[5] && parts[6])
    ? (parts[4] + '/' + parts[5] + '/' + parts[6]) : null;
  if (!serverIds) return Promise.reject(new Error('AniKoto: no server ids'));

  return _ajax('/ajax/server/list?servers=' + encodeURIComponent(serverIds)).then(function (j) {
    var lhtml = (j && typeof j.result === 'string') ? j.result : '';
    var servers = _parseServers(lhtml);
    var want = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var ok = (cat === 'dub') ? (s.type === 'dub') : (s.type === 'sub' || s.type === 'hsub');
      if (ok) want.push(s);
    }
    if (!want.length) want = servers;
    want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
    return _tryServers(want, 0, cat);
  }).catch(function (err) {
    // Only once the episode's own servers are exhausted — VidPlay is a direct
    // m3u8 and one request cheaper, so it stays first.
    return _mapperServers(token, cat, err);
  });
}

// Extra servers for episodes whose own list is all dead hosts. The site's
// player asks the same API and appends whatever it returns as ordinary servers,
// so an entry's \`url\` is just another link id for the /ajax/server?get= route
// above — it drops straight back into _tryServers.
//
// Only the \`url\` entries are used. An entry can also carry a \`download\` map of
// quality -> redirector link, but those all end up on kwik, and kwik blocks
// every HTTP/1.1 request outright (Cloudflare 1020, cookies and User-Agent make
// no difference — same request over HTTP/2 gets a 200). The host's fetch is
// dart:io, which only speaks HTTP/1.1, so following those links would just be
// three more round-trips to a guaranteed 403. Worth revisiting if fetch ever
// rides a client that negotiates HTTP/2.
function _mapperServers(token, cat, err) {
  if (!token) throw err;
  return _json(MAPPER + token, SITE + '/').then(function (j) {
    var extra = [];
    for (var name in j) {
      var e = j[name];
      if (name === 'status' || !e || typeof e !== 'object') continue;
      var bucket = e[cat];
      if (bucket && bucket.url) {
        extra.push({ type: cat, linkId: String(bucket.url), name: name });
      }
    }
    if (!extra.length) throw err;
    return _tryServers(extra, 0, cat);
  }).catch(function () { throw err; }); // keep the original "no playable server"
}

// Resolve servers in preference order; take the first that yields a known embed
// host, then extract its m3u8. A host that no longer returns a plain file (see
// PLAYER_RE) just throws and we fall through to the next server.
function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('AniKoto: no playable server'));
  return _ajax('/ajax/server?get=' + encodeURIComponent(list[i].linkId)).then(function (j) {
    var url = j && j.result && (typeof j.result === 'object' ? j.result.url : null);
    if (url && PLAYER_RE.test(url)) return _extractPlayer(url, cat);
    return _tryServers(list, i + 1, cat);
  }).catch(function () { return _tryServers(list, i + 1, cat); });
}

// Embed page → data-id → getSources(New) (plain m3u8 + subtitle tracks).
// When the VTT pack encode id differs from the video pack (common on dub),
// MegaPlay's intro/outro markers on the sibling pack give the post-OP skew so
// softsubs line up without a user delay preference.
function _cdnEncodeId(url) {
  var segs = String(url || '').split('/');
  var last = null;
  for (var i = 0; i < segs.length; i++) {
    if (/^[a-f0-9]{32}$/i.test(segs[i])) last = segs[i];
  }
  return last;
}
// The sub/hsub/dub cut an embed URL was issued for.
function _cutOf(embed) {
  return (String(embed || '').match(/\\/(sub|hsub|dub)\\/?(?:[?#]|$)/i) || [])[1] || null;
}
function _siblingEmbed(embed) {
  return String(embed || '').replace(/\\/(dub|sub)(?=\\/?($|\\?))/i, function (_, x) {
    return '/' + (String(x).toLowerCase() === 'dub' ? 'sub' : 'dub');
  });
}
function _packSkew(playing, sibling) {
  if (!playing || !sibling) return null;
  var skew = null;
  var after = null;
  // Prefer intro.end: post-OP content length matches across packs; averaging
  // with outro.start over-corrects when ED tails differ.
  if (playing.intro && sibling.intro
      && typeof playing.intro.end === 'number'
      && typeof sibling.intro.end === 'number') {
    skew = playing.intro.end - sibling.intro.end;
    after = sibling.intro.end;
  } else if (playing.outro && sibling.outro
      && typeof playing.outro.start === 'number'
      && typeof sibling.outro.start === 'number') {
    skew = playing.outro.start - sibling.outro.start;
    if (sibling.intro && typeof sibling.intro.end === 'number') {
      after = sibling.intro.end;
    }
  }
  if (skew == null || Math.abs(skew) < 5 || Math.abs(skew) > 45) return null;
  return { seconds: skew, afterSeconds: after == null ? 0 : after };
}

function _extractPlayer(embed, cat) {
  var base = (embed.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || 'https://vidtube.site';
  // Sources are keyed by the embed's data-id, which is shared across the
  // sub/hsub/dub cuts — the audio comes from \`type\`, so carry over the one this
  // embed was issued for or a dub episode comes back with the sub stream.
  var type = _cutOf(embed) || cat;
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\\d+)"/) || [])[1];
    if (!dataId) throw new Error('AniKoto: no embed id');
    return fetch(_sourcesUrl(base, dataId, type), {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AniKoto: bad getSources'); }
      var file = _fileFromSources(j);
      if (!file) throw new Error('AniKoto: no stream file');
      var subs = [];
      var tracks = (j && j.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
          format: /\\.srt(\\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
      }
      var hdrs = { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base };
      var videoEnc = _cdnEncodeId(file);
      var subEnc = subs.length ? _cdnEncodeId(subs[0].url) : null;
      var needSibling = videoEnc && subEnc && videoEnc !== subEnc;

      function finish(skew) {
        var mk = function (u, q) {
          var o = { url: u, quality: q, container: /\\.m3u8(\\?|$)/i.test(u) ? 'hls' : 'mp4',
            headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs };
          if (skew) {
            o.subtitleSkewSeconds = skew.seconds;
            o.subtitleSkewAfterSeconds = skew.afterSeconds;
          }
          return o;
        };
        // Hand back the master only. Probing master.m3u8 here (to expand
        // 1080p/720p rows) hits Cloudflare on fetch.nexabloom.top and the
        // native CfSolver routinely blows the app's 8s per-source budget —
        // resolve then reports "episode not available" even though we already
        // had a playable URL. Exo/the player pick HLS renditions themselves.
        return [mk(file, 'auto')];
      }

      if (!needSibling) return finish(null);
      var sibEmbed = _siblingEmbed(embed);
      if (!sibEmbed || sibEmbed === embed) return finish(null);
      return _get(sibEmbed, SITE + '/').then(function (shtml) {
        var sid = (shtml.match(/data-id="(\\d+)"/) || [])[1];
        if (!sid) return null;
        // Same id as the playing cut on hosts that share it, so the cut has to
        // be carried too or this reads back the pack we already have.
        return fetch(_sourcesUrl(base, sid,
            _cutOf(sibEmbed) || (type === 'dub' ? 'sub' : 'dub')), {
          headers: { 'User-Agent': UA, 'Referer': sibEmbed, 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (sr) {
          var sj; try { sj = JSON.parse(sr.body || 'null'); } catch (e) { sj = null; }
          return sj;
        });
      }).then(function (sj) {
        // Prefer intro.end delta (post-OP body length matches across packs).
        // Dart blends this with the VTT OP-gap delta on fetch (~11s here).
        // intro/outro stay plaintext next to \`enc\`, so skew still works.
        var skew = _packSkew(j, sj);
        if (skew) {
          try {
            console.log('[zangetsu-sub-timing] anikoto pack skew '
              + skew.seconds.toFixed(3) + 's after ' + skew.afterSeconds.toFixed(3)
              + 's via intro-markers'
              + ' (video=' + videoEnc + ' vtt=' + subEnc + ')');
          } catch (e) {}
        }
        return finish(skew);
      }).catch(function () { return finish(null); });
    });
  });
}

// ── MegaPlay AES-256-CBC (sandbox has CTR only) ─────────────────────────────
// Byte-for-byte match of megaplay newclient decrypt against a live getSourcesNew
// \`enc\` → {"file":"…master.m3u8"}. Tables/ops mirror providers/hdhub4u.js.
var _SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var _ISBOX=[0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
function _xtime(a){a<<=1;if(a&0x100)a^=0x11b;return a&0xff;}
function _gmul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
function _keyExp(key){
  var Nk=key.length/4,Nr=Nk+6,w=[],i;
  for(i=0;i<Nk;i++)w.push([key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]]);
  var rcon=1;
  for(i=Nk;i<4*(Nr+1);i++){
    var t=w[i-1].slice();
    if(i%Nk===0){t=[t[1],t[2],t[3],t[0]];t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];t[0]^=rcon;rcon=_xtime(rcon);}
    else if(Nk>6&&i%Nk===4){t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];}
    w.push([w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]]);
  }
  return {w:w,Nr:Nr};
}
function _invCipher(inb,ks){
  var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],r,c,i;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inb[i];
  function ark(round){for(c=0;c<4;c++)for(r=0;r<4;r++)s[r][c]^=w[round*4+c][r];}
  function isub(){for(r=0;r<4;r++)for(c=0;c<4;c++)s[r][c]=_ISBOX[s[r][c]];}
  function ishift(){for(r=1;r<4;r++){var row=s[r].slice();for(c=0;c<4;c++)s[r][c]=row[(c-r+4)%4];}}
  function imix(){for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
    s[0][c]=_gmul(a0,14)^_gmul(a1,11)^_gmul(a2,13)^_gmul(a3,9);
    s[1][c]=_gmul(a0,9)^_gmul(a1,14)^_gmul(a2,11)^_gmul(a3,13);
    s[2][c]=_gmul(a0,13)^_gmul(a1,9)^_gmul(a2,14)^_gmul(a3,11);
    s[3][c]=_gmul(a0,11)^_gmul(a1,13)^_gmul(a2,9)^_gmul(a3,14);}}
  ark(Nr);
  for(var round=Nr-1;round>=1;round--){ishift();isub();ark(round);imix();}
  ishift();isub();ark(0);
  var out=[];for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;
}
function _aesCbcDecrypt(ct,key,iv){
  var ks=_keyExp(key),out=[],prev=iv.slice(),off,i;
  for(off=0;off+16<=ct.length;off+=16){
    var block=ct.slice(off,off+16),dec=_invCipher(block,ks);
    for(i=0;i<16;i++)out.push(dec[i]^prev[i]);
    prev=block;
  }
  var pad=out[out.length-1];
  if(pad>0&&pad<=16)out=out.slice(0,out.length-pad);
  return out;
}
function _bytesToStr(b){var s='',i=0;while(i<b.length){var c=b[i++];if(c<0x80)s+=String.fromCharCode(c);else if(c<0xE0)s+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f));else if(c<0xF0)s+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f));else{var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f);cp-=0x10000;s+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF));}}return s;}
`
  },
  {
    id: "fourkhdhub",
    name: "4K HDHub",
    kind: "movie",
    lang: "en",
    rank: 1001,
    js: `// 4K HDHub — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (no DOM parser in the runtime → regex), with a
// self-contained video chain: download links → optional \`id=\` redirect
// resolver (triple-base64 + ROT13) → HubCloud → direct file links (FSL /
// Download / S3 / Pixeldrain / Buzzserver). No host-side extractor needed.
//
// Domains rotate, so the live domain map is fetched once from the upstream
// list and cached; everything falls back to sane defaults.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'fourkhdhub';

var DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(DOMAINS_URL, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = {
      main: (j['4khdhub'] || 'https://4khdhub.link').replace(/\\/$/, ''),
      hub: (j['hubcloud'] || 'https://hubcloud.foo').replace(/\\/$/, '')
    };
    return _dom;
  }).catch(function () {
    _dom = { main: 'https://4khdhub.link', hub: 'https://hubcloud.foo' };
    return _dom;
  });
}

function getInfo() {
  return {
    name: '4K HDHub', lang: 'en', baseUrl: 'https://4khdhub.link',
    logo: 'https://4khdhub.link/favicon.ico', type: 'movie', version: '1.0.6'
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _b64(s) {
  try {
    var b = base64ToBytes(String(s || '')); var o = '';
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]);
    return o;
  } catch (e) { return ''; }
}
function _rot13(s) {
  return String(s || '').replace(/[a-zA-Z]/g, function (c) {
    var base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }

// Parse \`div.card-grid a\` cards out of raw HTML.
function _cards(html, main) {
  var out = [], seen = {};
  var re = /<a[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g, m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1], inner = m[2];
    var t = (inner.match(/<h3[^>]*>([\\s\\S]*?)<\\/h3>/) || [])[1];
    if (!t) continue;
    var url = absUrl(href, main);
    if (seen[url]) continue; seen[url] = 1;
    var img = (inner.match(/<img[^>]+(?:data-src|src)="([^"]+)"/) || [])[1] || null;
    out.push({
      id: url, title: htmlText(t), cover: img ? absUrl(img, main) : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function search(query, page, opts) {
  var p = (page && page > 1) ? ('/page/' + page + '/') : '/';
  return _domains().then(function (d) {
    return _get(d.main + p + '?s=' + encodeURIComponent(query || ''), d.main + '/')
      .then(function (html) { return _cards(html, d.main); });
  }).catch(function () { return []; });
}

function getHome(opts) {
  var rows = [
    { title: 'Latest Movies', path: '/category/movies' },
    { title: 'Latest Episodes', path: '/category/series' },
    { title: '4K HDR', path: '/category/2160p-HDR' },
    { title: 'Hindi Movies', path: '/category/hindi-movies' },
    { title: 'Korean Series', path: '/category/korean-series' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Encodes a list of download hrefs into an opaque episode url.
function _epUrl(hrefs) { return '4khd://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^4khd:\\/\\//, ''))); }
  catch (e) { return []; }
}

// ── TMDB enrichment — 4KHDHub itself only exposes release filenames, so
// episode names/stills + a clean plot/genres come from TMDB. The host attaches
// the api_key to every api.themoviedb.org request, so none is passed here. ──
var _TMDB = 'https://api.themoviedb.org/3';
var _STILL = 'https://image.tmdb.org/t/p/w300';
var _POSTER = 'https://image.tmdb.org/t/p/w500';

function _tj(url) {
  return fetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 7000 })
    .then(function (r) { try { return JSON.parse(r.body || 'null'); } catch (e) { return null; } })
    .catch(function () { return null; });
}

function _tmdbFind(title, year, isTv) {
  var q = String(title || '').replace(/\\bseason\\b.*$/i, '').replace(/\\(.*$/, '').trim();
  return _tj(_TMDB + '/search/' + (isTv ? 'tv' : 'movie') + '?query=' + encodeURIComponent(q))
    .then(function (j) {
      var res = (j && j.results) || [];
      if (!res.length) return null;
      if (year) {
        for (var i = 0; i < res.length; i++) {
          var d = (res[i].first_air_date || res[i].release_date || '');
          if (d.slice(0, 4) === String(year)) return res[i].id;
        }
      }
      return res[0].id;
    });
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return _get(url, d.main + '/').then(function (html) {
      var title = _trim((html.match(/<h1[^>]*class="page-title"[^>]*>([\\s\\S]*?)<\\/h1>/) || [])[1] || '')
        .replace(/<[^>]*>/g, '').split('(')[0];
      title = _trim(title) || _trim((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null;
      var description = htmlText((html.match(/<p class="mt-4">([\\s\\S]*?)<\\/p>/) || [])[1]
        || (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '')
        .replace(/^watch trailer\\s*/i, '');
      var year = (html.match(/\\b(19|20)\\d{2}\\b/) || [])[0] || null;
      var tags = [];
      var tm; var tre = /class="badge badge-outline"[^>]*>([\\s\\S]*?)<\\/span>/g;
      while ((tm = tre.exec(html)) !== null) tags.push(htmlText(tm[1]));
      // Season blocks settle it; the type badge (one per page) covers the rest.
      var isSeries = /season-item|episode-download-item/i.test(html)
        || tags.indexOf('Series') !== -1;
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);
      // drop release-quality tokens from the scraped genre fallback
      var cleanTags = tags.filter(function (t) {
        return !/\\b\\d+(\\.\\d+)?\\s*(GB|MB)\\b|WEB-?DL|WEBRIP|BLU-?RAY|\\b\\d{3,4}p\\b|HDR|H\\.?26[45]|x26[45]|HEVC|DDP|DTS|AAC|ATMOS|^(Movies|Series)$|\\bSDR\\b|\\bAV1\\b|\\bREMUX\\b|\\bVOD\\b|\\b10\\s?Bit\\b|\\b(Dual|Multi)\\b/i.test(t);
      });

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: cleanTags.slice(0, 6), studios: [],
        type: 'movie', sourceId: SOURCE_ID, episodes: episodes, year: year,
        subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        // TMDB id drives Simkl movie/series tracking in the app.
        base.tmdbId = parseInt(id, 10);
        base.tmdbIsTv = !!isSeries;
        var seasons = [];
        if (isSeries) {
          var seen = {};
          episodes.forEach(function (e) {
            var m = e.title.match(/^S(\\d+)/);
            var s = m ? m[1] : '1';
            if (!seen[s]) { seen[s] = 1; seasons.push(parseInt(s, 10)); }
          });
        }
        var jobs = [_tj(_TMDB + '/' + (isSeries ? 'tv' : 'movie') + '/' + id)];
        seasons.forEach(function (s) {
          jobs.push(_tj(_TMDB + '/tv/' + id + '/season/' + s).then(function (j) {
            return { s: s, eps: (j && j.episodes) || [] };
          }));
        });
        return Promise.all(jobs).then(function (all) {
          var info = all[0];
          if (info) {
            if (info.overview) base.description = info.overview;
            if (info.genres && info.genres.length) {
              base.genres = info.genres.map(function (g) { return g.name; });
            }
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          for (var i = 1; i < all.length; i++) {
            var sd = all[i];
            if (!sd) continue;
            for (var k = 0; k < sd.eps.length; k++) {
              var ep = sd.eps[k];
              meta[sd.s + '|' + ep.episode_number] = ep;
            }
          }
          base.episodes = episodes.map(function (e) {
            var m = e.title.match(/^S(\\d+) E(\\d+)/);
            if (!m) return e;
            var md = meta[parseInt(m[1], 10) + '|' + parseInt(m[2], 10)];
            if (!md) return e;
            return {
              id: e.id, number: e.number, url: e.url,
              title: 'S' + m[1] + ' E' + m[2] + ' - ' + (md.name || ('Episode ' + m[2])),
              thumbnail: md.still_path ? (_STILL + md.still_path) : (e.thumbnail || null),
              date: md.air_date || null
            };
          });
          return base;
        });
      }).catch(function () { return base; });
    });
  });
}

function _movieEpisode(html, title) {
  var hrefs = [], m;
  var block = (html.match(/class="download-item[\\s\\S]*$/) || [])[0] || html;
  var re = /<a[^>]+href="([^"]+)"/g;
  while ((m = re.exec(block)) !== null) {
    var h = m[1];
    if (/hubcloud|hubdrive|hblinks|hubcdn|id=|\\/redirect|\\/links/i.test(h)) hrefs.push(h);
  }
  hrefs = hrefs.filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}

function _seriesEpisodes(html) {
  // Each episode is a \`.season-item.episode-item\` block holding an \`S0NE0M\`
  // tag (season+episode) and several \`.episode-download-item\` links (one per
  // quality/server). The same episode can appear under multiple resolution
  // lists, so dedup by (season, episode) and merge links. Titled "S<s> E<e> …"
  // so the app's season dropdown picks them up.
  // Each block is a season×quality group ("S05 2160p WEB-DL …"); its season
  // comes from the header, and each \`.episode-download-item\` inside is one
  // episode (badge "Episode-0N") with that quality's link.
  var map = {}, order = [];
  var parts = html.split(/class="season-item episode-item/);
  for (var pi = 1; pi < parts.length; pi++) {
    var chunk = parts[pi];
    var head = (chunk.match(/episode-(?:number|title)[^>]*>([\\s\\S]{0,80}?)</) || [])[1] || '';
    var sm = head.match(/S(\\d{1,2})/i) || chunk.match(/S(\\d{1,2})E\\d/i);
    var season = sm ? parseInt(sm[1], 10) : 1;
    var items = chunk.match(/episode-download-item[\\s\\S]*?(?=episode-download-item|class="season-item episode-item|class="download-item|$)/g) || [];
    for (var ii = 0; ii < items.length; ii++) {
      var it = items[ii];
      var em = it.match(/Episode[-\\s]0*([0-9]+)/i);
      if (!em) continue;
      var ep = parseInt(em[1], 10);
      var hrefs = [], hm, hre = /<a[^>]+href="([^"]+)"/g;
      while ((hm = hre.exec(it)) !== null) {
        if (/hubcloud|hubdrive|hblinks|hubcdn|id=/i.test(hm[1])) hrefs.push(hm[1]);
      }
      if (!hrefs.length) continue;
      var key = season + '|' + ep;
      if (!map[key]) { map[key] = { s: season, e: ep, hrefs: [] }; order.push(key); }
      for (var k = 0; k < hrefs.length; k++) {
        if (map[key].hrefs.indexOf(hrefs[k]) === -1) map[key].hrefs.push(hrefs[k]);
      }
    }
  }
  order.sort(function (a, b) {
    var x = map[a], y = map[b];
    return x.s !== y.s ? x.s - y.s : x.e - y.e;
  });
  var eps = order.map(function (key) {
    var o = map[key];
    return {
      id: 'S' + o.s + 'E' + o.e, number: o.e,
      title: 'S' + o.s + ' E' + o.e + ' - Episode ' + o.e, url: _epUrl(o.hrefs)
    };
  });
  // No per-episode blocks → fall back to season-pack links (one combined entry).
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── redirect resolver (Utils.getRedirectLinks) ──────────────────────────────
function _resolveRedirect(url) {
  return _get(url).then(function (html) {
    var combined = '', m;
    var re = /s\\('o','([A-Za-z0-9+/=]+)'|ck\\('_wp_http_\\d+','([^']+)'/g;
    while ((m = re.exec(html)) !== null) combined += (m[1] || m[2] || '');
    if (!combined) return '';
    var decoded;
    try { decoded = _b64(_rot13(_b64(_b64(combined)))); } catch (e) { return ''; }
    var json; try { json = JSON.parse(decoded); } catch (e) { return ''; }
    var o = _b64(json.o || '');
    if (o && _trim(o)) return _trim(o);
    var data = _b64(json.data || '');
    var wp = json.blog_url || '';
    if (!wp || !data) return '';
    return _get(wp + '?re=' + data).then(function (t) { return htmlText(t); });
  }).catch(function () { return ''; });
}

// ── HubCloud ────────────────────────────────────────────────────────────────
function _hubcloud(url) {
  var base = (url.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
  var step1 = url.indexOf('hubcloud.php') !== -1
    ? Promise.resolve(url)
    : _get(url).then(function (html) {
        var raw = (html.match(/id=["']download["'][^>]*href="([^"]+)"/) ||
                   html.match(/href="([^"]+)"[^>]*id=["']download["']/) || [])[1] || '';
        if (!raw) return '';
        return /^https?:/i.test(raw) ? raw : (base + '/' + raw.replace(/^\\//, ''));
      });
  return step1.then(function (href) {
    if (!href) return [];
    return _get(href).then(function (doc) {
      // The release filename lives in the (multi-class) card-header element.
      var title = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\\s\\S]*?)<\\//) || [])[1] || '');
// No resolution in the title means we don't know it — say so rather than
      // claiming one. The player hides its quality menu for an unknown stream
      // instead of showing a number that isn't real.
      var quality = _quality(title) || null;
      var pxl = (doc.match(/var\\s+pxl\\s*=\\s*["']([^"']+)["']/) || [])[1] || '';
      var info = { tags: _releaseTags(title), size: size, res: _resLabel(quality), quality: quality, pxl: pxl };
      var jobs = [], m;
      var re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/a>|<a[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (!link) continue;
        jobs.push(_hubServer(link, text, info));
      }
      return Promise.all(jobs).then(function (lists) {
        var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]);
        return out;
      });
    });
  }).catch(function () { return []; });
}

function _src(url, quality, label) {
  var hls = /\\.m3u8(\\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}

// Clean, human server name from a HubCloud button's text.
function _serverName(label) {
  if (label.indexOf('fsl') !== -1) return 'FSL Server';
  if (label.indexOf('buzz') !== -1) return 'Buzz Server';
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (label.indexOf('s3') !== -1) return 'S3 Server';
  if (label.indexOf('10gb') !== -1) return '10Gbps';
  if (label.indexOf('mega') !== -1) return 'Mega';
  if (label.indexOf('pdl') !== -1) return 'PDL Server';
  if (label.indexOf('download') !== -1) return 'Download';
  return 'Server';
}

// Maps 2160p → "4K" for the trailing resolution badge (CloudStream-style).
function _resLabel(quality) {
  return /2160/.test(String(quality || '')) ? '4K' : (quality || '');
}

// Parse a release filename into normalised tags, CloudStream-style, e.g.
// "WEB-DL H265 DDP5.1 HDR10+ AMZN DUAL" / "BLURAY AVC DDP5 DTS-HD X264".
function _releaseTags(title) {
  if (!title) return '';
  var U = (' ' + String(title)
    .replace(/\\.(mkv|mp4|avi|m4v)\\s*$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\\bWEB[ -]?DL\\b/ig, 'WEB-DL')
    .replace(/\\bWEB[ -]?RIP\\b/ig, 'WEBRIP')
    .replace(/\\bH[ .]?265\\b/ig, 'H265')
    .replace(/\\bH[ .]?264\\b/ig, 'H264')
    .replace(/\\bDDP[ .]?(\\d(?:\\.\\d)?)\\b/ig, 'DDP$1')
    .replace(/\\bDD[ .]?(\\d(?:\\.\\d)?)\\b/ig, 'DD$1')
    + ' ').toUpperCase();
  function has(re) { return re.test(U); }
  var out = [];
  var groups = [
    [['WEB-DL', /\\bWEB-DL\\b/], ['WEBRIP', /\\bWEBRIP\\b/], ['BLURAY', /\\bBLU ?RAY\\b|\\bBDRIP\\b/], ['HDRIP', /\\bHDRIP\\b/], ['HDTV', /\\bHDTV\\b/], ['DVDRIP', /\\bDVDRIP\\b/], ['BRRIP', /\\bBRRIP\\b/], ['CAM', /\\bCAM\\b/]],
    [['H265', /\\bH265\\b|\\bHEVC\\b/], ['X265', /\\bX265\\b/], ['H264', /\\bH264\\b/], ['X264', /\\bX264\\b/], ['AVC', /\\bAVC\\b/]],
    [['DDP5.1', /\\bDDP5\\.1\\b/], ['DDP5', /\\bDDP5\\b/], ['DDP', /\\bDDP\\b/], ['DD5.1', /\\bDD5\\.1\\b/], ['DTS-HD', /\\bDTS ?HD\\b/], ['DTS', /\\bDTS\\b/], ['EAC3', /\\bEAC3\\b/], ['AC3', /\\bAC3\\b/], ['AAC', /\\bAAC\\b/], ['FLAC', /\\bFLAC\\b/]]
  ];
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length; i++) {
      if (has(groups[g][i][1])) { out.push(groups[g][i][0]); break; }
    }
  }
  if (has(/\\bATMOS\\b/)) out.push('ATMOS');
  if (has(/\\bHDR10\\+\\b/) || has(/\\bHDR10PLUS\\b/)) out.push('HDR10+');
  else if (has(/\\bHDR\\b/)) out.push('HDR');
  if (has(/\\bDV\\b|\\bDOLBY ?VISION\\b/)) out.push('DV');
  var svc = ['AMZN', 'NF', 'DSNP', 'HMAX', 'ATVP', 'HULU', 'PCOK', 'CR'];
  for (var s = 0; s < svc.length; s++) {
    if (has(new RegExp('\\\\b' + svc[s] + '\\\\b'))) { out.push(svc[s]); break; }
  }
  if (has(/\\bDUAL\\b/)) out.push('DUAL');
  else if (has(/\\bMULTI\\b/)) out.push('MULTI');
  var seen = {}, res = [];
  for (var k = 0; k < out.length; k++) if (!seen[out[k]]) { seen[out[k]] = 1; res.push(out[k]); }
  return res.join(' ');
}

// Builds the Sources-sheet name, CloudStream-style:
//   "4K HDHub [FSL Server] [WEB-DL H265 DDP5.1 HDR10+ AMZN DUAL] [8.72 GB] 4K"
function _name(server, info) {
  var n = '4K HDHub [' + server + ']';
  if (info.tags) n += ' [' + info.tags + ']';
  if (info.size) n += ' [' + info.size + ']';
  if (info.res) n += ' ' + info.res;
  return n;
}

function _hubServer(link, label, info) {
  var server = _serverName(label);
  var name = _name(server, info);
  var q = info.quality;
  if (label.indexOf('buzzserver') !== -1 || label.indexOf('buzz') !== -1) {
    return fetch(link + '/download', {
      headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false
    }).then(function (r) {
      var h = (r.headers || {});
      var dl = h['hx-redirect'] || h['HX-Redirect'] || '';
      return dl ? _src(dl, q, name) : null;
    }).catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    // The button's href is a decoy that 404s — the real file id is swapped in
    // by the script below it, so prefer that when the page carries one.
    var real = info.pxl || link;
    var b = (real.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
    var fin = real.indexOf('download') !== -1 ? real
      : (b + '/api/file/' + real.replace(/\\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, q, name));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download file') !== -1 ||
      label.indexOf('s3 server') !== -1 || label.indexOf('mega') !== -1 ||
      label.indexOf('pdl') !== -1 || label.indexOf('10gbps') !== -1) {
    return Promise.resolve(_src(link, q, name));
  }
  // Unknown button — only keep if it already looks like a direct media file.
  if (/\\.(mp4|mkv|m3u8)(\\?|$)/i.test(link)) return Promise.resolve(_src(link, q, name));
  return Promise.resolve(null);
}

// hubdrive → (hubcloud); hblinks → list → (hubcloud/hubdrive)
function _hubdrive(url) {
  return _get(url).then(function (html) {
    var href = (html.match(/class="[^"]*btn-success1[^"]*"[^>]*href="([^"]+)"/) ||
                html.match(/href="([^"]+)"[^>]*class="[^"]*btn-success1/) || [])[1] || '';
    if (href && href.toLowerCase().indexOf('hubcloud') !== -1) return _hubcloud(href);
    if (href) return _hubcloud(href);
    return [];
  }).catch(function () { return []; });
}
function _hblinks(url) {
  return _get(url).then(function (html) {
    var links = [], m; var re = /<a[^>]+href="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var h = m[1].toLowerCase();
      if (h.indexOf('hubcloud') !== -1 || h.indexOf('hubdrive') !== -1) links.push(m[1]);
    }
    links = links.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4);
    return Promise.all(links.map(_dispatch)).then(function (ls) {
      return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

function _dispatch(link) {
  var l = String(link).toLowerCase();
  if (l.indexOf('hubcloud') !== -1) return _hubcloud(link);
  if (l.indexOf('hubdrive') !== -1) return _hubdrive(link);
  if (l.indexOf('hblinks') !== -1) return _hblinks(link);
  return Promise.resolve([]);
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 10);
  if (!hrefs.length) return Promise.reject(new Error('4K HDHub: no download links'));
  var jobs = hrefs.map(function (raw) {
    var p = raw.indexOf('id=') !== -1 ? _resolveRedirect(raw) : Promise.resolve(raw);
    return p.then(function (resolved) {
      if (!resolved) return [];
      return _dispatch(resolved);
    }).catch(function () { return []; });
  });
  return Promise.all(jobs).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) {
        var s = arr[k];
        if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
      }
    }
    if (!out.length) throw new Error('4K HDHub: no playable links resolved');
    return out;
  });
}
`
  },
  {
    id: "uhdmovies",
    name: "UHD Movies",
    kind: "movie",
    lang: "en",
    rank: 1002,
    js: `// UHD Movies — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex; no DOM parser in the runtime). Video chain:
//   page  →  maxbutton links  →  hrefli/unblockedgames SID bypass (3-step
//   form POST)  →  driveseed / driveleech  →  direct file (Instant Download /
//   Resume Cloud / Resume Worker Bot / Direct Links / Cloud Download).
// No host-side extractor needed.
//
// Domains rotate, so the live domain is fetched once from the shared upstream
// list and cached; everything falls back to sane defaults.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'uhdmovies';

var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
// Fallback for when the domain list can't be reached — .food went dark, so
// this has to track wherever the list currently points.
var DEFAULT_MAIN = 'https://uhdmovies.autos';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = { main: String(j['uhdmovies'] || DEFAULT_MAIN).replace(/\\/$/, '') };
    return _dom;
  }).catch(function () {
    _dom = { main: DEFAULT_MAIN };
    return _dom;
  });
}

function getInfo() {
  return {
    name: 'UHD Movies', lang: 'en', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.3'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }

// Strip "Download " + trailing "(year)/Season/quality" junk to a clean title.
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\\s*download\\s+/i, '');
  t = t.split(/\\s*\\(/)[0].split(/\\bseason\\b/i)[0].split(/\\bS0?\\d/)[0];
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Parse \`article.gridlove-post\` cards out of raw HTML.
function _cards(html, main) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<article[^>]*class="[^"]*gridlove-post/i);
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/class="entry-image"[\\s\\S]*?<a[^>]+href="([^"]+)"/i) ||
                c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    var url = absUrl(href, main);
    if (seen[url]) continue; seen[url] = 1;
    var rawTitle = (c.match(/<h1[^>]*class="[^"]*sanket[^"]*"[^>]*>([\\s\\S]*?)<\\/h1>/i) ||
                    c.match(/<img[^>]+alt="([^"]+)"/i) ||
                    c.match(/<a[^>]+title="([^"]+)"/i) || [])[1] || '';
    var img = (c.match(/<img[^>]+(?:data-lazy-src|data-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: _cleanTitle(rawTitle) || 'Untitled',
      cover: img ? absUrl(img, main) : null, url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function search(query, page, opts) {
  return _domains().then(function (d) {
    return _get(d.main + '/?s=' + encodeURIComponent(query || ''), d.main + '/')
      .then(function (html) { return _cards(html, d.main); });
  }).catch(function () { return []; });
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/' },
    { title: 'Movies', path: '/movies/' },
    { title: 'Web Series', path: '/web-series/' },
    { title: '4K HDR', path: '/4k-hdr/' },
    { title: 'Netflix', path: '/tv-shows/netflix/' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Opaque episode url packing a list of redirector hrefs (resolved lazily).
function _epUrl(hrefs) { return 'uhd://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^uhd:\\/\\//, ''))); }
  catch (e) { return []; }
}

// ── TMDB enrichment — posts only expose release filenames, so plot/genres/
// poster + episode names/stills come from TMDB. The host attaches the api_key
// to every api.themoviedb.org request, so none is passed here. ──
var _TMDB = 'https://api.themoviedb.org/3';
var _STILL = 'https://image.tmdb.org/t/p/w300';
var _POSTER = 'https://image.tmdb.org/t/p/w500';

function _tj(url) {
  return fetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 7000 })
    .then(function (r) { try { return JSON.parse(r.body || 'null'); } catch (e) { return null; } })
    .catch(function () { return null; });
}
function _tmdbFind(title, year, isTv) {
  var q = String(title || '').replace(/\\bseason\\b.*$/i, '').replace(/\\(.*$/, '').trim();
  return _tj(_TMDB + '/search/' + (isTv ? 'tv' : 'movie') + '?query=' + encodeURIComponent(q))
    .then(function (j) {
      var res = (j && j.results) || [];
      if (!res.length) return null;
      if (year) {
        for (var i = 0; i < res.length; i++) {
          var dt = (res[i].first_air_date || res[i].release_date || '');
          if (dt.slice(0, 4) === String(year)) return res[i].id;
        }
      }
      return res[0].id;
    });
}

// Anchors that point at a download redirector / file host (vs. nav/social).
function _isLink(h) {
  return /unblockedgames|hrefli|href\\.li|driveseed|driveleech|drive\\.|video-seed|video-leech|gdflix|gdtot|filepress|\\?go=|\\/go\\b|maxbutton/i.test(h);
}

// Movie: bundle every quality's redirector href into one episode.
function _movieEpisode(html, title) {
  var hrefs = [], m;
  var re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*maxbutton[^"]*"|<a[^>]+class="[^"]*maxbutton[^"]*"[^>]+href="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) { var h = m[1] || m[2]; if (h) hrefs.push(h); }
  if (!hrefs.length) {
    var re2 = /<a[^>]+href="([^"]+)"/gi;
    while ((m = re2.exec(html)) !== null) { if (_isLink(m[1])) hrefs.push(m[1]); }
  }
  hrefs = _uniq(hrefs);
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}

// Series: walk anchors in document order, tracking the current season from the
// nearest preceding "Season N" marker; group hrefs by (season, episode).
function _seriesEpisodes(html) {
  var seasons = [], sm, sre = /season\\s*0*(\\d{1,2})/gi;
  while ((sm = sre.exec(html)) !== null) seasons.push({ idx: sm.index, s: parseInt(sm[1], 10) });
  var map = {}, order = [], am, are = /<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/gi;
  while ((am = are.exec(html)) !== null) {
    var href = am[1], txt = htmlText(am[2]);
    if (!/episode/i.test(txt) || /\\bzip\\b/i.test(txt)) continue;
    var em = txt.match(/episode\\s*0*(\\d{1,3})/i); if (!em) continue;
    var ep = parseInt(em[1], 10);
    var season = 1;
    for (var i = 0; i < seasons.length; i++) { if (seasons[i].idx < am.index) season = seasons[i].s; else break; }
    var key = season + '|' + ep;
    if (!map[key]) { map[key] = { s: season, e: ep, hrefs: [] }; order.push(key); }
    if (map[key].hrefs.indexOf(href) === -1) map[key].hrefs.push(href);
  }
  order.sort(function (a, b) { var x = map[a], y = map[b]; return x.s !== y.s ? x.s - y.s : x.e - y.e; });
  var eps = order.map(function (key) {
    var o = map[key];
    return { id: 'S' + o.s + 'E' + o.e, number: o.e,
      title: 'S' + o.s + ' E' + o.e + ' - Episode ' + o.e, url: _epUrl(o.hrefs) };
  });
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return _get(url, d.main + '/').then(function (html) {
      var rawTitle = (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\\s\\S]*?)<\\/h1>/i) ||
                      html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] || 'Untitled';
      var title = _cleanTitle(rawTitle);
      var poster = (html.match(/<div class="entry-content"[\\s\\S]*?<img[^>]+(?:data-src|src)="([^"]+)"/i) ||
                    html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] || null;
      var description = htmlText((html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || '');
      var year = (htmlText(rawTitle).match(/\\((19|20)(\\d{2})\\)/) || [])[0];
      year = year ? year.replace(/[()]/g, '') : ((html.match(/\\b(19|20)\\d{2}\\b/) || [])[0] || null);
      var tags = [];
      var tm, tre = /class="[^"]*gridlove-cat[^"]*"[^>]*>([^<]+)</gi;
      while ((tm = tre.exec(html)) !== null) tags.push(_trim(htmlText(tm[1])));
      var isSeries = /\\bseason\\b|\\bS0?\\d+\\b|episode/i.test(htmlText(rawTitle)) || /:contains|episode\\s*0*\\d/i.test(html) && /season/i.test(html);
      isSeries = /\\bseason\\b|\\bS0?\\d/i.test(htmlText(rawTitle));
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: _uniq(tags).slice(0, 6), studios: [],
        type: 'movie', sourceId: SOURCE_ID, episodes: episodes, year: year,
        subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        // TMDB id drives Simkl movie/series tracking in the app.
        base.tmdbId = parseInt(id, 10);
        base.tmdbIsTv = !!isSeries;
        var seasons = [];
        if (isSeries) {
          var seen = {};
          episodes.forEach(function (e) {
            var m = e.title.match(/^S(\\d+)/); var s = m ? m[1] : '1';
            if (!seen[s]) { seen[s] = 1; seasons.push(parseInt(s, 10)); }
          });
        }
        var jobs = [_tj(_TMDB + '/' + (isSeries ? 'tv' : 'movie') + '/' + id)];
        seasons.forEach(function (s) {
          jobs.push(_tj(_TMDB + '/tv/' + id + '/season/' + s).then(function (j) {
            return { s: s, eps: (j && j.episodes) || [] };
          }));
        });
        return Promise.all(jobs).then(function (all) {
          var info = all[0];
          if (info) {
            if (info.overview) base.description = info.overview;
            if (info.genres && info.genres.length) base.genres = info.genres.map(function (g) { return g.name; });
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          for (var i = 1; i < all.length; i++) {
            var sd = all[i]; if (!sd) continue;
            for (var k = 0; k < sd.eps.length; k++) { var ep = sd.eps[k]; meta[sd.s + '|' + ep.episode_number] = ep; }
          }
          base.episodes = episodes.map(function (e) {
            var m = e.title.match(/^S(\\d+) E(\\d+)/); if (!m) return e;
            var md = meta[parseInt(m[1], 10) + '|' + parseInt(m[2], 10)]; if (!md) return e;
            return { id: e.id, number: e.number, url: e.url,
              title: 'S' + m[1] + ' E' + m[2] + ' - ' + (md.name || ('Episode ' + m[2])),
              thumbnail: md.still_path ? (_STILL + md.still_path) : (e.thumbnail || null),
              date: md.air_date || null };
          });
          return base;
        });
      }).catch(function () { return base; });
    });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── stream resolution ────────────────────────────────────────────────────────
function _src(url, quality, label) {
  var hls = /\\.m3u8(\\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || 'UHD Movies')
  };
}

// hrefli / unblockedgames SID bypass (3-step landing-form POST → driveseed).
function _form(html) {
  var action = (html.match(/<form[^>]+id=["']landing["'][^>]*action=["']([^"']+)["']/i) ||
                html.match(/<form[^>]+action=["']([^"']+)["'][^>]*id=["']landing["']/i) ||
                html.match(/<form[^>]+action=["']([^"']+)["']/i) || [])[1] || '';
  var inputs = {}, m;
  var re = /<input[^>]+name=["']([^"']+)["'][^>]*value=["']([^"']*)["']|<input[^>]+value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
  while ((m = re.exec(html)) !== null) { if (m[1]) inputs[m[1]] = m[2]; else if (m[4]) inputs[m[4]] = m[3]; }
  return { action: action, data: inputs };
}
function _postForm(url, data, ref) {
  var body = Object.keys(data).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]); }).join('&');
  return fetch(url, { method: 'POST', headers: {
    'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': ref || url
  }, body: body }).then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _bypassHrefli(url) {
  var host = (url.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
  return _get(url).then(function (h1) {
    var f1 = _form(h1);
    return _postForm(absUrl(f1.action, host) || url, f1.data, url).then(function (h2) {
      var f2 = _form(h2);
      return _postForm(absUrl(f2.action, host) || url, f2.data, url).then(function (h3) {
        var sk = (h3.match(/\\?go=([^"'&\\s]+)/) || [])[1] || '';
        if (!sk) return '';
        var wp = f2.data['_wp_http2'] || f1.data['_wp_http2'] || '';
        return fetch(host + '?go=' + sk, { headers: {
          'User-Agent': UA, 'Referer': url, 'Cookie': sk + '=' + wp
        } }).then(function (r) {
          var meta = (r.body || '').match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
          var driveUrl = meta ? meta[1] : '';
          if (!driveUrl) return '';
          return _get(driveUrl).then(function (t) {
            var path = (t.match(/replace\\(["']([^"']+)["']\\)/) || [])[1] || '';
            if (!path || path === '/404') return '';
            return absUrl(path, (driveUrl.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || host);
          });
        });
      });
    });
  }).catch(function () { return ''; });
}

// driveseed / driveleech file page → direct links (multiple server buttons).
function _btnSuccess(html) {
  var m = html.match(/<a[^>]+class="[^"]*btn-success[^"]*"[^>]+href="([^"]+)"/i) ||
          html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn-success[^"]*"/i);
  return m ? m[1] : '';
}
function _dsInstant(href, q, label) {
  return fetch(href, { headers: { 'User-Agent': UA, 'Referer': href } }).then(function (r) {
    var fin = r.url || href;
    var direct = fin.indexOf('url=') !== -1 ? decodeURIComponent(fin.split('url=')[1]) : '';
    return direct ? [_src(direct, q, label + ' Instant')] : [];
  }).catch(function () { return []; });
}
function _dsResumeCloud(base, href, q, label) {
  return _get(absUrl(href, base)).then(function (h) {
    var u = _btnSuccess(h);
    return u && /^https?:/.test(u) ? [_src(u, q, label + ' ResumeCloud')] : [];
  }).catch(function () { return []; });
}
function _dsDirect(base, href, q, label) {
  return _get(absUrl(href, base) + '?type=1').then(function (h) {
    var out = [], m, re = /<a[^>]+class="[^"]*btn-success[^"]*"[^>]+href="([^"]+)"|<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn-success[^"]*"/gi;
    while ((m = re.exec(h)) !== null) { var u = m[1] || m[2]; if (u && /^https?:/.test(u)) out.push(_src(u, q, label + ' Direct')); }
    return out;
  }).catch(function () { return []; });
}
function _dsResumeBot(url, q, label) {
  return fetch(url, { headers: { 'User-Agent': UA } }).then(function (r) {
    var doc = r.body || '';
    var ssid = '';
    var sc = (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) || '';
    var mm = String(sc).match(/PHPSESSID=([^;]+)/); if (mm) ssid = mm[1];
    var token = (doc.match(/formData\\.append\\(['"]token['"],\\s*['"]([a-f0-9]+)['"]\\)/) || [])[1] || '';
    var path = (doc.match(/fetch\\(['"]\\/download\\?id=([a-zA-Z0-9\\/+]+)['"]/) || [])[1] || '';
    var base = url.split('/download')[0];
    if (!token || !path) return [];
    return fetch(base + '/download?id=' + path, { method: 'POST', headers: {
      'Accept': '*/*', 'Origin': base, 'Referer': url,
      'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'PHPSESSID=' + ssid
    }, body: 'token=' + encodeURIComponent(token) }).then(function (r2) {
      var j; try { j = JSON.parse(r2.body || 'null'); } catch (e) { j = null; }
      var u = j && j.url;
      return (u && /^https?:/.test(u)) ? [_src(u, q, label + ' ResumeBot')] : [];
    });
  }).catch(function () { return []; });
}
function _driveseed(url) {
  var base = (url.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
  var pageP;
  if (url.indexOf('r?key=') !== -1) {
    pageP = _get(url).then(function (h) {
      var temp = (h.match(/replace\\(["']([^"']+)["']\\)/) || [])[1] || '';
      return temp ? _get(base + temp) : h;
    });
  } else { pageP = _get(url); }
  return pageP.then(function (doc) {
    var nameLine = htmlText((doc.match(/<li[^>]*class="[^"]*list-group-item[^"]*"[^>]*>([\\s\\S]*?)<\\/li>/i) || [])[1] || '');
    var fileName = nameLine.replace(/^name\\s*:\\s*/i, '').trim();
    var quality = _quality(fileName) || _quality(url) || 'auto';
    var label = 'UHD Movies' + (fileName ? ' [' + fileName.slice(0, 80) + ']' : '');
    var jobs = [], m, re = /<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    while ((m = re.exec(doc)) !== null) {
      var href = m[1], txt = htmlText(m[2]).toLowerCase();
      if (!href) continue;
      if (txt.indexOf('instant download') !== -1) jobs.push(_dsInstant(absUrl(href, base), quality, label));
      else if (txt.indexOf('resume cloud') !== -1) jobs.push(_dsResumeCloud(base, href, quality, label));
      else if (txt.indexOf('resume worker') !== -1 || txt.indexOf('worker bot') !== -1) jobs.push(_dsResumeBot(absUrl(href, base), quality, label));
      else if (txt.indexOf('direct links') !== -1) jobs.push(_dsDirect(base, href, quality, label));
      else if (txt.indexOf('cloud download') !== -1 && /^https?:/.test(href)) jobs.push(Promise.resolve([_src(href, quality, label + ' Cloud')]));
    }
    if (!jobs.length) {
      var direct = _btnSuccess(doc);
      if (direct && /^https?:/.test(direct)) jobs.push(Promise.resolve([_src(direct, quality, label)]));
    }
    return Promise.all(jobs).then(function (lists) {
      return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

function _resolveOne(link) {
  var l = String(link).toLowerCase();
  var p = /unblockedgames|hrefli|href\\.li|\\?go=|\\/go\\b/.test(l) ? _bypassHrefli(link) : Promise.resolve(link);
  return p.then(function (resolved) {
    if (!resolved) return [];
    var r = resolved.toLowerCase();
    if (/driveseed|driveleech/.test(r)) return _driveseed(resolved);
    if (/\\.(mp4|mkv|m3u8)(\\?|$)/.test(r)) return [_src(resolved, _quality(resolved), 'UHD Movies')];
    return _driveseed(resolved); // best-effort: most redirectors land on a driveseed-style page
  }).catch(function () { return []; });
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 12);
  if (!hrefs.length) return Promise.reject(new Error('UHD Movies: no download links'));
  return Promise.all(hrefs.map(_resolveOne)).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) {
        var s = arr[k];
        if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
      }
    }
    if (!out.length) throw new Error('UHD Movies: no playable links resolved');
    return out;
  });
}
`
  },
  {
    id: "hdhub4u",
    name: "HDHub4u",
    kind: "movie",
    lang: "en",
    rank: 1003,
    js: `// HDHub4u — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex) + Typesense search + TMDB enrichment, and a
// self-contained video chain:
//   page links → optional \`?id=\` redirect resolver (triple-base64 + ROT13)
//   → hblinks (link list) / hubdrive → HubCloud → direct files (FSL / S3 /
//   Pixeldrain / Buzz / 10Gbps), plus hdstream4u and hubstream (the latter
//   AES-CBC decrypted in pure JS to an m3u8).
// Each direct file is labelled with its real quality/size/release tags parsed
// from the HubCloud filename (so the quality menu + source names populate).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hdhub4u';

var DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Only used when the domains list itself can't be reached; the live domain
// always comes from DOMAINS_URL.
var FALLBACK = 'https://new5.hdhub4u.cl';

var _dom = null;
function _domains() {
  if (_dom) return Promise.resolve(_dom);
  return fetch(DOMAINS_URL, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _dom = { main: (j['HDHUB4u'] || j['hdhub4u'] || FALLBACK).replace(/\\/$/, '') };
    return _dom;
  }).catch(function () {
    _dom = { main: FALLBACK };
    return _dom;
  });
}

function getInfo() {
  return {
    name: 'HDHub4u', lang: 'hi', baseUrl: FALLBACK,
    logo: FALLBACK + '/favicon.ico', type: 'movie', version: '1.2.4'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _b64(s) {
  try { var b = base64ToBytes(String(s || '')); var o = ''; for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return o; }
  catch (e) { return ''; }
}
function _rot13(s) {
  return String(s || '').replace(/[a-zA-Z]/g, function (c) {
    var base = c <= 'Z' ? 65 : 97; return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Cookie': 'xla=s4t', 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\\s*download\\s+/i, '');
  t = t.split(/\\s*\\(/)[0].split(/\\bseason\\b/i)[0].split(/\\bS0?\\d/)[0]
       .replace(/\\b(480p|720p|1080p|2160p|4k|web[- ]?dl|hdrip|bluray|x264|x265|hevc|hindi|dual audio).*$/i, '');
  return _trim(t) || _trim(htmlText(raw || ''));
}

// \`.recent-movies > li.thumb\` cards (home/category listing).
function _cards(html, main) {
  var out = [], seen = {};
  var parts = String(html || '').split(/<li[^>]*class="[^"]*\\bthumb\\b/i);
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/<figcaption[\\s\\S]*?<a[^>]+href="([^"]+)"/i) ||
                c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    var url = absUrl(href, main);
    if (seen[url] || /\\/(category|page)\\//i.test(url)) continue; seen[url] = 1;
    var rawTitle = (c.match(/<figcaption[\\s\\S]*?<p[^>]*>([\\s\\S]*?)<\\/p>/i) ||
                    c.match(/<img[^>]+alt="([^"]+)"/i) || [])[1] || '';
    var img = (c.match(/<img[^>]+(?:data-lazy-src|data-src|src)="([^"]+)"/i) || [])[1] || null;
    out.push({
      id: url, title: _cleanTitle(rawTitle) || 'Untitled',
      cover: img ? absUrl(img, main) : null, url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/' },
    { title: 'Bollywood', path: '/category/bollywood-movies/' },
    { title: 'Hollywood', path: '/category/hollywood-movies/' },
    { title: 'Hindi Dubbed', path: '/category/hindi-dubbed/' },
    { title: 'Web Series', path: '/category/web-series/' }
  ];
  return _domains().then(function (d) {
    return Promise.all(rows.map(function (row) {
      return _get(d.main + row.path, d.main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, d.main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Search uses HDHub4u's Typesense proxy (no key needed; UA + referer only).
function search(query, page, opts) {
  return _domains().then(function (d) {
    var u = 'https://search.pingora.fyi/collections/post/documents/search'
      + '?q=' + encodeURIComponent(query || '')
      + '&query_by=post_title,category&query_by_weights=4,2'
      + '&sort_by=sort_by_date:desc&limit=20&highlight_fields=none&use_cache=true'
      + '&page=' + (page || 1);
    return fetch(u, { headers: { 'User-Agent': UA, 'Referer': d.main + '/' } }).then(function (r) {
      var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
      var hits = (j && j.hits) || [];
      var out = [];
      for (var i = 0; i < hits.length; i++) {
        var doc = (hits[i] && hits[i].document) || {};
        var raw = doc.permalink || doc.url; if (!raw) continue;
        // Index permalinks are relative (or on a stale domain) — strip any host
        // and rebase the path onto the CURRENT domain so getDetail can load it.
        var path = String(raw).replace(/^https?:\\/\\/[^/]+/, '');
        var url = absUrl(path, d.main);
        var img = doc.post_thumbnail || doc.feature_img || doc.image || null;
        out.push({
          id: url, title: _cleanTitle(doc.post_title || doc.title || ''),
          cover: img ? absUrl(img, d.main) : null,
          url: url, type: 'movie', sourceId: SOURCE_ID
        });
      }
      if (out.length) return out;
      return _get(d.main + '/?s=' + encodeURIComponent(query || ''), d.main + '/')
        .then(function (h) { return _cards(h, d.main); });
    }).catch(function () { return []; });
  }).catch(function () { return []; });
}

// ── episode url packing ──────────────────────────────────────────────────────
function _epUrl(hrefs) { return 'hdh://' + encodeURIComponent(JSON.stringify(hrefs)); }
function _epHrefs(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^hdh:\\/\\//, ''))); }
  catch (e) { return []; }
}
function _isLink(h) {
  return /hdstream4u|hubstream|hubcloud|hubdrive|hblinks|pixeldra|gadgets|\\?id=/i.test(String(h || ''));
}

// ── TMDB enrichment ──────────────────────────────────────────────────────────
// Straight to TMDB: the keyless proxy this used to go through now answers 429
// to everything. The host attaches the api_key to every api.themoviedb.org
// request, so none is passed here.
var _TMDB = 'https://api.themoviedb.org/3';
var _STILL = 'https://image.tmdb.org/t/p/w300';
var _POSTER = 'https://image.tmdb.org/t/p/w500';
function _tj(url) {
  return fetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 7000 })
    .then(function (r) { try { return JSON.parse(r.body || 'null'); } catch (e) { return null; } })
    .catch(function () { return null; });
}
function _tmdbFind(title, year, isTv) {
  var q = String(title || '').replace(/\\bseason\\b.*$/i, '').replace(/\\(.*$/, '').trim();
  return _tj(_TMDB + '/search/' + (isTv ? 'tv' : 'movie') + '?query=' + encodeURIComponent(q))
    .then(function (j) {
      var res = (j && j.results) || []; if (!res.length) return null;
      if (year) for (var i = 0; i < res.length; i++) {
        var dt = (res[i].first_air_date || res[i].release_date || '');
        if (dt.slice(0, 4) === String(year)) return res[i].id;
      }
      return res[0].id;
    });
}

function _movieEpisode(html, title) {
  var hrefs = [], m, re = /<a[^>]+href="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) { if (_isLink(m[1])) hrefs.push(m[1]); }
  hrefs = _uniq(hrefs);
  if (!hrefs.length) return [];
  return [{ id: 'movie', title: title || 'Movie', number: 1, url: _epUrl(hrefs) }];
}
function _seriesEpisodes(html) {
  var heads = [], hm, hre = /episode\\s*0*(\\d{1,3})/gi;
  while ((hm = hre.exec(html)) !== null) heads.push({ idx: hm.index, e: parseInt(hm[1], 10) });
  var map = {}, order = [], am, are = /<a[^>]+href="([^"]+)"/gi;
  while ((am = are.exec(html)) !== null) {
    var href = am[1]; if (!_isLink(href)) continue;
    var ep = 1;
    for (var i = 0; i < heads.length; i++) { if (heads[i].idx < am.index) ep = heads[i].e; else break; }
    var key = String(ep);
    if (!map[key]) { map[key] = { e: ep, hrefs: [] }; order.push(key); }
    if (map[key].hrefs.indexOf(href) === -1) map[key].hrefs.push(href);
  }
  order.sort(function (a, b) { return map[a].e - map[b].e; });
  var eps = order.map(function (key) {
    var o = map[key];
    return { id: 'E' + o.e, number: o.e, title: 'Episode ' + o.e, url: _epUrl(o.hrefs) };
  });
  if (!eps.length) return _movieEpisode(html, 'Full');
  return eps;
}

function getDetail(url, opts) {
  return _domains().then(function (d) {
    return fetch(url, { headers: { 'User-Agent': UA, 'Cookie': 'xla=s4t', 'Referer': d.main + '/' } }).then(function (r) {
      var html = r.body || '';
      // Title lives in the page-title's <span class="material-text"> — the
      // leading <i class="material-icons"> glyph must NOT be scraped (it renders
      // as a junk leading letter).
      var rawTitle = (html.match(/<span class="material-text">([\\s\\S]*?)<\\/span>/i) ||
                      html.match(/<meta property="og:title" content="([^"]+)"/i) ||
                      html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\\s\\S]*?)<\\/h1>/i) || [])[1] || 'Untitled';
      var title = _cleanTitle(rawTitle);
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] || null;
      var description = htmlText((html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || '');
      var year = (htmlText(rawTitle).match(/\\((19|20)\\d{2}\\)/) || [])[0];
      year = year ? year.replace(/[()]/g, '') : ((html.match(/\\b(19|20)\\d{2}\\b/) || [])[0] || null);
      var isSeries = /\\bseason\\b|\\bS0?\\d|web[- ]?series|episode\\s*0*\\d/i.test(htmlText(rawTitle)) ||
        ((html.match(/episode\\s*0*\\d/gi) || []).length > 1);
      var episodes = isSeries ? _seriesEpisodes(html) : _movieEpisode(html, title);

      var base = {
        id: url, title: title, cover: poster, url: url, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie', sourceId: SOURCE_ID,
        episodes: episodes, year: year, subCount: episodes.length, dubCount: 0
      };

      return _tmdbFind(title, year, isSeries).then(function (id) {
        if (!id) return base;
        // TMDB id drives Simkl movie/series tracking in the app.
        base.tmdbId = parseInt(id, 10);
        base.tmdbIsTv = !!isSeries;
        var jobs = [_tj(_TMDB + '/' + (isSeries ? 'tv' : 'movie') + '/' + id)];
        if (isSeries) jobs.push(_tj(_TMDB + '/tv/' + id + '/season/1').then(function (j) { return { eps: (j && j.episodes) || [] }; }));
        return Promise.all(jobs).then(function (all) {
          var info = all[0];
          if (info) {
            if (info.overview) base.description = info.overview;
            if (info.genres && info.genres.length) base.genres = info.genres.map(function (g) { return g.name; });
            if (info.poster_path) base.cover = _POSTER + info.poster_path;
          }
          var meta = {};
          if (all[1]) for (var k = 0; k < all[1].eps.length; k++) { var ep = all[1].eps[k]; meta[ep.episode_number] = ep; }
          base.episodes = episodes.map(function (e) {
            var md = meta[e.number]; if (!md) return e;
            return { id: e.id, number: e.number, url: e.url,
              title: 'Episode ' + e.number + ' - ' + (md.name || ('Episode ' + e.number)),
              thumbnail: md.still_path ? (_STILL + md.still_path) : null, date: md.air_date || null };
          });
          return base;
        });
      }).catch(function () { return base; });
    });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── stream resolution ────────────────────────────────────────────────────────
function _src(url, quality, label) {
  var hls = /\\.m3u8(\\?|$)/i.test(url);
  return {
    url: url, quality: quality || 'auto', container: hls ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || 'HDHub4u')
  };
}

// \`?id=\` redirect resolver (triple-base64 + ROT13). Returns the destination URL
// (often an hblinks page) or '' on failure.
function _resolveRedirect(url) {
  return _get(url).then(function (html) {
    var combined = '', m, re = /s\\('o','([A-Za-z0-9+/=]+)'|ck\\('_wp_http_\\d+','([^']+)'/g;
    while ((m = re.exec(html)) !== null) combined += (m[1] || m[2] || '');
    if (!combined) return '';
    var decoded; try { decoded = _b64(_rot13(_b64(_b64(combined)))); } catch (e) { return ''; }
    var json; try { json = JSON.parse(decoded); } catch (e) { return ''; }
    var o = _b64(json.o || ''); if (o && _trim(o)) return _trim(o);
    var data = _b64(json.data || ''), wp = json.blog_url || '';
    if (!wp || !data) return '';
    return _get(wp + '?re=' + data).then(function (t) { return htmlText(t); });
  }).catch(function () { return ''; });
}

// Parse a release filename into normalised tags (CloudStream-style).
function _releaseTags(title) {
  if (!title) return '';
  var U = (' ' + String(title).replace(/\\.(mkv|mp4|avi|m4v)\\s*$/i, '').replace(/[._]/g, ' ')
    .replace(/\\bWEB[ -]?DL\\b/ig, 'WEB-DL').replace(/\\bWEB[ -]?RIP\\b/ig, 'WEBRIP')
    .replace(/\\bH[ .]?265\\b/ig, 'H265').replace(/\\bH[ .]?264\\b/ig, 'H264')
    + ' ').toUpperCase();
  function has(re) { return re.test(U); }
  var out = [];
  var groups = [
    [['WEB-DL', /\\bWEB-DL\\b/], ['WEBRIP', /\\bWEBRIP\\b/], ['BLURAY', /\\bBLU ?RAY\\b|\\bBDRIP\\b/], ['HDRIP', /\\bHDRIP\\b/], ['HDTV', /\\bHDTV\\b/], ['HDTC', /\\bHDTC\\b/], ['HDCAM', /\\bHDCAM\\b/]],
    [['H265', /\\bH265\\b|\\bHEVC\\b/], ['X265', /\\bX265\\b/], ['H264', /\\bH264\\b/], ['X264', /\\bX264\\b/], ['AVC', /\\bAVC\\b/]],
    [['DDP5.1', /\\bDDP5\\.1\\b/], ['DDP', /\\bDDP\\b/], ['DD5.1', /\\bDD5\\.1\\b/], ['DTS', /\\bDTS\\b/], ['AAC', /\\bAAC\\b/], ['AC3', /\\bAC3\\b/]]
  ];
  for (var g = 0; g < groups.length; g++) for (var i = 0; i < groups[g].length; i++) if (has(groups[g][i][1])) { out.push(groups[g][i][0]); break; }
  if (has(/\\bATMOS\\b/)) out.push('ATMOS');
  if (has(/\\bHDR10\\+\\b/) || has(/\\bHDR10PLUS\\b/)) out.push('HDR10+'); else if (has(/\\bHDR\\b/)) out.push('HDR');
  if (has(/\\bDUAL\\b/)) out.push('DUAL'); else if (has(/\\bHINDI\\b/)) out.push('HINDI');
  var seen = {}, res = [];
  for (var k = 0; k < out.length; k++) if (!seen[out[k]]) { seen[out[k]] = 1; res.push(out[k]); }
  return res.join(' ');
}
function _resLabel(q) { return /2160/.test(String(q || '')) ? '4K' : (q || ''); }
function _serverName(label) {
  var l = String(label || '').toLowerCase();
  if (l.indexOf('fsl') !== -1) return 'FSL Server';
  if (l.indexOf('buzz') !== -1) return 'Buzz Server';
  if (l.indexOf('pixeldra') !== -1 || l.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (l.indexOf('s3') !== -1) return 'S3 Server';
  if (l.indexOf('10gb') !== -1) return '10Gbps';
  if (l.indexOf('download') !== -1) return 'Download';
  return 'HubCloud';
}
// "HDHub4u [FSL Server] [WEB-DL H265 DDP5.1] [2.1GB] 1080p"
function _name(server, info) {
  var n = 'HDHub4u [' + server + ']';
  if (info.tags) n += ' [' + info.tags + ']';
  if (info.size) n += ' [' + info.size + ']';
  if (info.res) n += ' ' + info.res;
  return n;
}

// ── HubCloud (direct files) ──────────────────────────────────────────────────
function _hubServer(link, label, info) {
  var server = _serverName(label);
  var name = _name(server, info);
  var q = info.quality;
  var l = String(label || '').toLowerCase();
  if (l.indexOf('buzz') !== -1) {
    return fetch(link + '/download', { headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false })
      .then(function (r) { var h = r.headers || {}; var dl = h['hx-redirect'] || h['HX-Redirect'] || ''; return dl ? _src(dl, q, name) : null; })
      .catch(function () { return null; });
  }
  if (l.indexOf('pixeldra') !== -1 || l.indexOf('pixel') !== -1) {
    // The button's href is a decoy that's the same on every page — the real
    // file id is swapped in by the script below it, so prefer that.
    var real = info.pxl || link;
    var b = (real.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
    var fin = real.indexOf('download') !== -1 ? real : (b + '/api/file/' + real.replace(/\\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, q, name));
  }
  if (l.indexOf('fsl') !== -1 || l.indexOf('download') !== -1 || l.indexOf('s3') !== -1 || l.indexOf('10gb') !== -1) {
    return Promise.resolve(_src(link, q, name));
  }
  if (/\\.(mp4|mkv|m3u8)(\\?|$)/i.test(link)) return Promise.resolve(_src(link, q, name));
  return Promise.resolve(null);
}
function _hubcloud(url) {
  var base = (url.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
  var step1 = url.indexOf('hubcloud.php') !== -1 ? Promise.resolve(url)
    : _get(url).then(function (html) {
        var raw = (html.match(/id=["']download["'][^>]*href="([^"]+)"/) ||
                   html.match(/href="([^"]+)"[^>]*id=["']download["']/) || [])[1] || '';
        if (!raw) return '';
        return /^https?:/i.test(raw) ? raw : (base + '/' + raw.replace(/^\\//, ''));
      });
  return step1.then(function (href) {
    if (!href) return [];
    return _get(href).then(function (doc) {
      var title = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\\s\\S]*?)<\\//) || [])[1] || '');
// No resolution in the title means we don't know it — say so rather than
      // claiming one. The player hides its quality menu for an unknown stream
      // instead of showing a number that isn't real.
      var quality = _quality(title) || null;
      // The site posts sample cuts, trailers and post-credit clips next to the
      // real release, tagged with the same quality — left in, one of them wins
      // the "best source" pick and you get seven minutes instead of the film.
      if (/\\bsample\\b|post[-. ]?credit|\\btrailer\\b/i.test(title)) return [];
      var pxl = (doc.match(/var\\s+pxl\\s*=\\s*["']([^"']+)["']/) || [])[1] || '';
      var info = { tags: _releaseTags(title), size: size, res: _resLabel(quality), quality: quality, pxl: pxl };
      var jobs = [], m, re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/a>|<a[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var link = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (link) jobs.push(_hubServer(link, text, info));
      }
      return Promise.all(jobs).then(function (lists) { var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]); return out; });
    });
  }).catch(function () { return []; });
}
function _hubdrive(url) {
  return _get(url).then(function (html) {
    var href = (html.match(/class="[^"]*btn-success1[^"]*"[^>]*href="([^"]+)"/) ||
                html.match(/href="([^"]+)"[^>]*class="[^"]*btn-success1/) ||
                html.match(/href="([^"]+)"[^>]*>[^<]*hubcloud/i) || [])[1] || '';
    if (href) return _hubcloud(href);
    return [];
  }).catch(function () { return []; });
}
// hblinks → page of hubcloud/hubdrive links → resolve each.
function _hblinks(url) {
  return _get(url).then(function (html) {
    var links = [], m, re = /<a[^>]+href="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var h = m[1].toLowerCase();
      if (h.indexOf('hubcloud') !== -1 || h.indexOf('hubdrive') !== -1) links.push(m[1]);
    }
    links = _uniq(links).slice(0, 5);
    return Promise.all(links.map(_dispatch)).then(function (ls) {
      return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
    });
  }).catch(function () { return []; });
}

// hdstream4u (VidHide): packed-JS player at /v/{id} → m3u8 (best-effort).
function _vidhide(url) {
  var id = (url.match(/\\/(?:file|v|e|d)\\/([A-Za-z0-9]+)/) || [])[1] || '';
  var emb = id ? ((url.match(/^(https?:\\/\\/[^/]+)/) || [])[1] + '/v/' + id) : url;
  return _get(emb, (emb.match(/^(https?:\\/\\/[^/]+)/) || [])[1] + '/').then(function (body) {
    var unpacked = body;
    try { if (/eval\\(function\\(p,a,c,k,e/.test(body)) unpacked = unpackJs(body); } catch (e) {}
    var src = unpacked + '\\n' + body;
    var m = src.match(/(?:file|source|src)\\s*:\\s*"([^"]+\\.m3u8[^"]*)"/i) ||
            src.match(/"(https?:\\/\\/[^"]+\\.m3u8[^"]*)"/i);
    if (!m) return [];
    var hdr = { 'User-Agent': UA, 'Referer': (emb.match(/^(https?:\\/\\/[^/]+)/) || [])[1] + '/' };
    var out = _src(m[1], 'auto', 'HDHub4u [HdStream4u]'); out.headers = hdr;
    return [out];
  }).catch(function () { return []; });
}

// ── hubstream (VidStack): /api/v1/video?id= → AES-128-CBC (static key) → m3u8.
// The sandbox only exposes AES-CTR, so AES-CBC is implemented here in pure JS
// (verified byte-for-byte against openssl on the live endpoint).
var _SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var _ISBOX=[0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
function _xtime(a){a<<=1;if(a&0x100)a^=0x11b;return a&0xff;}
function _gmul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
function _keyExp(key){
  var Nk=key.length/4,Nr=Nk+6,w=[],i;
  for(i=0;i<Nk;i++)w.push([key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]]);
  var rcon=1;
  for(i=Nk;i<4*(Nr+1);i++){
    var t=w[i-1].slice();
    if(i%Nk===0){t=[t[1],t[2],t[3],t[0]];t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];t[0]^=rcon;rcon=_xtime(rcon);}
    else if(Nk>6&&i%Nk===4){t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];}
    w.push([w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]]);
  }
  return {w:w,Nr:Nr};
}
function _invCipher(inb,ks){
  var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],r,c,i;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inb[i];
  function ark(round){for(c=0;c<4;c++)for(r=0;r<4;r++)s[r][c]^=w[round*4+c][r];}
  function isub(){for(r=0;r<4;r++)for(c=0;c<4;c++)s[r][c]=_ISBOX[s[r][c]];}
  function ishift(){for(r=1;r<4;r++){var row=s[r].slice();for(c=0;c<4;c++)s[r][c]=row[(c-r+4)%4];}}
  function imix(){for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
    s[0][c]=_gmul(a0,14)^_gmul(a1,11)^_gmul(a2,13)^_gmul(a3,9);
    s[1][c]=_gmul(a0,9)^_gmul(a1,14)^_gmul(a2,11)^_gmul(a3,13);
    s[2][c]=_gmul(a0,13)^_gmul(a1,9)^_gmul(a2,14)^_gmul(a3,11);
    s[3][c]=_gmul(a0,11)^_gmul(a1,13)^_gmul(a2,9)^_gmul(a3,14);}}
  ark(Nr);
  for(var round=Nr-1;round>=1;round--){ishift();isub();ark(round);imix();}
  ishift();isub();ark(0);
  var out=[];for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;
}
function _aesCbcDecrypt(ct,key,iv){
  var ks=_keyExp(key),out=[],prev=iv.slice(),off,i;
  for(off=0;off+16<=ct.length;off+=16){
    var block=ct.slice(off,off+16),dec=_invCipher(block,ks);
    for(i=0;i<16;i++)out.push(dec[i]^prev[i]);
    prev=block;
  }
  var pad=out[out.length-1];
  if(pad>0&&pad<=16)out=out.slice(0,out.length-pad);
  return out;
}
function _hexBytes(h){var b=[];for(var i=0;i+1<h.length;i+=2)b.push(parseInt(h.substr(i,2),16));return b;}
function _strBytes(s){var b=[];for(var i=0;i<s.length;i++)b.push(s.charCodeAt(i)&0xff);return b;}
function _bytesToStr(b){var s='',i=0;while(i<b.length){var c=b[i++];if(c<0x80)s+=String.fromCharCode(c);else if(c<0xE0)s+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f));else if(c<0xF0)s+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f));else{var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f);cp-=0x10000;s+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF));}}return s;}

function _hubstream(url) {
  var host = (url.match(/^(https?:\\/\\/[^/#?]+)/) || [])[1] || 'https://hubstream.art';
  var tail = String(url).split('#').pop();
  var hash = tail.indexOf('/') !== -1 ? tail.split('/').pop() : tail;
  if (!hash) return Promise.resolve([]);
  return fetch(host + '/api/v1/video?id=' + hash, { headers: { 'User-Agent': UA, 'Referer': url } }).then(function (r) {
    var enc = _trim(r.body || '');
    if (!/^[0-9a-fA-F]+$/.test(enc) || enc.length % 32 !== 0) return [];
    var ct = _hexBytes(enc), key = _strBytes('kiemtienmua911ca'), ivs = ['1234567890oiuytr', '0123456789abcdef'];
    for (var i = 0; i < ivs.length; i++) {
      try {
        var pt = _bytesToStr(_aesCbcDecrypt(ct, key, _strBytes(ivs[i])));
        var m = pt.match(/"source":"([^"]+)"/);
        if (!m) continue;
        var file = m[1].replace(/\\\\\\//g, '/');
        if (!/^https?:/i.test(file)) continue;
        var subs = [];
        var sm = pt.match(/"subtitle":\\{([^}]*)\\}/);
        if (sm) {
          var sp, sre = /"([^"]+)":"([^"]+)"/g;
          while ((sp = sre.exec(sm[1])) !== null) {
            var su = sp[2].replace(/\\\\\\//g, '/').split('#')[0];
            if (!/\\.(vtt|srt)/i.test(su)) continue;
            subs.push({ url: /^https?:/i.test(su) ? su : (host + su), lang: sp[1], label: sp[1], format: /\\.srt/i.test(su) ? 'srt' : 'vtt' });
          }
        }
        var src = _src(file, _quality(file) || 'auto', 'HDHub4u [HubStream]');
        src.headers = { 'User-Agent': UA, 'Referer': host + '/', 'Origin': host };
        src.subtitles = subs;
        return [src];
      } catch (e) {}
    }
    return [];
  }).catch(function () { return []; });
}

function _dispatch(link) {
  var l = String(link).toLowerCase();
  if (l.indexOf('hblinks') !== -1) return _hblinks(link);
  if (l.indexOf('hubcloud') !== -1) return _hubcloud(link);
  if (l.indexOf('hubdrive') !== -1) return _hubdrive(link);
  if (l.indexOf('hdstream4u') !== -1) return _vidhide(link);
  if (l.indexOf('pixeldra') !== -1) {
    var b = (link.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || '';
    var fin = link.indexOf('download') !== -1 ? link : (b + '/api/file/' + link.replace(/\\/$/, '').split('/').pop() + '?download');
    return Promise.resolve([_src(fin, 'auto', 'HDHub4u [Pixeldrain]')]);
  }
  if (l.indexOf('hubstream') !== -1) return _hubstream(link);
  if (/\\.(mp4|mkv|m3u8)(\\?|$)/i.test(l)) return Promise.resolve([_src(link, _quality(link), 'HDHub4u')]);
  return Promise.resolve([]);
}

function getVideoSources(episodeUrl) {
  var hrefs = _epHrefs(episodeUrl).slice(0, 12);
  if (!hrefs.length) return Promise.reject(new Error('HDHub4u: no download links'));
  var jobs = hrefs.map(function (raw) {
    var p = /\\?id=|gadgets/i.test(raw) ? _resolveRedirect(raw) : Promise.resolve(raw);
    return p.then(function (resolved) { return resolved ? _dispatch(resolved) : []; }).catch(function () { return []; });
  });
  return Promise.all(jobs).then(function (lists) {
    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var k = 0; k < arr.length; k++) { var s = arr[k]; if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); } }
    }
    if (!out.length) throw new Error('HDHub4u: no playable links resolved');
    return out;
  });
}
`
  },
  {
    id: "hianime",
    name: "HiAnime",
    kind: "anime",
    lang: "en",
    rank: 1004,
    js: `// HiAnime — anime source for the Zangetsu provider repo (hianime.at).
//
// The site renders its catalogue server-side, so browse/detail/episodes are all
// regex over HTML. The two ajax routes the player uses aren't in the page markup
// at all — the theme builds them from a \`rest_url\` config — so they're spelled
// out here:
//   /search?keyword=                           -> flw-item cards
//   /<slug>                                    -> poster, synopsis, sub/dub ticks
//   /api/theme/episode/list/<animeId>          -> { html } of ep-item anchors
//   /api/theme/episode/servers?episodeId=<id>  -> { html }, data-hash = b64 embed
//   <embed>/stream/getSources(New)?id=&type=   -> m3u8 + subtitle tracks
//
// The anime id is just the trailing number of the slug (dan-da-dan-86 -> 86).
//
// VidPlay (vidtube) uses getSources. MegaPlay now encrypts BOTH getSources and
// getSourcesNew into an \`enc\` blob, so it hands us nothing playable any more.
// Zoko has no sources endpoint at all — the embed page carries the whole player
// config in one obfuscated blob, which is a request cheaper than either.
//
// That mix matters: roughly a quarter of episodes list no VidPlay server (ep1 of
// One Piece and Naruto among them). Those used to fail outright with every other
// server either encrypted or unsupported. Zoko is on all of them.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hianime';

var SITE = 'https://hianime.at';
var API = SITE + '/api/theme/';
// MegaPlay/VidPlay encrypt getSources into \`enc\`; decrypt with the player's
// own AES-256-CBC key/iv (same constants as the app's js host).
var MEGA_AES_KEY = 'i?LMTAx0Q6,:}50U';
var MEGA_AES_IV = "W0;27ToaUpl_P%'c";
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Embed hosts that hand back a plain m3u8 (via getSources or getSourcesNew).
var PLAYER_RE = /^https?:\\/\\/(?:[a-z0-9-]+\\.)?(?:vidtube\\.[a-z]+|megaplay\\.[a-z]+)/i;
// Zoko is extracted differently — see _extractZoko.
var ZOKO_RE = /^https?:\\/\\/(?:[a-z0-9-]+\\.)?zokoanime\\.[a-z]+/i;
// Fixed XOR key from the player's own core/obfuscate.js.
var ZOKO_KEY = 'otaku-embed-v1';

function getInfo() {
  return { name: 'HiAnime', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.2.2' };
}

// VidPlay (vidtube) only exposes getSources. MegaPlay's getSourcesNew used to
// return a plain sources.file and no longer does — kept pointing at it anyway,
// since it's the endpoint that would come back first if they ever relent.
function _sourcesUrl(base, dataId, type) {
  var path = /megaplay\\.[a-z]+/i.test(String(base || ''))
    ? '/stream/getSourcesNew' : '/stream/getSources';
  return base + path + '?id=' + dataId + '&type=' + type;
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. \`xhr\` adds the ajax header the /api/theme routes are
// called with by the site itself — they answer without it today, but sending it
// costs nothing and survives them tightening up.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
// Both ajax routes answer { status, html } — the payload is an HTML string.
function _ajax(path, ref) {
  return _get(API + path, ref, true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; }
    return (j && typeof j.html === 'string') ? j.html : '';
  });
}
function _b64(s) {
  try {
    var b = base64ToBytes(String(s || '')), o = '';
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]);
    return o;
  } catch (e) { return ''; }
}
function _text(s) { return htmlText(String(s || '').replace(/<[^>]*>/g, '')).replace(/^\\s+|\\s+$/g, ''); }
function _year(s) { var m = String(s || '').match(/(19|20)\\d{2}/); return m ? m[0] : null; }
// Slug = the last path segment, with or without the /watch/ prefix, and always
// ending in the anime id (…-86). Genre/studio links have no trailing id, so
// they can't be mistaken for a title.
function _slug(chunk) {
  var m = String(chunk || '').match(/href="[^"]*\\/(?:watch\\/)?([a-z0-9][a-z0-9-]*-\\d+)(?:\\?[^"]*)?"/i);
  return m ? m[1] : null;
}
function _animeId(slug) { var m = String(slug || '').match(/-(\\d+)$/); return m ? m[1] : null; }
// Sub/dub badge counts. The <i> icon inside the badge carries a class with a
// digit in it ("mr-1"), so the tags have to go before reading the number.
function _tick(chunk, name) {
  var m = String(chunk || '').match(new RegExp('tick-' + name + '"[^>]*>([\\\\s\\\\S]*?)<\\\\/div>'));
  if (!m) return 0;
  var n = m[1].replace(/<[^>]*>/g, '').match(/\\d+/);
  return n ? parseInt(n[0], 10) : 0;
}

// ── Cards ───────────────────────────────────────────────────────────────────
// The three card shapes on the site (grid flw-item, home spotlight deslide-item,
// trending item) differ in layout but all carry a film-poster-img <img> whose
// alt is the title, plus a slug link, so one parser covers the lot. The poster
// is what tells a card apart from the site furniture that also sits in a
// \`class="item"\` (the az-list, the login menu).
function _cards(seg) {
  var out = [], seen = {};
  // Splitting on the card containers alone leaves the last card running to the
  // end of whatever was passed in, so it reads its badges off the sidebar or
  // the footer — end the run at the enclosing section too.
  var chunks = String(seg || '').split(/class="(?:flw-item|deslide-item|item)[\\s"]|<\\/section|<footer/);
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var img = (c.match(/<img\\b[^>]*film-poster-img[^>]*>/i) || [])[0];
    var slug = _slug(c);
    if (!img || !slug || seen[slug]) continue;
    var title = (img.match(/alt="([^"]+?)(?:\\s+Poster)?"/i) || [])[1]
      || (c.match(/title="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: _text(title), englishTitle: _text(title),
      cover: (img.match(/src="([^"]+)"/i) || [])[1] || null,
      url: slug, type: 'anime', sourceId: SOURCE_ID,
      subCount: _tick(c, 'sub'), dubCount: _tick(c, 'dub') });
  }
  return out;
}

// ── Search ──────────────────────────────────────────────────────────────────
// One page of results, no pagination links in the markup — page 2+ is empty
// rather than a repeat of page 1.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1 || (page && page > 1)) return Promise.resolve([]);
  return _get(SITE + '/search?keyword=' + encodeURIComponent(q), SITE + '/')
    .then(function (html) {
      // Results only: the page's Top 10 sidebar is built from the same card
      // markup and would otherwise ride along as matches.
      var i = html.indexOf('film_list-wrap');
      if (i < 0) return [];
      var j = html.indexOf('</section', i);
      return _cards(html.substring(i, j < 0 ? html.length : j));
    })
    .catch(function () { return []; });
}

// ── Home ────────────────────────────────────────────────────────────────────
// Sections are marked by their <h2 class="cat-heading">; slice each from its
// heading to the next one. The spotlight carousel sits above the first heading.
function getHome(opts) {
  var want = { 'Trending': 1, 'Latest Episode': 1, 'New On HiAnime': 1, 'Top Upcoming': 1 };
  return _get(SITE + '/home', SITE + '/').then(function (html) {
    var marks = [], re = /<h2 class="cat-heading[^"]*">\\s*([^<]+?)\\s*<\\/h2>/g, m;
    while ((m = re.exec(html)) !== null) marks.push({ name: m[1], at: m.index });
    var rows = [];
    var spot = _cards(marks.length ? html.substring(0, marks[0].at) : '');
    if (spot.length) rows.push({ title: 'Spotlight', items: spot });
    for (var i = 0; i < marks.length; i++) {
      if (!want[marks[i].name]) continue;
      var end = (i + 1 < marks.length) ? marks[i + 1].at : html.length;
      var items = _cards(html.substring(marks[i].at, end));
      if (items.length) rows.push({ title: marks[i].name, items: items });
    }
    return rows;
  }).catch(function () { return []; });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _info(html, label) {
  var m = String(html).match(new RegExp('item-head">' + label
    + ':<\\\\/span>\\\\s*<span class="name">([\\\\s\\\\S]*?)<\\\\/span>'));
  return m ? _text(m[1]) : null;
}
// Anchor texts out of one sidebar row. Bounded to that row's block: the page
// also carries an all-genres widget and a promo blurb that links studios, and
// scanning the whole document picks those up as the title's own.
function _infoList(html, label, cap) {
  var block = String(html).match(new RegExp('item-head">' + label
    + ':<\\\\/span>([\\\\s\\\\S]*?)<\\\\/div>'));
  if (!block) return [];
  var out = [], seen = {}, m, re = /<a\\b[^>]*>\\s*([^<]+?)\\s*</g;
  while ((m = re.exec(block[1])) !== null && out.length < cap) {
    var t = _text(m[1]);
    if (t && !seen[t]) { seen[t] = 1; out.push(t); }
  }
  return out;
}

// The episode list gives no per-episode sub/dub flags — that only comes from the
// server list — so the url carries the category the player asked for, then the
// episode id and number. Category leads because the player's Sub/Dub toggle
// rewrites that first segment in place.
function _epUrl(cat, epId, num) { return 'hianime://' + cat + '/' + epId + '/' + num; }

// Episode thumbnails (Kitsu, keyed by MAL id). The site exposes no per-episode
// image, so without this the app falls back to the series poster. Kitsu covers
// older anime too and is reachable where TMDB is ISP-blocked. Best-effort: any
// failure just leaves the poster fallback.
//
// It does NOT get to be slow, though. getEpisodes() runs on the playback path,
// so time spent here comes out of the app's per-source budget — see below.
// Returns { episodeNumber: thumbnailUrl }.
function _kitsuStills(malId, epCount) {
  if (!malId) return Promise.resolve({});
  var H = { 'Accept': 'application/vnd.api+json', 'User-Agent': UA };
  var mapUrl = 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist/anime'
    + '&filter%5BexternalId%5D=' + encodeURIComponent(malId) + '&include=item';
  return fetch(mapUrl, { headers: H, timeoutMs: 8000 }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { return {}; }
    var inc = (j && j.included) || [];
    var kid = null;
    for (var i = 0; i < inc.length; i++) {
      if (inc[i] && inc[i].type === 'anime') { kid = inc[i].id; break; }
    }
    if (!kid) return {};
    // Pages are independent and the site already told us how many episodes
    // there are, so ask for them at once instead of walking them.
    //
    // Walking cost nine round trips back to back — about five seconds on One
    // Piece. getEpisodes() is on the playback path, so that alone spent most
    // of the app's per-source budget before a stream was ever requested: the
    // source got dropped as too slow and then benched for ten minutes, which
    // looks exactly like a dead source. These are episode thumbnails.
    var pages = Math.min(9, Math.max(1, Math.ceil((epCount || 20) / 20)));
    var map = {};
    function take(res) {
      var eps = (res && res.data) || [];
      for (var k = 0; k < eps.length; k++) {
        var at = eps[k].attributes || {};
        var th = at.thumbnail && at.thumbnail.original;
        if (at.number != null && th) map[at.number] = th;
      }
    }
    function fetchPage(i) {
      return fetch('https://kitsu.io/api/edge/anime/' + kid +
        '/episodes?page%5Blimit%5D=20&page%5Boffset%5D=' + (i * 20),
        { headers: H, timeoutMs: 8000 })
        .then(function (r2) {
          try { return JSON.parse(r2.body || 'null'); } catch (e) { return null; }
        })
        .catch(function () { return null; });
    }
    // Three at a time. All nine at once is quicker still, but Kitsu rate-limits
    // the burst and silently drops a third of the thumbnails; three keeps every
    // page and is already a fraction of a second.
    function wave(start) {
      if (start >= pages) return Promise.resolve(map);
      var batch = [];
      for (var i = start; i < Math.min(start + 3, pages); i++) batch.push(fetchPage(i));
      return Promise.all(batch).then(function (res) {
        for (var j = 0; j < res.length; j++) take(res[j]);
        return wave(start + 3);
      });
    }
    return wave(0).catch(function () { return map; });
  }).catch(function () { return {}; });
}

// No MAL id anywhere in the page markup, but the Zoko server's embed url is
// built as /stream/mal/<malId>/<ep>/, so one server list for the first episode
// hands it over. Drives tracker sync and the Kitsu stills above; best-effort,
// a title without that server just gets a null id.
function _malFromServers(epId, ref) {
  return _ajax('episode/servers?episodeId=' + encodeURIComponent(epId), ref).then(function (html) {
    var m, re = /data-hash="([^"]+)"/g;
    while ((m = re.exec(html)) !== null) {
      var hit = _b64(m[1]).match(/\\/mal\\/(\\d+)\\//);
      if (hit) return parseInt(hit[1], 10);
    }
    return null;
  }).catch(function () { return null; });
}

// Opening a show and then pressing play asks for the same detail twice: once
// to draw the episode list, once inside getEpisodes() on the playback path.
// The second pass refetched everything — the watch page, the episode list
// (~1MB on a long-running show) and the whole Kitsu pass — which on a TV box
// was enough on its own to blow the app's per-source budget and get the source
// benched as dead. Five minutes is far shorter than the gap between episodes.
var _detailCache = {};
var _DETAIL_TTL = 300000;

function getDetail(url, opts) {
  var key = String(url) + '|' + _mode(opts);
  var hit = _detailCache[key];
  var now = Date.now();
  if (hit && (now - hit.at) < _DETAIL_TTL) return Promise.resolve(hit.value);
  return _fetchDetail(url, opts).then(function (d) {
    // Only a detail that actually carries episodes is worth keeping — caching
    // a failed parse would pin the failure for the whole window.
    if (d && d.episodes && d.episodes.length) {
      _detailCache[key] = { at: Date.now(), value: d };
    }
    return d;
  });
}

function _fetchDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  var watchRef = SITE + '/watch/' + slug;
  return _get(SITE + '/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var stats = (html.match(/class="film-stats"([\\s\\S]{0,1500})/) || [])[1] || '';
    var title = _text((html.match(/<h2[^>]*class="[^"]*film-name[^"]*"[^>]*>([\\s\\S]*?)<\\/h2>/) || [])[1]) || slug;
    var base = {
      id: slug, title: title, englishTitle: title, url: slug,
      cover: (html.match(/class="anisc-poster"[\\s\\S]{0,400}?<img[^>]+src="([^"]+)"/) || [])[1] || null,
      description: _text((html.match(/class="film-description[^"]*"[\\s\\S]{0,200}?<div class="text">([\\s\\S]*?)<\\/div>/) || [])[1]),
      status: _info(html, 'Status') || 'unknown',
      genres: _infoList(html, 'Genres', 8), studios: _infoList(html, 'Studios', 4),
      type: 'anime', sourceId: SOURCE_ID, episodes: [],
      year: _year(_info(html, 'Aired')), malId: null,
      subCount: _tick(stats, 'sub'), dubCount: _tick(stats, 'dub')
    };
    var animeId = (html.match(/data-animeid="(\\d+)"/) || [])[1] || _animeId(slug);
    if (!animeId) return base;
    return _ajax('episode/list/' + animeId, watchRef).then(function (lhtml) {
      // The list ships every episode at once — the EPS: 001-100 dropdown only
      // pages what's already there — so long runs need no extra requests.
      var out = [], first = null, re = /<a\\b([^>]*\\bep-item\\b[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var epId = (attrs.match(/data-id="(\\d+)"/) || [])[1];
        if (!epId) continue;
        if (!first) first = epId;
        var n = parseInt((attrs.match(/data-number="(\\d+)"/) || [])[1] || (out.length + 1), 10);
        var t = (attrs.match(/title="([^"]*)"/) || [])[1];
        out.push({ id: cat + ':' + n, number: n,
          title: t ? _text(t) : ('Episode ' + n), url: _epUrl(cat, epId, n) });
      }
      base.episodes = out;
      if (!out.length) return base;
      return _malFromServers(first, watchRef).then(function (mal) {
        base.malId = mal;
        return _kitsuStills(mal, out.length).then(function (stills) {
          for (var k = 0; k < out.length; k++) {
            var still = stills && stills[out[k].number];
            if (still) out[k].thumbnail = still;
          }
          return base;
        }).catch(function () { return base; });
      }).catch(function () { return base; });
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server list → embed → getSources ───────────────────────────────
function _parseServers(html) {
  var out = [], m;
  var re = /data-type="(\\w+)"[\\s\\S]{0,200}?data-server-name="([^"]+)"[\\s\\S]{0,200}?data-hash="([^"]+)"/g;
  while ((m = re.exec(html)) !== null) {
    var url = _b64(m[3]);
    if (url) out.push({ type: m[1], name: m[2], url: url });
  }
  return out;
}
// VidPlay first (one request cheaper than Zoko, and a stable CDN), Zoko next.
// The MegaPlay-backed names trail them: they answer, but only with \`enc\`, so
// they cost two requests to learn nothing. Left in rather than dropped — if
// MegaPlay ever serves a plain file again this ordering still works.
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidplay') > -1) return 0;
  if (n.indexOf('zoko') > -1) return 1;
  if (n.indexOf('vidstream') > -1) return 2;
  if (n.indexOf('hd') > -1) return 3;
  return 5;
}

function getVideoSources(episodeUrl) {
  var parts = String(episodeUrl).replace('hianime://', '').split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var epId = parts[1] || '';
  // Anything else is a url from the old API-backed chain, whose player links
  // died with that host — nothing to resolve, so say so instead of guessing.
  if (!/^\\d+$/.test(epId)) return Promise.reject(new Error('HiAnime: no episode id'));

  return _ajax('episode/servers?episodeId=' + encodeURIComponent(epId), SITE + '/watch/')
    .then(function (html) {
      var servers = _parseServers(html), want = [];
      for (var i = 0; i < servers.length; i++) {
        var t = servers[i].type;
        // hsub is the same audio as sub with hardcoded signs, so it stands in.
        var ok = (cat === 'dub') ? (t === 'dub') : (t === 'sub' || t === 'hsub');
        if (ok) want.push(servers[i]);
      }
      // No fallback to the other cut: the file a host hands back is only ever
      // labelled by what we asked for, so standing in a sub pack for a missing
      // dub would play Japanese audio under a Dub badge.
      want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
      return _tryServers(want, 0, cat);
    });
}

function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('HiAnime: no playable server'));
  var url = list[i].url;
  var next = function () { return _tryServers(list, i + 1, cat); };
  if (ZOKO_RE.test(url)) return _extractZoko(url, cat).catch(next);
  if (!PLAYER_RE.test(url)) return next();
  return _extractPlayer(url, cat).catch(next);
}

// Zoko ships the player config as base64 of the JSON XOR'd with a fixed key
// (its own core/obfuscate.js does exactly this, in reverse). One GET, no
// sources endpoint, no decryption key to chase.
function _zokoConfig(html) {
  var blob = (String(html || '').match(/window\\.__P\\s*=\\s*"([^"]+)"/) || [])[1];
  if (!blob) return null;
  var bytes = base64ToBytes(blob), out = [];
  for (var i = 0; i < bytes.length; i++) {
    out.push(bytes[i] ^ ZOKO_KEY.charCodeAt(i % ZOKO_KEY.length));
  }
  try { return JSON.parse(_utf8(out)); } catch (e) { return null; }
}

// The blob is UTF-8, and subtitle labels are the part that isn't ASCII. Decoded
// by hand rather than through escape/unescape, which are Annex B and not worth
// betting a source on.
function _utf8(b) {
  var s = '', i = 0;
  while (i < b.length) {
    var c = b[i++];
    if (c < 0x80) { s += String.fromCharCode(c); continue; }
    if (c < 0xE0) { s += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F)); continue; }
    if (c < 0xF0) {
      s += String.fromCharCode(((c & 0x0F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F));
      continue;
    }
    var cp = (((c & 0x07) << 18) | ((b[i++] & 0x3F) << 12)
      | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F)) - 0x10000;
    s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }
  return s;
}

function _extractZoko(embed, cat) {
  var base = (embed.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || 'https://zokoanime.video';
  return _get(embed, SITE + '/').then(function (html) {
    var cfg = _zokoConfig(html);
    var file = cfg && cfg.src;
    if (!file) throw new Error('HiAnime: no Zoko stream');
    var subs = [], tracks = cfg.subtitles || [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t || !t.src) continue;
      subs.push({ url: t.src, lang: t.lang || 'Sub', label: t.label || t.lang || 'Sub',
        format: /\\.srt(\\?|$)/i.test(t.src) ? 'srt' : 'vtt', 'default': !!t['default'] });
    }
    // The CDN hands these out per embed fetch and stops answering a while after,
    // so they are resolved at play time and never cached.
    return _streams(file, { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base },
      cat, subs);
  });
}

// The cut (sub/hsub/dub) the embed url was issued for. Sources are keyed by
// the embed's data-id, and that id is SHARED across the three cuts — the audio
// comes from \`type\` alone — so a dub embed asked without it answers with the
// sub stream.
function _cutOf(embed) {
  return (String(embed || '').match(/\\/(sub|hsub|dub)\\/?(?:[?#]|$)/i) || [])[1] || null;
}

function _extractPlayer(embed, cat) {
  var base = (embed.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || 'https://vidtube.site';
  var type = _cutOf(embed) || cat;
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\\d+)"/) || [])[1];
    if (!dataId) throw new Error('HiAnime: no embed id');
    return fetch(_sourcesUrl(base, dataId, type), {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('HiAnime: bad getSources'); }
      var s = j && j.sources;
      var subs = [], tracks = (j && j.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
          format: /\\.srt(\\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
      }
      var rest = function (file) {
        return _streams(file, { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base },
          cat, subs);
      };
      // Plain sources.file when present; otherwise decrypt the \`enc\` blob
      // MegaPlay/VidPlay now return instead ({"file":"…master.m3u8"}).
      var file = s ? (s.file || (s[0] && s[0].file)) : null;
      if (file) return rest(file);
      if (!j || !j.enc) throw new Error('HiAnime: no stream file');
      return aesCbcDecryptB64Url(j.enc, MEGA_AES_KEY, MEGA_AES_IV).then(function (pt) {
        var o; try { o = JSON.parse(pt); } catch (e) { throw new Error('HiAnime: bad enc payload'); }
        var f = o && o.file;
        if (!f) { var ss = o && o.sources; f = ss ? (ss.file || (ss[0] && ss[0].file)) : null; }
        if (!f) throw new Error('HiAnime: no stream file');
        return rest(f);
      });
    });
  });
}

// Shared by both extractors: wrap [file] as a stream list, and when it's an
// adaptive master, expose each rendition too so the player gets a real quality
// menu. "auto" stays first so adaptive switching is still the default.
function _streams(file, hdrs, cat, subs) {
  var mk = function (u, q) {
    return { url: u, quality: q, container: /\\.m3u8(\\?|$)/i.test(u) ? 'hls' : 'mp4',
      headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs };
  };
  if (!/\\.m3u8(\\?|$)/i.test(file)) return Promise.resolve([mk(file, 'auto')]);
  return fetch(file, { headers: { 'User-Agent': hdrs['User-Agent'], 'Referer': hdrs.Referer } })
    .then(function (mr) {
      var body = mr.body || '';
      var dir = file.replace(/[^/]*(\\?.*)?$/, '');
      var vs = [], m, re = /#EXT-X-STREAM-INF:[^\\n]*?RESOLUTION=\\d+x(\\d+)[^\\n]*\\r?\\n([^\\r\\n#]+)/gi;
      while ((m = re.exec(body)) !== null) {
        var uri = String(m[2]).replace(/^\\s+|\\s+$/g, '');
        if (!uri) continue;
        vs.push({ h: parseInt(m[1], 10), url: /^https?:/i.test(uri) ? uri : (dir + uri) });
      }
      vs.sort(function (a, b) { return b.h - a.h; });
      var out = [mk(file, 'auto')];
      for (var k = 0; k < vs.length; k++) out.push(mk(vs[k].url, vs[k].h + 'p'));
      return out;
    }).catch(function () { return [mk(file, 'auto')]; });
}
`
  },
  {
    id: "vegamovies",
    name: "VegaMovies",
    kind: "movie",
    lang: "hi",
    rank: 1005,
    js: `// VegaMovies — movie/series source for the Zangetsu provider repo.
//
// HTML-scraped catalog (regex; no DOM parser in the runtime) + a JSON search
// endpoint. Self-contained video chain:
//   page download buttons  ->  intermediate link page (nexdrive/…)
//   ->  V-Cloud link  ->  V-Cloud file page  ->  direct files
//   (FSL / Mega / Buzz / Pixeldrain / 10Gbps / Download).
// The live domain rotates, so it's fetched once from the upstream list and
// cached, with a sane fallback.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'vegamovies';

var DEFAULT_MAIN = 'https://vegamovies.mq';
var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _main = null;
function _domains() {
  if (_main) return Promise.resolve(_main);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    var j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    _main = String(j['vegamovies'] || DEFAULT_MAIN).replace(/\\/$/, '');
    return _main;
  }).catch(function () { _main = DEFAULT_MAIN; return _main; });
}

function getInfo() {
  return {
    name: 'VegaMovies', lang: 'hi', baseUrl: DEFAULT_MAIN,
    logo: DEFAULT_MAIN + '/favicon.ico', type: 'movie', version: '1.0.4'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// The sandbox has base64ToBytes but no atob.
function _b64(s) {
  try { var b = base64ToBytes(String(s || '')); var o = ''; for (var i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return o; }
  catch (e) { return ''; }
}
// Use the host absUrl — QuickJS has no URL constructor, so \`new URL()\` throws
// there and would silently leave relative hrefs (e.g. search.php permalinks)
// unresolved, breaking detail loads from search.
function _abs(href, base) { return absUrl(href, base); }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\\s*download\\s+/i, '');
  t = t.split(/\\s*\\(/)[0].split(/\\bseason\\b/i)[0].split(/\\bS0?\\d/)[0];
  // Cutting at S01 can leave the opening bracket of "{S01E01 Added}" behind.
  t = _trim(t).replace(/[\\s\\-–:,\\[{]+$/, '');
  return _trim(t) || _trim(htmlText(raw || ''));
}

// Cards live in \`div.movies-grid > a\`, each wrapping a lazy <img> whose real
// poster is in data-src and whose title is the alt text ("Download …").
function _cards(html, main) {
  var out = [], seen = {};
  var gi = html.indexOf('movies-grid');
  var block = gi >= 0 ? html.slice(gi) : html;
  var re = /<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g, m;
  while ((m = re.exec(block)) !== null) {
    var href = m[1], inner = m[2];
    if (!/<img/i.test(inner)) continue;
    var alt = (inner.match(/<img[^>]+alt="([^"]*)"/i) || [])[1] || '';
    var title = _trim(htmlText(alt).replace(/^download\\s+/i, ''));
    if (!title) continue;
    var url = _abs(href, main);
    if (seen[url] || /\\/(category|page|genre|tag|web-series|movies)\\/?$/i.test(url)) continue;
    if (/\\/(category|page|genre|tag)\\//i.test(url)) continue;
    seen[url] = 1;
    var dsrc = (inner.match(/<img[^>]+data-src="([^"]+)"/i) || [])[1];
    var src = (inner.match(/<img[^>]+\\bsrc="([^"]+)"/i) || [])[1];
    var img = (dsrc && dsrc.indexOf('http') === 0) ? dsrc
      : ((src && src.indexOf('http') === 0) ? src : null);
    out.push({
      id: url, title: title, cover: img ? _abs(img, main) : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest', path: '/' },
    // The /category/ prefix now 301s to the bare path — go straight there so a
    // row still fills when redirects aren't followed.
    { title: 'Netflix', path: '/web-series/netflix/' },
    { title: 'Amazon Prime', path: '/web-series/amazon-prime-video/' },
    { title: 'Anime Series', path: '/anime-series/' },
    { title: 'Korean Series', path: '/korean-series/' }
  ];
  return _domains().then(function (main) {
    return Promise.all(rows.map(function (row) {
      return _get(main + row.path, main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

// Search is a JSON endpoint: /search.php?q=&page= -> { hits: [{ document }] }.
function search(query, page, opts) {
  return _domains().then(function (main) {
    var u = main + '/search.php?q=' + encodeURIComponent(query || '') + '&page=' + (page || 1);
    return _get(u, main + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var hits = (j && j.hits) || [];
      var out = [];
      for (var i = 0; i < hits.length; i++) {
        var d = (hits[i] && hits[i].document) || {};
        var url = d.permalink; if (!url) continue;
        out.push({
          id: _abs(url, main), title: _cleanTitle(d.post_title || ''),
          cover: d.post_thumbnail || null, url: _abs(url, main),
          type: 'movie', sourceId: SOURCE_ID
        });
      }
      if (out.length) return out;
      // Fallback to the HTML search page.
      return _get(main + '/?s=' + encodeURIComponent(query || ''), main + '/')
        .then(function (h) { return _cards(h, main); });
    });
  }).catch(function () { return []; });
}

// ── episode url packing (a list of intermediate/V-Cloud links) ───────────────
function _epUrl(links) { return 'vega://' + encodeURIComponent(JSON.stringify(links)); }
function _epLinks(url) {
  try { return JSON.parse(decodeURIComponent(String(url).replace(/^vega:\\/\\//, ''))); }
  catch (e) { return []; }
}

// Anchors wrapping a \`.dwd-button\` point at the per-quality intermediate page.
function _movieLinks(html) {
  var out = [], m;
  var re = /<a[^>]+href="([^"]+)"[^>]*>(?:(?!<\\/a>)[\\s\\S])*?dwd-button/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return _uniq(out);
}

function getDetail(url, opts) {
  return _domains().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var title = _cleanTitle(
        (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/) || [])[1] || 'Untitled');
      var poster = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] ||
        (html.match(/<p[^>]*>\\s*<img[^>]+src="([^"]+)"/i) || [])[1] || null;
      var description = htmlText(
        (html.match(/SYNOPSIS\\/PLOT[\\s\\S]{0,80}?<\\/h3>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>/i) || [])[1] ||
        (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '');
      var year = ((title.match(/\\((19|20)\\d{2}\\)/) || [])[0] || '').replace(/[()]/g, '') || null;

      var isSeries = /Series[\\s-]*(?:Info|SYNOPSIS\\/PLOT|synopsis)/i.test(html) ||
        /(?:Season|Episode)\\s*0?\\d/i.test(html) && /\\bepisode\\b/i.test(html);

      var base = {
        id: u, title: title, cover: poster, url: u, description: description,
        status: 'unknown', genres: [], studios: [], type: 'movie',
        sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      if (!isSeries) {
        var links = _movieLinks(html);
        base.episodes = links.length
          ? [{ id: 'movie', title: title, number: 1, url: _epUrl(links) }]
          : [];
        base.subCount = base.episodes.length;
        return base;
      }
      return _seriesEpisodes(html, main).then(function (eps) {
        base.type = 'movie'; // app type stays movie for non-anime sources
        base.episodes = eps;
        base.subCount = eps.length;
        return base;
      });
    });
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// Series: quality headers (h3/h5 with "Season N … 1080p") -> the intermediate
// link -> that page's V-Cloud links, one per episode in order. Group across
// qualities by (season, episodeIndex).
function _seriesEpisodes(html, main) {
  var tags = [], m;
  var re = /<h[35][^>]*>([\\s\\S]*?)<\\/h[35]>/gi;
  var positions = [];
  while ((m = re.exec(html)) !== null) {
    var text = htmlText(m[1]);
    if (/\\bzip\\b/i.test(text)) continue;
    if (!/(4K|\\d{3,4}p)/i.test(text)) continue;
    positions.push({ idx: m.index, end: re.lastIndex, text: text });
  }
  // For each quality header, the intermediate link is in the following <p>.
  var jobs = positions.map(function (p) {
    var after = html.slice(p.end, p.end + 1500);
    var season = (p.text.match(/(?:Season |S)0?(\\d+)/i) || [])[1];
    season = season ? parseInt(season, 10) : 1;
    // Only the V-Cloud button's page lists one link per episode. G-Direct sits
    // above it and points at file lockers we can't play, so it's the fallback.
    var inter = '', alt = '';
    var am, are = /<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g;
    while ((am = are.exec(after)) !== null) {
      var t = htmlText(am[2]);
      if (/\\bzip\\b|batch/i.test(t)) continue;
      if (/V-?Cloud/i.test(t)) { inter = am[1]; break; }
      if (!alt && /Episode|Download|G-?Direct/i.test(t)) alt = am[1];
    }
    if (!inter) inter = alt;
    if (!inter) return Promise.resolve({ season: season, links: [] });
    return _get(_abs(inter, main), main + '/').then(function (doc) {
      var links = [], lm, lre = /<a[^>]+href="([^"]+)"/g;
      while ((lm = lre.exec(doc)) !== null) {
        if (/vcloud/i.test(lm[1])) links.push(lm[1]);
      }
      return { season: season, links: _uniq(links) };
    }).catch(function () { return { season: season, links: [] }; });
  });

  return Promise.all(jobs).then(function (groups) {
    var byEp = {}; // "s|e" -> [links]
    groups.forEach(function (g) {
      for (var i = 0; i < g.links.length; i++) {
        var key = g.season + '|' + (i + 1);
        (byEp[key] || (byEp[key] = [])).push(g.links[i]);
      }
    });
    var out = [];
    Object.keys(byEp).forEach(function (key) {
      var parts = key.split('|');
      var s = parseInt(parts[0], 10), e = parseInt(parts[1], 10);
      out.push({
        id: 'S' + s + 'E' + e, number: e,
        title: 'S' + s + ' E' + e, url: _epUrl(byEp[key])
      });
    });
    out.sort(function (a, b) {
      var as = a.id.match(/S(\\d+)E(\\d+)/), bs = b.id.match(/S(\\d+)E(\\d+)/);
      if (as && bs) {
        if (as[1] !== bs[1]) return as[1] - bs[1];
        return as[2] - bs[2];
      }
      return 0;
    });
    return out;
  });
}

// ── V-Cloud / HubCloud file resolution ───────────────────────────────────────
function _src(url, quality, label) {
  return {
    url: url, quality: quality || 'auto',
    container: /\\.m3u8(\\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA }, kind: 'sub', audioLang: '',
    subtitles: [], label: _trim(label || '')
  };
}
function _baseOf(url) { return (String(url).match(/^(https?:\\/\\/[^/]+)/) || [])[1] || ''; }
function _serverName(label) {
  if (label.indexOf('fsl') !== -1) return 'FSL Server';
  if (label.indexOf('buzz') !== -1) return 'Buzz Server';
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) return 'Pixeldrain';
  if (label.indexOf('s3') !== -1) return 'S3 Server';
  if (label.indexOf('10gb') !== -1) return '10Gbps';
  if (label.indexOf('mega') !== -1) return 'Mega';
  if (label.indexOf('download') !== -1) return 'Download';
  return 'V-Cloud';
}

// A V-Cloud (or HubCloud) page -> direct file links via its button list.
function _vcloud(url) {
  return _get(url).then(function (html) {
    var link = '';
    if (url.indexOf('/video/') !== -1) {
      link = (html.match(/<div class="vd">[\\s\\S]*?<a[^>]+href="([^"]+)"/i) || [])[1] || '';
    } else {
      // The landing page hands the tokenised file page over in \`var url\`, now
      // wrapped in atob(atob(…)). Plain strings still show up on older pages.
      var um = html.match(/var\\s+url\\s*=\\s*(atob\\(atob\\()?\\s*'([^']*)'/);
      link = um ? (um[1] ? _b64(_b64(um[2])) : um[2]) : '';
    }
    if (!link) return [];
    if (!/^https?:/i.test(link)) link = _baseOf(url) + link;
    return _get(link).then(function (doc) {
      var header = htmlText((doc.match(/<div class="card-header[^"]*"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '');
      var size = htmlText((doc.match(/id=["']size["'][^>]*>([\\s\\S]*?)<\\//) || [])[1] || '');
// No resolution in the title means we don't know it — say so rather than
      // claiming one. The player hides its quality menu for an unknown stream
      // instead of showing a number that isn't real.
      var quality = _quality(header) || _quality(url) || null;
      var suffix = (header ? (' [' + header.replace(/\\s+/g, ' ').slice(0, 60) + ']') : '')
        + (size ? ' [' + size + ']' : '');
      // The Pixeldrain button ships a dead id in its href and a script swaps in
      // the live one, so take the script's value when it's there.
      var pxl = (doc.match(/var\\s+pxl\\s*=\\s*"([^"]+)"/) || [])[1] || '';
      var jobs = [], m;
      var re = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/a>|<a[^>]*class="[^"]*\\bbtn\\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g;
      while ((m = re.exec(doc)) !== null) {
        var blink = m[1] || m[3]; var text = htmlText(m[2] || m[4] || '').toLowerCase();
        if (!blink) continue;
        if (pxl && /pixeldrain/i.test(blink)) blink = pxl;
        jobs.push(_server(blink, text, quality, suffix));
      }
      return Promise.all(jobs).then(function (lists) {
        var out = []; for (var i = 0; i < lists.length; i++) if (lists[i]) out.push(lists[i]);
        return out;
      });
    });
  }).catch(function () { return []; });
}

function _server(link, label, quality, suffix) {
  // Skip file-locker / folder hosts that aren't a direct, playable stream.
  // gpdl/gamerxyt is the 10Gbps button — it lands on a link-generator page,
  // so the player would be handed HTML instead of the file.
  if (/gofile\\.io|megaup\\.net|vikingfile|filebee|filepress|gdflix|gdtot|gpdl\\d*\\.|gamerxyt/i.test(link)) {
    return Promise.resolve(null);
  }
  var name = 'VegaMovies [' + _serverName(label) + ']' + suffix;
  if (label.indexOf('buzz') !== -1) {
    return fetch(link + '/download', {
      headers: { 'Referer': link, 'User-Agent': UA }, followRedirects: false
    }).then(function (r) {
      var h = r.headers || {};
      var dl = h['hx-redirect'] || h['HX-Redirect'] || '';
      return dl ? _src(_baseOf(link) + dl, quality, name) : null;
    }).catch(function () { return null; });
  }
  if (label.indexOf('pixeldra') !== -1 || label.indexOf('pixel') !== -1) {
    var b = _baseOf(link);
    var fin = link.indexOf('download') !== -1 ? link
      : (b + '/api/file/' + link.replace(/\\/$/, '').split('/').pop() + '?download');
    return Promise.resolve(_src(fin, quality, name));
  }
  if (label.indexOf('fsl') !== -1 || label.indexOf('download') !== -1 ||
      label.indexOf('s3') !== -1 || label.indexOf('mega') !== -1 ||
      label.indexOf('10gb') !== -1) {
    return Promise.resolve(_src(link, quality, name));
  }
  if (/\\.(mp4|mkv|m3u8)(\\?|$)/i.test(link)) return Promise.resolve(_src(link, quality, name));
  return Promise.resolve(null);
}

// An intermediate (nexdrive/…) page -> its V-Cloud link(s).
function _vcloudLinksFrom(html) {
  var out = [], m, re = /<a[^>]+href="([^"]+)"/g;
  while ((m = re.exec(html)) !== null) { if (/vcloud/i.test(m[1])) out.push(m[1]); }
  return _uniq(out);
}

// Hosts that serve the whole file with no HTTP range support (seeking loops).
function _noRange(url) { return /googleusercontent|pages\\.dev/i.test(String(url)); }
function _seekableFirst(list) {
  var good = [], bad = [];
  for (var i = 0; i < list.length; i++) (_noRange(list[i].url) ? bad : good).push(list[i]);
  return good.concat(bad);
}

function getVideoSources(episodeUrl) {
  var links = _epLinks(episodeUrl).slice(0, 12);
  if (!links.length) return Promise.reject(new Error('VegaMovies: no links'));
  return _domains().then(function () {
    var jobs = links.map(function (link) {
      if (/vcloud/i.test(link)) return _vcloud(link);
      // Intermediate page → find its V-Cloud link(s) → resolve.
      return _get(link).then(function (html) {
        var vlinks = _vcloudLinksFrom(html);
        if (!vlinks.length) return [];
        return Promise.all(vlinks.map(_vcloud)).then(function (ls) {
          return ls.reduce(function (a, b) { return a.concat(b || []); }, []);
        });
      }).catch(function () { return []; });
    });
    return Promise.all(jobs).then(function (lists) {
      var out = [], seen = {};
      lists.forEach(function (l) {
        (l || []).forEach(function (s) {
          if (s && s.url && !seen[s.url]) { seen[s.url] = 1; out.push(s); }
        });
      });
      if (!out.length) throw new Error('VegaMovies: no playable sources');
      return _seekableFirst(out); // seekable mirrors first (range support)
    });
  });
}
`
  },
  {
    id: "multimovies",
    name: "MultiMovies",
    kind: "movie",
    lang: "hi",
    rank: 1006,
    js: `// MultiMovies — movie/series source for the Zangetsu provider repo.
//
// Catalog is a DooPlay WordPress theme (regex-scraped). Video chain:
//   detail / episode page  ->  player option (GDMIRROR)  ->  doo_player_ajax
//   ->  iqsmartgames embed  ->  mymovieapi / myseriesapi (fileslug)
//   ->  embedhelper.php  (mresult = {server: fileId} + siteUrls host map)
//   ->  StreamWish-family embed  ->  packed-JS unpack  ->  master.m3u8.
// No JS execution / no decryption needed — the file ids arrive in plaintext
// via the base64 \`mresult\` blob. Domain rotates, fetched from the upstream list.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'multimovies';

// Fallback for when the domain list above can't be reached — .homes went dark,
// so this has to track whatever the list is currently pointing at.
var DEFAULT_MAIN = 'https://multimovies.beer';
var URLS = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

var _urls = null;
function _loadUrls() {
  if (_urls) return Promise.resolve(_urls);
  return fetch(URLS, { headers: { 'User-Agent': UA } }).then(function (r) {
    try { _urls = JSON.parse(r.body || '{}'); } catch (e) { _urls = {}; }
    return _urls;
  }).catch(function () { _urls = {}; return _urls; });
}
function _main() {
  return _loadUrls().then(function (j) {
    return String(j['multimovies'] || DEFAULT_MAIN).replace(/\\/$/, '');
  });
}

function getInfo() {
  return {
    name: 'MultiMovies', lang: 'hi', baseUrl: DEFAULT_MAIN,
    // no /favicon.ico on this install, the theme icon is the only one served
    logo: DEFAULT_MAIN + '/wp-content/uploads/2024/01/'
      + 'cropped-CompressJPEG.online_512x512_image-192x192.png',
    type: 'movie', version: '1.0.3'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }
function _uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { if (a[i] && !s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } } return o; }
// Use the host absUrl — QuickJS has no URL constructor, so \`new URL()\` throws
// there and would silently leave relative hrefs unresolved.
function _abs(href, base) { return absUrl(href, base); }
function _baseOf(url) { return (String(url).match(/^(https?:\\/\\/[^/]+)/) || [])[1] || ''; }
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || url } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
// base64 -> JSON (mresult). The sandbox has base64ToBytes but no atob.
function _b64json(s) {
  try {
    var b = base64ToBytes(String(s || ''));
    var str = '';
    for (var i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
    return JSON.parse(str);
  } catch (e) { return null; }
}
function _cleanTitle(raw) {
  var t = htmlText(raw || '').replace(/^\\s*(?:download|watch)\\s+/i, '');
  t = t.replace(/^\\s*multimovies\\s*[|\\-–:]\\s*/i, '');
  return _trim(t);
}

// ── catalog cards ─────────────────────────────────────────────────────────────
function _cardFromBlock(inner, main) {
  var href = (inner.match(/<a[^>]+href=['"]([^'"]+)['"]/i) || [])[1];
  if (!href) return null;
  var url = _abs(href, main);
  if (!/\\/(movies|tvshows)\\//i.test(url)) return null;
  var title = _cleanTitle(
    (inner.match(/<img[^>]+alt=['"]([^'"]*)['"]/i) || [])[1] ||
    (inner.match(/<h3[^>]*>\\s*<a[^>]*>([\\s\\S]*?)<\\/a>/i) || [])[1] ||
    (inner.match(/class=['"]title['"][^>]*>\\s*<a[^>]*>([\\s\\S]*?)<\\/a>/i) || [])[1] || '');
  if (!title) return null;
  var img = (inner.match(/<img[^>]+(?:data-src|data-lazy-src|src)=['"]([^'"]+\\.(?:jpg|jpeg|png|webp)[^'"]*)['"]/i) || [])[1] || null;
  return {
    id: url, title: title, cover: (img && img.indexOf('http') === 0) ? img : null,
    url: url, type: 'movie', sourceId: SOURCE_ID
  };
}
// Archive / home grids use <article class="item ...">.
function _cards(html, main) {
  var out = [], seen = {}, m;
  var re = /<article[^>]*\\bitem\\b[^>]*>([\\s\\S]*?)<\\/article>/gi;
  while ((m = re.exec(html)) !== null) {
    var c = _cardFromBlock(m[1], main);
    if (c && !seen[c.url]) { seen[c.url] = 1; out.push(c); }
  }
  return out;
}
// Current /search?q= results render <article class="poster-card"> blocks with
// a poster-art anchor, aria-label title and TMDB poster.
function _searchCards(html, main) {
  var out = [], seen = {};
  var parts = html.split('<article class="poster-card"');
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = (c.match(/class="poster-art"[^>]*href="([^"]+)"/) ||
      c.match(/href="([^"]+)"[^>]*class="poster-art"/) || [])[1];
    if (!href) continue;
    var url = _abs(href, main);
    var title = _cleanTitle(
      (c.match(/aria-label="([^"]+)"/) || [])[1] ||
      (c.match(/class="poster-caption"[^>]*>[\\s\\S]*?<a[^>]*>([\\s\\S]*?)<\\/a>/) || [])[1] || '');
    if (!title) continue;
    var img = (c.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    if (seen[url]) continue;
    seen[url] = 1;
    out.push({
      id: url, title: title, cover: (img && img.indexOf('http') === 0) ? img : null,
      url: url, type: 'movie', sourceId: SOURCE_ID
    });
  }
  return out;
}

function getHome(opts) {
  var rows = [
    { title: 'Latest Movies', path: '/movies/' },
    { title: 'Latest TV Shows', path: '/tvshows/' },
    { title: 'Bollywood', path: '/genre/bollywood-movies/' },
    { title: 'Anime (Hindi)', path: '/genre/anime-hindi/' },
    { title: 'Action', path: '/genre/action/' },
    { title: 'Animation', path: '/genre/animation/' }
  ];
  return _main().then(function (main) {
    return Promise.all(rows.map(function (row) {
      return _get(main + row.path, main + '/').then(function (html) {
        return { title: row.title, items: _cards(html, main) };
      }).catch(function () { return { title: row.title, items: [] }; });
    }));
  }).catch(function () { return []; });
}

function search(query, page, opts) {
  return _main().then(function (main) {
    var u = main + '/search?q=' + encodeURIComponent(query || '');
    return _get(u, main + '/').then(function (html) { return _searchCards(html, main); });
  }).catch(function () { return []; });
}

// ── detail / episodes ─────────────────────────────────────────────────────────
// Current series pages render episode cards as
// <a href="/series/<slug>/season/<s>/episode/<e>">…</a> (cinejoy theme); the
// DooPlay numerando/episodiotitle markup is gone.
function _episodes(html, main) {
  var out = [], seen = {}, m;
  var re = /<a[^>]+href="([^"]*\\/series\\/[^"]+\\/season\\/(\\d+)\\/episode\\/(\\d+))"[^>]*>([\\s\\S]*?)<\\/a>/gi;
  while ((m = re.exec(html)) !== null) {
    var url = _abs(m[1], main);
    if (seen[url]) continue;
    seen[url] = 1;
    var s = parseInt(m[2], 10) || 1, e = parseInt(m[3], 10) || 0;
    var name = _trim(htmlText(m[4] || ''));
    var label = 'S' + s + ' E' + e + (name && !/^episode\\s*\\d+$/i.test(name) ? ' · ' + name : '');
    out.push({ id: 'S' + s + 'E' + e, season: s, number: e, title: label, url: url });
  }
  out.sort(function (a, b) {
    var as = a.id.match(/S(\\d+)E(\\d+)/), bs = b.id.match(/S(\\d+)E(\\d+)/);
    if (as && bs) { if (as[1] !== bs[1]) return as[1] - bs[1]; return as[2] - bs[2]; }
    return 0;
  });
  return out;
}

function getDetail(url, opts) {
  return _main().then(function (main) {
    var u = _abs(url, main);
    return _get(u, main + '/').then(function (html) {
      var isSeries = /\\/series\\//i.test(u) || /cinejoy-season-select/i.test(html);
      var ogTitle = (html.match(/og:title" content="([^"]+)"/) || [])[1] || '';
      var title = _cleanTitle(
        (html.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/) || [])[1] || ogTitle || 'Untitled');
      var poster = (html.match(/og:image" content="([^"]+)"/) || [])[1] || null;
      var description = _trim(htmlText((html.match(/og:description" content="([^"]+)"/) || [])[1] || ''));
      var year = ((ogTitle.match(/(19|20)\\d{2}/) || [])[0]) ||
        ((title.match(/(19|20)\\d{2}/) || [])[0]) || null;

      var genres = [], gm;
      var gre = /<a[^>]+href="\\/genre\\/[^"]+"[^>]*>([^<]+)<\\/a>/gi;
      while ((gm = gre.exec(html)) !== null) genres.push(_trim(htmlText(gm[1])));

      var base = {
        id: u, title: title, cover: poster,
        url: u, description: description, status: 'unknown', genres: genres, studios: [],
        type: 'movie', sourceId: SOURCE_ID, year: year, subCount: 0, dubCount: 0, episodes: []
      };

      if (isSeries) {
        var slug = (u.match(/\\/series\\/([^\\/]+)/) || [])[1] || '';
        var seasons = [], sm, sre = /<option value="(\\d+)"[^>]*>\\s*Season/gi;
        while ((sm = sre.exec(html)) !== null) seasons.push(parseInt(sm[1], 10));
        if (!seasons.length) seasons = [1];
        return Promise.all(seasons.map(function (sn) {
          return _get(main + '/series/' + slug + '/season/' + sn, main + '/')
            .then(function (h) { return _episodes(h, main); })
            .catch(function () { return []; });
        })).then(function (lists) {
          var eps = [], seen = {};
          for (var i = 0; i < lists.length; i++) {
            for (var k = 0; k < lists[i].length; k++) {
              var ep = lists[i][k];
              if (ep && ep.url && !seen[ep.url]) { seen[ep.url] = 1; eps.push(ep); }
            }
          }
          base.episodes = eps;
          base.subCount = eps.length;
          return base;
        });
      }

      base.episodes = [{ id: 'movie', number: 1, title: title, url: u }];
      base.subCount = 1;
      return base;
    });
  });
}

// Pull the imdb/tmdb id out of a player option's embed URL. Movies are keyed by
// imdb (tt…), series by tmdb (the GDMIRROR embed is /embed/tv/{tmdb}/…). Most of
// the other embeds carry a tt/tmdb id too, so we take whichever answers first
// rather than singling out GDMIRROR.
function _syncIds(playerHtml, isSeries, main) {
  // Not every option carries an id — series option 1 is usually a file locker
  // with an opaque slug — so keep asking until one does.
  var list = _playerOptions(playerHtml || '').slice(0, 6), i = 0;
  function next() {
    if (i >= list.length) return Promise.resolve({});
    return _dooAjax(main, list[i++]).then(function (embed) {
      var imdb = (embed.match(/(tt\\d{6,})/) || [])[1] || null;
      var tmdb = (embed.match(/\\/(?:tv|movie)\\/(\\d+)/) ||
        embed.match(/[?&](?:id|tmdb|tmdbid)=(\\d+)/i) || [])[1] || null;
      if (!imdb && !tmdb) return next();
      var res = {};
      if (isSeries) {
        res.tmdbIsTv = true;
        if (tmdb) res.tmdbId = parseInt(tmdb, 10);
        else res.imdbId = imdb;
      } else {
        if (imdb) res.imdbId = imdb;
        else res.tmdbId = parseInt(tmdb, 10);
      }
      return res;
    });
  }
  return next().catch(function () { return {}; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── video resolution (GDMIRROR / iqsmartgames chain) ──────────────────────────
function _playerOptions(html) {
  var out = [], m;
  var re = /<li[^>]*class=['"][^'"]*dooplay_player_option[^'"]*['"][^>]*>/gi;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var post = (tag.match(/data-post=['"](\\d+)/) || [])[1];
    var nume = (tag.match(/data-nume=['"]([^'"]+)/) || [])[1];
    var type = (tag.match(/data-type=['"]([^'"]+)/) || [])[1];
    // the trailer option is a YouTube embed — no stream, no id, and it's first
    // in the list, so leave it out rather than burning a lookup on it
    if (post && nume && type && nume !== 'trailer') {
      out.push({ post: post, nume: nume, type: type });
    }
  }
  return out;
}

function _dooAjax(main, o) {
  return fetch(main + '/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded', 'Referer': main + '/'
    },
    body: 'action=doo_player_ajax&post=' + encodeURIComponent(o.post) +
      '&nume=' + encodeURIComponent(o.nume) + '&type=' + encodeURIComponent(o.type)
  }).then(function (r) {
    var t = r.body || '', j = null; try { j = JSON.parse(t); } catch (e) {}
    var embed = String((j && j.embed_url) || t).replace(/\\\\\\//g, '/');
    return (embed.match(/SRC=["']([^"']+)/i) || embed.match(/src=["']([^"']+)/i) ||
      embed.match(/(https?:\\/\\/[^"'<> ]+)/) || [])[1] || '';
  }).catch(function () { return ''; });
}

// Find the GDMIRROR (iqsmartgames) embed among the player options.
function _findIq(main, opts) {
  var list = opts.slice(0, 6), i = 0;
  function next() {
    if (i >= list.length) return Promise.resolve('');
    return _dooAjax(main, list[i++]).then(function (src) {
      return (src && src.indexOf('iqsmartgames') !== -1) ? src : next();
    });
  }
  return next();
}

function _embedHelper(playerBase, slug) {
  return fetch(playerBase + '/embedhelper.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Referer': playerBase + '/', 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'sid=' + encodeURIComponent(slug)
  }).then(function (r) {
    var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
    return j;
  }).catch(function () { return null; });
}

function _src(url, quality, label, referer) {
  return {
    url: url, quality: quality || 'auto',
    container: /\\.m3u8(\\?|$)/i.test(url) ? 'hls' : 'mp4',
    headers: { 'User-Agent': UA, 'Referer': referer || '' },
    kind: 'sub', audioLang: '', subtitles: [], label: _trim(label || '')
  };
}

// A single-quoted JS string reader honoring \\' and \\\\ escapes. Returns the
// decoded string plus the index just past the closing quote.
function _readStr(s, i) {
  var out = ''; i++;
  while (i < s.length) {
    var c = s[i];
    if (c === '\\\\') { out += s[i + 1]; i += 2; continue; }
    if (c === "'") return { str: out, next: i + 1 };
    out += c; i++;
  }
  return { str: out, next: i };
}

// Robust Dean-Edwards p,a,c,k,e,d unpacker. The host's built-in unpackJs is
// rigid (it slices on a literal \`.split('|'),0,{}))\` tail and hardcodes base
// 62), which silently mis-decodes StreamHG/EarnVids — so we unpack here.
function _unpack(s) {
  s = String(s);
  var h = s.indexOf("}('");
  if (h < 0 || s.indexOf(".split('|')") < 0) return s;
  var p = _readStr(s, h + 2);             // payload (template)
  var rest = s.slice(p.next);             // ,BASE,COUNT,'DICT'.split('|')…
  var m = rest.match(/^,(\\d+),(\\d+),/);
  if (!m) return s;
  var base = parseInt(m[1], 10), count = parseInt(m[2], 10);
  var d = _readStr(s, p.next + m[0].length); // dictionary
  var dict = d.str.split('|');
  function enc(n) {
    return (n < base ? '' : enc(Math.floor(n / base))) +
      ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  }
  var out = p.str;
  while (count--) {
    if (dict[count]) out = out.replace(new RegExp('\\\\b' + enc(count) + '\\\\b', 'g'), dict[count]);
  }
  return out;
}

// StreamWish-family embed (StreamHG / EarnVids / etc.): packed JS -> master.m3u8.
function _resolveEmbed(embed, name, quality) {
  var ref = _baseOf(embed) + '/';
  return _get(embed, ref).then(function (html) {
    var unp = ''; try { unp = _unpack(html); } catch (e) {}
    var hay = html + ' ' + unp;
    var m3 = (hay.match(/https?:\\/\\/[^"'\\\\ ]+\\.m3u8[^"'\\\\ ]*/) || [])[0] ||
      (hay.match(/["']file["']\\s*:\\s*["']([^"']+\\.m3u8[^"']*)/i) || [])[1] ||
      (hay.match(/["']hls\\d?["']\\s*:\\s*["']([^"']+\\.m3u8[^"']*)/i) || [])[1];
    if (!m3) return [];
    return [_src(m3, quality, 'MultiMovies [' + (name || 'Server') + ']', ref)];
  }).catch(function () { return []; });
}

// embed page (iqsmartgames) inline var, e.g.  api_url  = "https://...".
function _embedVar(html, name) {
  var m = html.match(new RegExp(name + '\\\\s*=\\\\s*[\\'"]([^\\'"]*)[\\'"]'));
  return m ? m[1] : '';
}

function _iqChain(embedUrl, main) {
  return _get(embedUrl, main + '/').then(function (html) {
    var apiUrl = _embedVar(html, 'api_url') || _baseOf(embedUrl);
    var playerBase = _embedVar(html, 'player_base') ||
      _baseOf(embedUrl).replace('://streams.', '://pro.');
    var myKey = _embedVar(html, 'myKey');
    var finalId = _embedVar(html, 'FinalID');
    var idType = _embedVar(html, 'idType') || 'imdbid';
    var season = _embedVar(html, 'season');
    var isTv = /\\/embed\\/tv\\//i.test(embedUrl);
    var epname = '';

    var pm = embedUrl.match(/\\/embed\\/(?:movie|tv)\\/([^\\/?]+)(?:\\/(\\d+)\\/(\\d+))?/);
    if (!finalId && pm) finalId = pm[1];
    if (isTv && pm) { season = season || pm[2] || '1'; epname = pm[3] || '1'; }
    if (!finalId || !myKey) return [];

    var apiPath = isTv
      ? '/myseriesapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&season=' + encodeURIComponent(season || '1') +
        '&epname=' + encodeURIComponent(epname || '1') + '&key=' + encodeURIComponent(myKey)
      : '/mymovieapi?' + idType + '=' + encodeURIComponent(finalId) +
        '&key=' + encodeURIComponent(myKey);

    return _get(apiUrl + apiPath, apiUrl + '/').then(function (body) {
      var j = null; try { j = JSON.parse(body || 'null'); } catch (e) {}
      var data = (j && j.data) || [];
      if (!data.length) return [];
      var jobs = data.slice(0, 3).map(function (d) {
        var quality = _quality(d && d.filename) || 'auto';
        return _embedHelper(playerBase, d && d.fileslug).then(function (eh) {
          if (!eh || !eh.mresult) return [];
          var mr = _b64json(eh.mresult) || {};
          var su = eh.siteUrls || {}, names = eh.siteFriendlyNames || {};
          var embeds = [];
          Object.keys(mr).forEach(function (k) {
            if (su[k] && mr[k]) embeds.push({ url: su[k] + mr[k], name: names[k] || k });
          });
          return Promise.all(embeds.slice(0, 8).map(function (e) {
            return _resolveEmbed(e.url, e.name, quality);
          })).then(function (lists) {
            return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
          });
        }).catch(function () { return []; });
      });
      return Promise.all(jobs).then(function (lists) {
        return lists.reduce(function (a, b) { return a.concat(b || []); }, []);
      });
    });
  }).catch(function () { return []; });
}

// ── current cinejoy player chain ─────────────────────────────────────────────
// Server chips on the movie/episode page carry data-url embed pages. The old
// dooplay_player_option -> admin-ajax route is gone, so dispatch each embed
// host directly.
function _unescHtml(v) {
  return String(v || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function _serverUrls(html) {
  var out = [], seen = {}, m, re = /data-url="([^"]+)"/gi;
  while ((m = re.exec(html)) !== null) {
    var u = _unescHtml(m[1]);
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}
function _dedupe(list) {
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    if (x && x.url && !seen[x.url]) { seen[x.url] = 1; out.push(x); }
  }
  return out;
}

function _vidrift(url) {
  var base = _baseOf(url);
  return _get(url, base + '/').then(function (html) {
    var out = [], seen = {}, m, re = /"url"\\s*:\\s*"(\\/api\\/orion\\/[^"]+master\\.m3u8)"/gi;
    while ((m = re.exec(html)) !== null) {
      var abs = _abs(m[1], base);
      if (seen[abs]) continue;
      seen[abs] = 1;
      out.push(_src(abs, 'auto', 'MultiMovies [Vidrift]', base + '/'));
    }
    return out;
  }).catch(function () { return []; });
}

function _vidbolt(url) {
  var base = _baseOf(url);
  var mv = url.match(/\\/movie\\/(\\d+)/i);
  var tv = url.match(/\\/tv\\/(\\d+)\\/(\\d+)\\/(\\d+)/i);
  var q = tv ? ('type=tv&id=' + tv[1] + '&season=' + tv[2] + '&episode=' + tv[3])
    : (mv ? ('type=movie&id=' + mv[1]) : '');
  if (!q) return Promise.resolve([]);
  return fetch(base + '/api/resolve?' + q, { headers: { 'User-Agent': UA, 'Referer': url } })
    .then(function (r) {
      var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
      var list = (j && j.stream && j.stream.sources) || [], out = [];
      for (var i = 0; i < list.length; i++) {
        var src = list[i];
        if (!src || !src.url) continue;
        out.push(_src(src.url, src.quality || 'auto', 'MultiMovies [Vidbolt]', base + '/'));
      }
      return out;
    }).catch(function () { return []; });
}

function _vidout(url) {
  var base = _baseOf(url);
  var mv = url.match(/\\/movie\\/(\\d+)/i);
  var tv = url.match(/\\/tv\\/(\\d+)\\/s(\\d+)\\/e(\\d+)/i) || url.match(/\\/tv\\/(\\d+)\\/(\\d+)\\/(\\d+)/i);
  var raw = 'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/';
  if (mv) {
    return fetch(raw + 'movie/' + mv[1], { headers: { 'User-Agent': UA } }).then(function (r) {
      var t = _trim(r.body || '');
      var u = (t.match(/https?:\\/\\/[^\\s]+\\.m3u8[^\\s]*/) || [])[0];
      return u ? [_src(u, 'auto', 'MultiMovies [Vidout]', base + '/')] : [];
    }).catch(function () { return []; });
  }
  if (tv) {
    return fetch(raw + 'tv/' + tv[1] + '/S' + tv[2] + '.json', { headers: { 'User-Agent': UA } })
      .then(function (r) {
        var j = null; try { j = JSON.parse(r.body || 'null'); } catch (e) {}
        var u = j && j[tv[3]];
        return (u && /https?:/i.test(u)) ? [_src(u, 'auto', 'MultiMovies [Vidout]', base + '/')] : [];
      }).catch(function () { return []; });
  }
  return Promise.resolve([]);
}

function _modiplay(url) {
  var base = _baseOf(url);
  return _get(url, base + '/').then(function (html) {
    var urls = _serverUrls(html);
    return Promise.all(urls.slice(0, 6).map(function (x) { return _dispatchEmbed(x, 0); }))
      .then(function (lists) { return _dedupe(lists.reduce(function (a, b) { return a.concat(b || []); }, [])); });
  }).catch(function () { return []; });
}

function _proxyPage(url) {
  var base = _baseOf(url);
  return _get(url, base + '/').then(function (html) {
    var urls = _serverUrls(html);
    return Promise.all(urls.slice(0, 4).map(function (x) { return _dispatchEmbed(x, 1); }))
      .then(function (lists) { return _dedupe(lists.reduce(function (a, b) { return a.concat(b || []); }, [])); });
  }).catch(function () { return []; });
}

function _dispatchEmbed(url, depth) {
  var l = String(url || '').toLowerCase();
  if (l.indexOf('modiplay') !== -1) return _modiplay(url);
  if (l.indexOf('proxy.php') !== -1) return _proxyPage(url);
  if (l.indexOf('vidrift') !== -1) return _vidrift(url);
  if (l.indexOf('vidbolt') !== -1) return _vidbolt(url);
  if (l.indexOf('vidout') !== -1) return _vidout(url);
  if (l.indexOf('iqsmartgames') !== -1) return _iqChain(url, _baseOf(url));
  if (depth > 0) return Promise.resolve([]);
  return _resolveEmbed(url, 'Server', 'auto');
}

function getVideoSources(pageUrl) {
  return _main().then(function (main) {
    var u = _abs(pageUrl, main);
    return _get(u, main + '/').then(function (html) {
      var urls = _serverUrls(html);
      if (!urls.length) throw new Error('MultiMovies: no players');
      return Promise.all(urls.slice(0, 6).map(function (x) { return _dispatchEmbed(x, 0); }))
        .then(function (lists) { return _dedupe(lists.reduce(function (a, b) { return a.concat(b || []); }, [])); });
    });
  }).then(function (sources) {
    var out = _dedupe(sources || []);
    if (!out.length) throw new Error('MultiMovies: no playable sources');
    return out;
  });
}
`
  },
  {
    id: "animecube",
    name: "AnimeCube",
    kind: "anime",
    lang: "zh",
    rank: 1007,
    js: `// AnimeCube — Donghua (Chinese animation) source. Site: https://animecube.live
//
// Next.js App Router site: listings come from the server-rendered RSC payload
// (no clean list API) + the sitemap for search; episode streams come from a
// plaintext JSON API (\`/api/anime/<slug>/episode/<epSlug>/sources\`) that returns
// \`{platform, videoId, privateId}\` for Dailymotion (the primary host) / Rumble.
// Both resolve to a plain HLS m3u8: Dailymotion via its GEO endpoint with the
// animecube embedder + the privateId; Rumble via its embedJS API. Chinese audio
// + subs only — there is no dub on this site.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animecube';

var SITE = 'https://animecube.live';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'AnimeCube', lang: 'zh', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.5' };
}

function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || SITE + '/' } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    try { return JSON.parse(b); } catch (e) { return null; }
  });
}

// ── RSC helpers ──────────────────────────────────────────────────────────────
// The page data lives in \`self.__next_f.push([1,"<escaped>"])\` script chunks.
// Concatenate them and lightly un-escape so the embedded JSON can be regex-mined.
function _rsc(html) {
  var parts = [];
  var re = /self\\.__next_f\\.push\\(\\[1,"((?:\\\\.|[^"\\\\])*)"\\]\\)/g;
  var m;
  while ((m = re.exec(html)) !== null) parts.push(m[1]);
  var s = parts.join('');
  return s
    .replace(/\\\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\\\\\//g, '/')
    .replace(/\\\\n/g, '\\n')
    .replace(/\\\\"/g, '"')
    .replace(/\\\\\\\\/g, '\\\\');
}

function _field(obj, key) {
  var m = obj.match(new RegExp('"' + key + '":"((?:\\\\\\\\.|[^"\\\\\\\\])*)"'));
  return m ? m[1] : null;
}

// Pull every anime card object ({slug,title,coverImage,...}) out of an RSC blob.
function _cards(rsc) {
  var out = [];
  var seen = {};
  // Anime objects carry "slug" + "coverImage"; they contain only string/array
  // values (no nested objects), so a brace-balanced-free match is safe.
  var re = /\\{[^{}]*?"slug":"[a-z0-9\\-]+"[^{}]*?\\}/g;
  var m;
  while ((m = re.exec(rsc)) !== null) {
    var o = m[0];
    var slug = _field(o, 'slug');
    if (!slug || seen[slug] || !/coverImage|title/.test(o)) continue;
    seen[slug] = 1;
    var genres = [];
    var gm = o.match(/"genres":\\[([^\\]]*)\\]/);
    if (gm) genres = (gm[1].match(/"([^"]+)"/g) || []).map(function (x) { return x.replace(/"/g, ''); });
    var year = _field(o, 'year');
    var rm = o.match(/"rating":\\s*([0-9.]+)/);
    var um = o.match(/"(?:lastEpisodeAddedAt|latestEpisodePublishedAt|updatedAt)":"([^"]+)"/);
    out.push({
      id: slug, title: _field(o, 'title') || _titleFromSlug(slug),
      cover: _field(o, 'coverImage') || null, url: slug,
      type: 'anime', sourceId: SOURCE_ID,
      genres: genres, year: year ? parseInt(year, 10) : null,
      rating: rm ? parseFloat(rm[1]) : 0, updatedAt: um ? um[1] : '',
    });
  }
  return out;
}

function _titleFromSlug(s) {
  return String(s).replace(/-/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
}

// ── Listings ─────────────────────────────────────────────────────────────────
function getHome(opts) {
  return _get(SITE + '/').then(function (html) {
    var cards = _cards(_rsc(html));
    if (!cards.length) return [];
    // The app uses row[0] as the hero carousel, so a single row leaves no
    // content rows below it. Build a few rows from the catalog. The cards
    // carry rating + last-updated (ISO strings sort chronologically) for
    // ordering; we slice different sorts so the rows aren't identical.
    var updated = cards.slice().sort(function (a, b) {
      return (b.updatedAt || '') < (a.updatedAt || '') ? -1 : ((b.updatedAt || '') > (a.updatedAt || '') ? 1 : 0);
    });
    var rated = cards.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
    var rows = [
      { title: 'New Episodes', items: updated.slice(0, 24) },
      { title: 'Top Rated', items: rated.slice(0, 24) },
      { title: 'All Donghua', items: cards },
    ];
    return rows.filter(function (r) { return r.items.length; });
  }).catch(function () { return []; });
}

function popular(opts) {
  return getHome(opts).then(function (rows) {
    // Flatten all rows into a de-duped list for the "popular" surface.
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var items = rows[i].items;
      for (var j = 0; j < items.length; j++) {
        if (!seen[items[j].id]) { seen[items[j].id] = 1; out.push(items[j]); }
      }
    }
    return out;
  });
}

// Search: the site has no search API, but its sitemap lists every title (~50),
// so we fetch it once (cached) and substring-match the query against the slugs.
var _sitemap = null;
function _slugs() {
  if (_sitemap) return Promise.resolve(_sitemap);
  return _get(SITE + '/sitemap.xml').then(function (xml) {
    var slugs = [], seen = {}, re = /\\/anime\\/([a-z0-9\\-]+)/g, m;
    while ((m = re.exec(xml)) !== null) { if (!seen[m[1]]) { seen[m[1]] = 1; slugs.push(m[1]); } }
    _sitemap = slugs;
    return slugs;
  }).catch(function () { return []; });
}

function search(query, page, opts) {
  var q = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!q) return Promise.resolve([]);
  var toks = q.split(' ');
  return _slugs().then(function (slugs) {
    var hits = slugs.filter(function (s) {
      var hay = s.replace(/-/g, ' ');
      for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) === -1) return false;
      return true;
    });
    return hits.slice(0, 30).map(function (s) {
      return { id: s, title: _titleFromSlug(s), cover: null, url: s, type: 'anime', sourceId: SOURCE_ID };
    });
  });
}

// ── Detail + episodes ────────────────────────────────────────────────────────
function getDetail(url, opts) {
  var slug = String(url);
  return _get(SITE + '/anime/' + encodeURIComponent(slug)).then(function (html) {
    var rsc = _rsc(html);
    var card = null;
    var cards = _cards(rsc);
    for (var i = 0; i < cards.length; i++) if (cards[i].id === slug) { card = cards[i]; break; }
    card = card || {};

    // Episodes are \`<slug>-tab-<T>-ep-<N>\` slugs in the RSC. Collect uniques,
    // order by (tab, episode), and number them sequentially for the list.
    var seen = {}, eps = [];
    var re = new RegExp('"(' + slug.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '-tab-(\\\\d+)-ep-(\\\\d+))"', 'g');
    var m;
    while ((m = re.exec(rsc)) !== null) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      eps.push({ epSlug: m[1], tab: parseInt(m[2], 10), ep: parseInt(m[3], 10) });
    }
    eps.sort(function (a, b) { return a.tab - b.tab || a.ep - b.ep; });
    var episodes = [];
    for (var k = 0; k < eps.length; k++) {
      var n = k + 1;
      episodes.push({ id: eps[k].epSlug, number: n, title: 'Episode ' + n,
        url: 'animecube://' + slug + '|' + eps[k].epSlug });
    }

    return {
      id: slug, title: card.title || _titleFromSlug(slug), englishTitle: null,
      cover: card.cover || null, url: slug,
      description: 'Donghua (Chinese animation) — subbed.',
      status: 'unknown', genres: card.genres || [], studios: [], type: 'anime',
      sourceId: SOURCE_ID, year: card.year || null, malId: null,
      episodes: episodes, subCount: episodes.length, dubCount: 0,
    };
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── Streams ──────────────────────────────────────────────────────────────────
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animecube://', '');
  var cut = raw.indexOf('|');
  if (cut < 0) return Promise.reject(new Error('AnimeCube: bad episode url'));
  var slug = raw.slice(0, cut);
  var epSlug = raw.slice(cut + 1);
  var tm = epSlug.match(/-tab-(\\d+)-ep-(\\d+)/);
  if (!tm) return Promise.reject(new Error('AnimeCube: bad episode slug'));
  var seasonId = 'tab-' + tm[1];

  // The per-season \`v=\` token rotates; it lives in the (plaintext) versions map.
  return _json(SITE + '/api/anime-sources-versions', SITE + '/anime/' + slug).then(function (reg) {
    var by = (reg && reg.bySeason && reg.bySeason[slug]) || {};
    var primaryId = null, token = null;
    for (var p in by) { if (by[p] && by[p][seasonId]) { primaryId = p; token = by[p][seasonId]; break; } }
    if (!token) throw new Error('AnimeCube: no version token');
    var su = SITE + '/api/anime/' + slug + '/episode/' + epSlug + '/sources'
      + '?v=' + encodeURIComponent(token)
      + '&primaryTabId=' + encodeURIComponent(primaryId)
      + '&seasonId=' + encodeURIComponent(seasonId);
    return _json(su, SITE + '/anime/' + slug).then(function (j) {
      var list = (j && j.sources) || [];
      var jobs = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.platform) continue;
        if (s.platform === 'dailymotion' && (s.privateId || s.videoId)) {
          // Dailymotion videos are embed-restricted to animecube.live; the geo
          // endpoint serves the HLS manifest when the matching \`embedder\` is set.
          jobs.push(_dailymotion(s.privateId || s.videoId, s.quality, slug));
        } else if (s.platform === 'rumble' && s.videoId) {
          jobs.push(_rumble(s.videoId, s.quality));
        }
      }
      return Promise.all(jobs).then(function (arrs) {
        var out = [];
        for (var a = 0; a < arrs.length; a++) if (arrs[a] && arrs[a].length) out = out.concat(arrs[a]);
        if (!out.length) throw new Error('AnimeCube: no playable sources');
        return out;
      });
    });
  });
}

// Dailymotion: the site's primary host. Videos are restricted to the
// animecube.live embedder, so the public metadata API 403s (DM010); the GEO
// endpoint with the matching \`embedder\` returns the HLS manifest. Use the
// \`privateId\` (the embed key) as the video id.
function _dailymotion(privateId, quality, slug) {
  if (!privateId) return Promise.resolve([]);
  var u = 'https://geo.dailymotion.com/video/' + encodeURIComponent(privateId)
    + '.json?legacy=true&embedder=' + encodeURIComponent(SITE + '/anime/' + slug);
  var dmRef = 'https://geo.dailymotion.com/';
  var hdr = { 'User-Agent': UA, 'Referer': dmRef };
  return _json(u, dmRef).then(function (j) {
    if (!j || j.error) return [];
    var ql = j.qualities || {};
    var master = ql.auto && ql.auto[0] && ql.auto[0].url;
    if (!master) return [];
    // The player (libmpv) cannot open Dailymotion's MASTER playlist: it carries
    // a cross-host subtitle group (www.dailymotion.com) + fMP4 variants, and the
    // open fails ("Failed to open"). So we fetch the master ourselves and return
    // each variant's media playlist DIRECTLY — a single host, no subtitle group,
    // the clean shape mpv plays reliably.
    //
    // Return up to 1080p as separate quality options (default = highest = 1080p;
    // the user can drop to 720p/480p in the player's quality menu). NOTE: these
    // are fMP4 HLS — mpv seeks them by reading sequentially (Dailymotion offers
    // no progressive-MP4 or TS variant), so a long forward seek buffers a while;
    // higher quality = more data per seek. We skip 1440/2160 (would default to
    // 4K — needlessly heavy for donghua) but keep 1080p as the user asked.
    return _get(master, dmRef).then(function (m3u8) {
      var lines = String(m3u8 || '').split('\\n');
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var line = (lines[i] || '').trim();
        if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
        var nm = line.match(/NAME="?(\\d{3,4})"?/);
        var res = line.match(/RESOLUTION=\\d+x(\\d+)/);
        var q = nm ? nm[1] : (res ? res[1] : '');
        var h = q ? parseInt(q, 10) : 0;
        if (h && h > 1080) continue; // skip 1440/2160 (would default to a 4K rendition)
        var vurl = ((lines[i + 1] || '').trim()).split('#')[0]; // drop #cell=… frag
        if (!vurl || vurl.charAt(0) === '#') continue;
        out.push({ url: vurl, quality: (q ? q + 'p' : (quality || 'auto')),
          container: 'hls', headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
      }
      if (out.length) return out;
      // Master had no parseable variants — fall back to the master itself.
      return [{ url: master, quality: quality || 'auto', container: 'hls',
        headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] }];
    }).catch(function () {
      return [{ url: master, quality: quality || 'auto', container: 'hls',
        headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] }];
    });
  }).catch(function () { return []; });
}

function _rumble(videoId, quality) {
  var u = 'https://rumble.com/embedJS/u3/?request=video&ver=2&v=' + encodeURIComponent(videoId);
  return _json(u, SITE + '/').then(function (j) {
    var ua = (j && j.ua) || {};
    var out = [];
    var hdr = { 'User-Agent': UA, 'Referer': 'https://rumble.com/' };
    var hls = ua.hls && ua.hls.auto && ua.hls.auto.url;
    if (hls) out.push({ url: hls, quality: quality || 'auto', container: 'hls',
      headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
    // Progressive mp4 renditions as a fallback / explicit qualities.
    var mp4 = ua.mp4 || {};
    for (var q in mp4) {
      var mu = mp4[q] && mp4[q].url;
      if (mu) out.push({ url: mu, quality: (/^\\d+$/.test(q) ? q + 'p' : q), container: 'mp4',
        headers: hdr, kind: 'sub', audioLang: 'zh', subtitles: [] });
    }
    return out;
  }).catch(function () { return []; });
}
`
  },
  {
    id: "kartoons",
    name: "Kartoons",
    kind: "anime",
    lang: "en",
    rank: 1008,
    js: `// Kartoons (kartoons.to) — cartoons + anime, shows and movies.
// JSON API, no scraping. Browse is public, playback needs a token
// (site Profile -> Stremio tab -> token from the Manifest URL).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'kartoons';

var SITE = 'https://kartoons.to';
var APIS = ['https://api.kartoons.to', 'https://api.kartoons.me'];
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'Kartoons', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.2' };
}

function getSettings() {
  return [
    { key: 'token', label: 'API token (site Profile → Stremio tab → copy token)', type: 'text', default: '' },
    { key: 'audioLang', label: 'Preferred audio', type: 'enum', default: 'hin',
      options: [
        { value: 'hin', label: 'Hindi' },
        { value: 'tam', label: 'Tamil' },
        { value: 'tel', label: 'Telugu' },
        { value: 'eng', label: 'English' }
      ] }
  ];
}

function _trim(s) { return String(s == null ? '' : s).replace(/^\\s+|\\s+$/g, ''); }
function _quality(s) { var m = String(s || '').match(/(\\d{3,4})[pP]/); return m ? (m[1] + 'p') : null; }

function _settings() {
  try {
    var bag = (typeof __settings !== 'undefined' && __settings) ? __settings : {};
    return bag[SOURCE_ID] || {};
  } catch (e) { return {}; }
}

// Accept the bare token or a pasted manifest URL.
function _token() {
  var raw = _trim(_settings().token || '');
  if (!raw) return '';
  if (raw.indexOf('token=') !== -1) raw = raw.split('token=')[1].split('&')[0];
  return _trim(raw);
}

function _audio() {
  var a = _trim(_settings().audioLang || 'hin').toLowerCase();
  if (a === 'tam' || a === 'tel' || a === 'eng') return a;
  return 'hin';
}

function _audioName(code) {
  if (code === 'tam') return 'Tamil';
  if (code === 'tel') return 'Telugu';
  if (code === 'eng') return 'English';
  return 'Hindi';
}

var _SUB_NAMES = { eng: 'English', hin: 'Hindi', tam: 'Tamil', tel: 'Telugu',
  jpn: 'Japanese', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali', mar: 'Marathi' };
function _subName(code) {
  var c = _trim(code).toLowerCase();
  if (_SUB_NAMES[c]) return _SUB_NAMES[c];
  if (!c) return 'Unknown';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function _url(base, path) {
  var t = _token();
  var sep = path.indexOf('?') !== -1 ? '&' : '?';
  return base + '/api/cloudstream/' + path + (t ? sep + 'token=' + encodeURIComponent(t) : '');
}

// Try mirrors in order. Only network failures fall through,
// a real { success: false } answer is passed back.
function _j(path) {
  function attempt(i) {
    if (i >= APIS.length) return Promise.resolve(null);
    return fetch(_url(APIS[i], path), {
      headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE },
      timeoutMs: 12000
    }).then(function (r) {
      try { return JSON.parse(r.body || 'null'); } catch (e) { return null; }
    }).catch(function () { return null; })
    .then(function (j) { return j ? j : attempt(i + 1); });
  }
  return attempt(0);
}

function _card(it) {
  if (!it || !it.id || !it.title) return null;
  var kind = (it.type === 'movie') ? 'movie' : 'show';
  var url = '/' + kind + '/' + it.id;
  return { id: url, title: _trim(it.title), cover: it.image || null,
    url: url, type: 'anime', sourceId: SOURCE_ID };
}

function _cards(data) {
  var out = [];
  for (var i = 0; i < (data || []).length; i++) {
    var c = _card(data[i]);
    if (c) out.push(c);
  }
  return out;
}

function search(query, page, opts) {
  var q = _trim(query);
  if (!q) return Promise.resolve([]);
  return _j('search?q=' + encodeURIComponent(q) + '&page=' + (page || 1) + '&limit=20')
    .then(function (j) { return _cards(j && j.success && j.data); })
    .catch(function () { return []; });
}

function getHome(opts) {
  var rows = [
    { title: 'Popular Shows', path: 'catalog/show?catalog=popular' },
    { title: 'Trending Shows', path: 'catalog/show?catalog=trending' },
    { title: 'Popular Movies', path: 'catalog/movie?catalog=popular' },
    { title: 'Latest Shows', path: 'catalog/show?catalog=latest' },
    { title: 'Latest Movies', path: 'catalog/movie?catalog=latest' }
  ];
  return Promise.all(rows.map(function (row) {
    return _j(row.path + '&page=1&limit=20').then(function (j) {
      return { title: row.title, items: _cards(j && j.success && j.data) };
    }).catch(function () { return { title: row.title, items: [] }; });
  })).catch(function () { return []; });
}

function _parseUrl(url) {
  var m = String(url || '').match(/\\/(show|movie)\\/([^/?#]+)(?:\\/season\\/([^/?#]+))?/);
  if (!m) return null;
  return { kind: m[1], id: m[2], season: m[3] || null };
}

function _ep(showId, seasonSlug, seasonNum, ep, n) {
  var num = (ep.episodeNumber != null) ? ep.episodeNumber : n;
  var t = _trim(ep.title);
  return { id: 'S' + seasonNum + 'E' + num, number: n,
    title: 'S' + seasonNum + ' E' + num + (t ? ' - ' + t : ''),
    url: 'kartoons://show/' + showId + '/' + seasonSlug + '/' + (ep._id || ep.id),
    thumbnail: ep.image || null };
}

function _baseDetail(url, data, episodes) {
  var y = data.releaseYear || data.startYear || null;
  return {
    id: url, title: _trim(data.title) || 'Untitled',
    cover: data.image || data.coverImage || null, url: url,
    description: _trim(data.description), status: data.status || 'unknown',
    genres: (data.tags || []).slice(0, 8), studios: [], type: 'anime',
    sourceId: SOURCE_ID, episodes: episodes,
    year: (y == null) ? null : String(y), malId: null,
    subCount: episodes.length, dubCount: 0
  };
}

function getDetail(url, opts) {
  var key = String(url);
  var hit = _detailCache[key];
  var now = Date.now();
  if (hit && (now - hit.at) < _DETAIL_TTL) return Promise.resolve(hit.value);
  return _fetchDetail(url, opts).then(function (d) {
    if (d && d.episodes && d.episodes.length) {
      _detailCache[key] = { at: Date.now(), value: d };
    }
    return d;
  });
}

// Detail screen hits this a lot — cache 5 min.
var _detailCache = {};
var _DETAIL_TTL = 300000;

function _fetchDetail(url, opts) {
  var p = _parseUrl(url);
  if (!p) return Promise.resolve(null);
  if (p.kind === 'movie') return _movieDetail('/movie/' + p.id, p.id);
  return _showDetail('/show/' + p.id, p.id, p.season);
}

function _movieDetail(url, id) {
  return _j('movie/' + encodeURIComponent(id)).then(function (j) {
    var data = (j && j.success && j.data) || {};
    var episodes = [{ id: 'movie', number: 1, title: _trim(data.title) || 'Movie',
      url: 'kartoons://movie/' + id }];
    return _baseDetail(url, data, episodes);
  }).catch(function () { return null; });
}

function _showDetail(url, id, onlySeason) {
  return _j('show/' + encodeURIComponent(id)).then(function (j) {
    var data = (j && j.success && j.data) || {};
    var seasons = data.seasons || [];
    if (onlySeason) seasons = seasons.filter(function (s) { return s.slug === onlySeason; });
    if (!seasons.length) return _baseDetail(url, data, []);
    return Promise.all(seasons.map(function (s) {
      var slug = s.slug || ('season-' + (s.seasonNumber || 0));
      var num = (s.seasonNumber != null) ? s.seasonNumber : 1;
      return _j('show/' + encodeURIComponent(id) + '/season/' + encodeURIComponent(slug) + '/episodes')
        .then(function (ej) {
          return { slug: slug, num: num, eps: (ej && ej.success && ej.data) || [] };
        }).catch(function () { return { slug: slug, num: num, eps: [] }; });
    })).then(function (groups) {
      var out = [], n = 1;
      for (var i = 0; i < groups.length; i++) {
        for (var k = 0; k < groups[i].eps.length; k++) {
          var ep = groups[i].eps[k];
          if (ep && (ep._id || ep.id)) out.push(_ep(id, groups[i].slug, groups[i].num, ep, n++));
        }
      }
      return _baseDetail(url, data, out);
    });
  }).catch(function () { return null; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return (d && d.episodes) || []; });
}

function _audioOf(name) {
  var s = String(name || '').toLowerCase();
  if (/english|\\beng\\b/.test(s)) return { kind: 'sub', audioLang: 'en' };
  if (/hindi|\\bhin\\b/.test(s)) return { kind: 'dub', audioLang: 'hi' };
  if (/tamil|\\btam\\b/.test(s)) return { kind: 'dub', audioLang: 'ta' };
  if (/telugu|\\btel\\b/.test(s)) return { kind: 'dub', audioLang: 'te' };
  var p = _audio();
  return { kind: p === 'eng' ? 'sub' : 'dub',
    audioLang: p === 'eng' ? 'en' : p === 'tam' ? 'ta' : p === 'tel' ? 'te' : 'hi' };
}

function getVideoSources(episodeUrl) {
  var m = String(episodeUrl || '').match(/^kartoons:\\/\\/(movie|show)\\/(.+)$/);
  if (!m) return Promise.reject(new Error('Kartoons: bad episode url'));
  if (!_token()) {
    return Promise.reject(new Error(
      'Kartoons: set your API token in source settings (kartoons.to → Profile → Stremio tab)'));
  }
  var path;
  if (m[1] === 'movie') {
    path = 'movie/' + m[2].split('/')[0] + '/links';
  } else {
    var parts = m[2].split('/');
    path = 'episode/' + parts[parts.length - 1] + '/links';
  }
  return _j(path).then(function (j) {
    if (!j || !j.success || !j.data) {
      throw new Error('Kartoons: ' + ((j && (j.message || j.error)) || 'no links'));
    }
    var subs = [], i, t;
    var rawSubs = j.data.subtitles || [];
    for (i = 0; i < rawSubs.length; i++) {
      t = rawSubs[i];
      if (!t || !t.url) continue;
      var lang = _subName(t.lang);
      subs.push({ url: t.url, lang: lang, label: lang,
        format: /\\.srt(\\?|$)/i.test(t.url) ? 'srt' : 'vtt' });
    }
    // Preferred audio first.
    var pref = _audioName(_audio());
    var codeRe = new RegExp('(^|[^a-z])' + _audio() + '([^a-z]|$)', 'i');
    var links = (j.data.links || []).slice();
    links.sort(function (a, b) {
      function score(l) {
        var n = (l && l.name) || '';
        if (n.toLowerCase().indexOf(pref.toLowerCase()) !== -1) return 2;
        if (codeRe.test(n)) return 2;
        return 1;
      }
      return score(b) - score(a);
    });
    var out = [], seen = {};
    var hdrs = { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE };
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      if (!l || !l.url || seen[l.url]) continue;
      seen[l.url] = 1;
      var hls = /\\.m3u8(\\?|$)/i.test(l.url);
      var ao = _audioOf(l.name);
      out.push({ url: l.url, quality: _quality(l.name) || 'auto', label: _trim(l.name) || 'Kartoons',
        container: hls ? 'hls' : 'mp4', headers: hdrs,
        kind: ao.kind, audioLang: ao.audioLang, subtitles: subs });
    }
    if (!out.length) throw new Error('Kartoons: no playable links');
    return out;
  });
}
`
  },
  {
    id: "animesuge",
    name: "AnimeSuge",
    kind: "anime",
    lang: "en",
    rank: 1009,
    js: `// AnimeSuge — anime source for the Zangetsu provider repo (animesuge.cz).
//
// animesuge.cz shares the same two-step server chain as anikototv.to:
//   /filter?keyword=            -> anime slug
//   /anime/<slug>               -> anime id (data-id) + metadata
//   /ajax/episode/list/<id>     -> [{ data-id, title, slug(num), sub, dub, data-ids }]
//   /ajax/server/list?servers=<data-ids> -> server list (VidPlay/Vidstream/HD)
//   /ajax/server?get=<link_id>  -> { url: <player embed>, skip_data }
//   <embed host>/stream/getSources(New)?id=<embed data-id>&type=<cut> -> enc blob
//
// MegaPlay/VidPlay encrypt their payload into \`enc\` (AES-256-CBC), so we decrypt
// with the player's own TRUST_AES_KEY/IV and pull {"file":"…master.m3u8"} out of
// it, then carry the caption tracks alongside the HLS master.
//
// Home = hero swiper + the four server-rendered grids (Latest Episode, Most
// Viewed, New Releases, Completed); slugs are shared with the site, so cards
// resolve through getDetail.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animesuge';

var SITE = 'https://animesuge.cz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Embed hosts that hand back sources (plain or AES \`enc\`).
var PLAYER_RE = /^https?:\\/\\/(?:[a-z0-9-]+\\.)?(?:vidtube\\.[a-z]+|megaplay\\.[a-z]+|vidwish\\.[a-z]+)/i;
// Extra servers the episode's own list doesn't offer, keyed <mal>/<ep>/<ts>.
var MAPPER = 'https://mapper.nekostream.site/api/mal/';

function getInfo() {
  return { name: 'AnimeSuge', lang: 'en', baseUrl: SITE,
    logo: SITE + '/animesuge/images/favicon.png', type: 'anime', version: '1.0.0' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. \`xhr\` sets the ajax header the /ajax routes expect.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  });
}
// The site's /ajax routes wrap their payload in { status, result }.
function _ajax(path) {
  return _get(SITE + path, SITE + '/', true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  }).catch(function () { return null; });
}

function _slug(href) {
  var m = String(href || '').match(/\\/anime\\/([^/"?#]+)/);
  return m ? m[1] : null;
}
function _year(s) { var m = String(s || '').match(/(19|20)\\d{2}/); return m ? m[0] : null; }

// ── Search: scrape /filter?keyword= result cards ────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/filter?keyword=' + encodeURIComponent(q) + '&page=' + (page || 1);
  return _get(url, SITE + '/').then(function (html) {
    var out = [], seen = {}, chunks = html.split('<div class="item');
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i];
      var slug = _slug((c.match(/href="([^"]*\\/anime\\/[^"]+)"/) || [])[1]);
      if (!slug || seen[slug]) continue;
      var title = (c.match(/data-jp="([^"]+)"/) || [])[1]
        || (c.match(/class="name"[^>]*>\\s*([\\s\\S]*?)<\\/a>/) || [])[1];
      var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
      if (!title) continue;
      seen[slug] = 1;
      out.push({ id: slug, title: htmlText(title).trim(), url: slug,
        cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
    }
    return out;
  }).catch(function () { return []; });
}

// ── Home: hero swiper + section grids ───────────────────────────────────────
function _heroCards(html) {
  var out = [], seen = {}, chunks = String(html || '').split('swiper-slide');
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var href = (c.match(/href="([^"]*\\/anime\\/[^"]+)"/) || [])[1];
    var slug = _slug(href);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/title="([^"]+)"/) || [])[1];
    var img = (c.match(/background-image:\\s*url\\(\\s*['"]?([^'")]+)/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: img || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
function _cards(seg) {
  var out = [], seen = {}, chunks = String(seg || '').split('<div class="item');
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var slug = _slug((c.match(/href="([^"]*\\/anime\\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/data-jp="([^"]+)"/) || [])[1]
      || (c.match(/class="name"[^>]*>\\s*([\\s\\S]*?)<\\/a>/) || [])[1];
    var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
function getHome(opts) {
  return _get(SITE + '/', SITE + '/').then(function (html) {
    var rows = [];
    var hero = _heroCards(html);
    if (hero.length) rows.push({ title: 'Featured', items: hero });
    var marks = [], re = /<h2[^>]*>([^<]+)<\\/h2>/g, m;
    while ((m = re.exec(html)) !== null) marks.push({ name: htmlText(m[1]).trim(), at: m.index });
    for (var j = 0; j < marks.length; j++) {
      var end = (j + 1 < marks.length) ? marks[j + 1].at : html.length;
      var items = _cards(html.substring(marks[j].at, end));
      if (items.length) rows.push({ title: marks[j].name, items: items });
    }
    return rows;
  }).catch(function () { return []; });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _cleanTitle(og) {
  var t = String(og || '');
  t = t.replace(/\\s*[–|-]\\s*Watch Anime.*$/i, '');
  t = t.replace(/\\s*\\|\\s*AnimeSuge.*$/i, '');
  return t.trim();
}
function _epUrl(cat, serverIds, sub, dub, num, token) {
  return 'animesuge://' + cat + '/' + encodeURIComponent(serverIds) + '/'
    + (sub ? 1 : 0) + (dub ? 1 : 0) + '/' + num
    + (token ? '/' + token : '');
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _get(SITE + '/anime/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var animeId = (html.match(/data-id="(\\d+)"/) || [])[1];
    var title = htmlText((html.match(/<h1[^>]*itemprop="name"[^>]*>([\\s\\S]*?)<\\/h1>/) || [])[1] || '').trim()
      || htmlText((html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\\s\\S]*?)<\\/h1>/) || [])[1] || '').trim()
      || _cleanTitle((html.match(/og:title"\\s+content="([^"]+)"/) || [])[1]) || slug;
    var poster = (html.match(/og:image"\\s+content="([^"]+)"/) || [])[1] || null;
    var synopsis = (html.match(/class="short cts-block"[^>]*>([\\s\\S]*?)<\\/div>/) || [])[1] || '';
    var base = {
      id: slug, title: title, url: slug, cover: poster,
      description: htmlText(synopsis).trim(), status: 'unknown',
      genres: [], studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(html), malId: null, subCount: 0, dubCount: 0
    };
    if (!animeId) return base;
    return _ajax('/ajax/episode/list/' + animeId).then(function (j) {
      var lhtml = (j && typeof j.result === 'string') ? j.result : '';
      var out = [], subN = 0, dubN = 0, mal = null;
      var re = /<a\\b([^>]*\\bdata-num="[^"]*"[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var serverIds = (attrs.match(/data-ids="([^"]+)"/) || [])[1];
        if (!serverIds) continue;
        var num = parseInt((attrs.match(/data-slug="(\\d+)"/) || [])[1] || '0', 10);
        var sub = (attrs.match(/data-sub="(\\d+)"/) || [])[1] === '1';
        var dub = (attrs.match(/data-dub="(\\d+)"/) || [])[1] === '1';
        if (!sub && !dub) continue;
        var epMal = (attrs.match(/data-mal="(\\d+)"/) || [])[1];
        var epSlug = (attrs.match(/data-slug="([^"]+)"/) || [])[1];
        var epTs = (attrs.match(/data-timestamp="(\\d+)"/) || [])[1];
        var token = (epMal && epSlug && epTs)
          ? (epMal + '/' + encodeURIComponent(epSlug) + '/' + epTs) : null;
        if (!mal) mal = epMal || null;
        if (sub) subN++;
        if (dub) dubN++;
        var initCat = (cat === 'dub' && dub) || (cat === 'sub' && !sub && dub) ? 'dub' : 'sub';
        var title2 = (attrs.match(/title="([^"]+)"/) || [])[1];
        out.push({ id: cat + ':' + num, number: num,
          title: title2 ? htmlText(title2).trim() : ('Episode ' + num),
          url: _epUrl(initCat, serverIds, sub, dub, num, token) });
      }
      base.episodes = out;
      base.subCount = subN;
      base.dubCount = dubN;
      base.malId = mal ? parseInt(mal, 10) : null;
      return base;
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server_ids → server list → server?get → embed getSources(New) ───
function _parseServers(html) {
  var servers = [], re = /data-type="(\\w+)"([\\s\\S]*?)(?=data-type="|$)/g, tm;
  while ((tm = re.exec(html)) !== null) {
    var type = tm[1], block = tm[2], lm, lre = /data-link-id="([^"]+)"[\\s\\S]*?<span>([^<]*)<\\/span>/g;
    while ((lm = lre.exec(block)) !== null) {
      servers.push({ type: type, linkId: lm[1], name: (lm[2] || '').trim() });
    }
  }
  return servers;
}
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidplay') > -1) return 0;
  if (n.indexOf('vidstream') > -1) return 1;
  if (n.indexOf('hd') > -1) return 2;
  if (n.indexOf('vidcloud') > -1) return 3;
  return 5;
}

function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('animesuge://', '');
  var parts = raw.split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var serverIds = parts[1] ? decodeURIComponent(parts[1]) : '';
  var token = (parts[4] && parts[5] && parts[6])
    ? (parts[4] + '/' + parts[5] + '/' + parts[6]) : null;
  if (!serverIds) return Promise.reject(new Error('AnimeSuge: no server ids'));

  return _ajax('/ajax/server/list?servers=' + encodeURIComponent(serverIds)).then(function (j) {
    var lhtml = (j && typeof j.result === 'string') ? j.result : '';
    var servers = _parseServers(lhtml);
    var want = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var ok = (cat === 'dub') ? (s.type === 'dub') : (s.type === 'sub' || s.type === 'hsub');
      if (ok) want.push(s);
    }
    if (!want.length) want = servers;
    want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
    return _tryServers(want, 0, cat);
  }).catch(function (err) {
    return _mapperServers(token, cat, err);
  });
}

function _mapperServers(token, cat, err) {
  if (!token) throw err;
  return _json(MAPPER + token, SITE + '/').then(function (j) {
    var extra = [];
    for (var name in j) {
      var e = j[name];
      if (name === 'status' || !e || typeof e !== 'object') continue;
      var bucket = e[cat];
      if (bucket && bucket.url) {
        extra.push({ type: cat, linkId: String(bucket.url), name: name });
      }
    }
    if (!extra.length) throw err;
    return _tryServers(extra, 0, cat);
  }).catch(function () { throw err; });
}

function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('AnimeSuge: no playable server'));
  return _ajax('/ajax/server?get=' + encodeURIComponent(list[i].linkId)).then(function (j) {
    var url = j && j.result && (typeof j.result === 'object' ? j.result.url : null);
    if (url && PLAYER_RE.test(url)) return _extractPlayer(url, cat);
    return _tryServers(list, i + 1, cat);
  }).catch(function () { return _tryServers(list, i + 1, cat); });
}

// The sub/hsub/dub cut an embed URL was issued for.
function _cutOf(embed) {
  return (String(embed || '').match(/\\/(sub|hsub|dub)\\/?(?:[?#]|$)/i) || [])[1] || null;
}
// Carry the embed's query (MegaPlay needs \`s=\` on getSources or it 403s).
function _queryOf(url) {
  var i = String(url || '').indexOf('?');
  return i >= 0 ? String(url).substring(i + 1) : '';
}

function _extractPlayer(embed, cat) {
  var base = (embed.match(/^(https?:\\/\\/[^/]+)/) || [])[1] || 'https://vidtube.site';
  var type = _cutOf(embed) || cat;
  var q = _queryOf(embed);
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\\d+)"/) || [])[1];
    if (!dataId) throw new Error('AnimeSuge: no embed id');
    var path = /(?:megaplay|vidwish)\\.[a-z]+/i.test(String(base))
      ? '/stream/getSourcesNew' : '/stream/getSources';
    var srcUrl = base + path + '?id=' + dataId + '&type=' + type + (q ? '&' + q : '');
    return fetch(srcUrl, {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AnimeSuge: bad getSources'); }
      var file = _fileFromSources(j);
      if (!file) throw new Error('AnimeSuge: no stream file');
      var subs = [];
      var tracks = (j && j.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
          format: /\\.srt(\\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
      }
      var hdrs = { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base };
      return [{ url: file, quality: 'auto',
        container: /\\.m3u8(\\?|$)/i.test(file) ? 'hls' : 'mp4',
        headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs }];
    });
  });
}

// ── MegaPlay/VidPlay AES-256-CBC (sandbox bridges CTR only) ─────────────────
// Byte-for-byte match of megaplay newclient decrypt against a live getSources
// \`enc\` → {"file":"…master.m3u8"}. Tables/ops mirror providers/anikoto.js.
var MEGA_AES_KEY = 'i?LMTAx0Q6,:}50U';
var MEGA_AES_IV = "W0;27ToaUpl_P%'c";

function _padBytes(s, n) {
  var out = [], i;
  for (i = 0; i < n; i++) out[i] = 0;
  var b = String(s || '');
  for (i = 0; i < b.length && i < n; i++) out[i] = b.charCodeAt(i) & 0xff;
  return out;
}
function _b64urlBytes(s) {
  var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  var pad = (4 - (t.length % 4)) % 4;
  while (pad--) t += '=';
  try { return base64ToBytes(t); } catch (e) { return []; }
}
// Plain sources.file when present; otherwise AES-CBC-decrypt \`enc\` → {file}.
function _fileFromSources(j) {
  var s = j && j.sources;
  var file = s ? (s.file || (s[0] && s[0].file)) : null;
  if (file) return file;
  if (!j || !j.enc) return null;
  try {
    var ct = _b64urlBytes(j.enc);
    if (!ct.length || ct.length % 16 !== 0) return null;
    var pt = _bytesToStr(_aesCbcDecrypt(ct, _padBytes(MEGA_AES_KEY, 32), _padBytes(MEGA_AES_IV, 16)));
    var o = JSON.parse(pt);
    if (!o) return null;
    if (o.file) return o.file;
    s = o.sources;
    return s ? (s.file || (s[0] && s[0].file)) : null;
  } catch (e) { return null; }
}

var _SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var _ISBOX=[0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
function _xtime(a){a<<=1;if(a&0x100)a^=0x11b;return a&0xff;}
function _gmul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
function _keyExp(key){
  var Nk=key.length/4,Nr=Nk+6,w=[],i;
  for(i=0;i<Nk;i++)w.push([key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]]);
  var rcon=1;
  for(i=Nk;i<4*(Nr+1);i++){
    var t=w[i-1].slice();
    if(i%Nk===0){t=[t[1],t[2],t[3],t[0]];t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];t[0]^=rcon;rcon=_xtime(rcon);}
    else if(Nk>6&&i%Nk===4){t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];}
    w.push([w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]]);
  }
  return {w:w,Nr:Nr};
}
function _invCipher(inb,ks){
  var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],r,c,i;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inb[i];
  function ark(round){for(c=0;c<4;c++)for(r=0;r<4;r++)s[r][c]^=w[round*4+c][r];}
  function isub(){for(r=0;r<4;r++)for(c=0;c<4;c++)s[r][c]=_ISBOX[s[r][c]];}
  function ishift(){for(r=1;r<4;r++){var row=s[r].slice();for(c=0;c<4;c++)s[r][c]=row[(c-r+4)%4];}}
  function imix(){for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
    s[0][c]=_gmul(a0,14)^_gmul(a1,11)^_gmul(a2,13)^_gmul(a3,9);
    s[1][c]=_gmul(a0,9)^_gmul(a1,14)^_gmul(a2,11)^_gmul(a3,13);
    s[2][c]=_gmul(a0,13)^_gmul(a1,9)^_gmul(a2,14)^_gmul(a3,11);
    s[3][c]=_gmul(a0,11)^_gmul(a1,13)^_gmul(a2,9)^_gmul(a3,14);}}
  ark(Nr);
  for(var round=Nr-1;round>=1;round--){ishift();isub();ark(round);imix();}
  ishift();isub();ark(0);
  var out=[];for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;
}
function _aesCbcDecrypt(ct,key,iv){
  var ks=_keyExp(key),out=[],prev=iv.slice(),off,i;
  for(off=0;off+16<=ct.length;off+=16){
    var block=ct.slice(off,off+16),dec=_invCipher(block,ks);
    for(i=0;i<16;i++)out.push(dec[i]^prev[i]);
    prev=block;
  }
  var pad=out[out.length-1];
  if(pad>0&&pad<=16)out=out.slice(0,out.length-pad);
  return out;
}
function _bytesToStr(b){var s='',i=0;while(i<b.length){var c=b[i++];if(c<0x80)s+=String.fromCharCode(c);else if(c<0xE0)s+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f));else if(c<0xF0)s+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f));else{var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f);cp-=0x10000;s+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF));}}return s;}
`
  }
];
const zangetsuSourcerers = ZANGETSU_SOURCES.map(makeZangetsuSourcerer);
const AnimekaiScraper = makeEmbed({
  id: "animekai-embed",
  name: "AnimeKai",
  rank: 415,
  flags: [],
  async scrape(ctx) {
    var _a;
    const { episodeId } = JSON.parse(ctx.url);
    const data = await ctx.fetcher(
      `https://api.1anime.app/anime/animekai/watch/${encodeURIComponent(episodeId)}`
    );
    if (!((_a = data == null ? void 0 : data.sources) == null ? void 0 : _a.length)) throw new NotFoundError("No stream found");
    ctx.progress(50);
    const captions = (data.subtitles ?? []).filter((sub) => sub.lang && sub.kind !== "thumbnails").map((sub) => ({
      type: "vtt",
      id: sub.url,
      url: sub.url,
      language: labelToLanguageCode(sub.lang.replace(/_\[.*?\]$/, "").trim()) || "unknown",
      hasCorsRestrictions: true
    }));
    const hlsSource = data.sources.find((s) => s.isM3U8);
    if (!hlsSource) throw new NotFoundError("No HLS stream found");
    ctx.progress(90);
    const headers2 = {};
    if (data.headers.Referer) {
      headers2.Referer = data.headers.Referer;
      try {
        headers2.Origin = new URL(data.headers.Referer).origin;
      } catch {
      }
    }
    if (data.headers.Origin) headers2.Origin = data.headers.Origin;
    return {
      stream: [
        {
          id: "primary",
          captions,
          playlist: hlsSource.url,
          headers: headers2,
          type: "hls",
          flags: []
        }
      ]
    };
  }
});
const consumetBase = "https://api.1anime.app/anime/animekai";
function normalizeTitle$6(s) {
  return s.normalize("NFD").replace(new RegExp("\\p{Diacritic}", "gu"), "").toLowerCase();
}
async function searchAnime(ctx, title) {
  var _a;
  const data = await ctx.fetcher(`${consumetBase}/${encodeURIComponent(title)}`);
  if (!((_a = data == null ? void 0 : data.results) == null ? void 0 : _a.length)) throw new NotFoundError("Anime not found on AnimeKai");
  const normalizedTitle = normalizeTitle$6(title);
  const exact = data.results.find((r) => normalizeTitle$6(r.title) === normalizedTitle);
  return (exact ?? data.results[0]).id;
}
async function scrapeAnimekai(ctx) {
  var _a;
  const title = ctx.media.title;
  const episodeNumber = ctx.media.episode.number;
  const animeId = await searchAnime(ctx, title);
  const info = await ctx.fetcher(`${consumetBase}/info?id=${animeId}`);
  if (!((_a = info == null ? void 0 : info.episodes) == null ? void 0 : _a.length)) throw new NotFoundError("No episodes found on AnimeKai");
  const ep = info.episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new NotFoundError("Episode not found on AnimeKai");
  return {
    embeds: [{ embedId: "animekai-embed", url: JSON.stringify({ episodeId: ep.id }) }]
  };
}
const animekaiScraper = makeSourcerer({
  id: "animekai",
  name: "AnimeKai 🔥",
  rank: 180,
  flags: [],
  scrapeShow: scrapeAnimekai
});
function loadTurnstileScript() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    if (document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const checkLoaded = () => {
        if (window.turnstile) {
          resolve();
        } else {
          setTimeout(checkLoaded, 100);
        }
      };
      checkLoaded();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });
}
async function getTurnstileToken(sitekey, timeout = 3e4) {
  if (typeof window === "undefined") {
    throw new Error("Turnstile verification requires browser environment");
  }
  try {
    await loadTurnstileScript();
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.style.top = "-9999px";
    container.style.width = "1px";
    container.style.height = "1px";
    container.style.overflow = "hidden";
    container.style.opacity = "0";
    container.style.pointerEvents = "none";
    document.body.appendChild(container);
    return new Promise((resolve, reject) => {
      let widgetId;
      let timeoutId;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (widgetId && window.turnstile) {
          try {
            window.turnstile.remove(widgetId);
          } catch (e) {
          }
        }
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
      };
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("Turnstile verification timed out"));
      }, timeout);
      try {
        widgetId = window.turnstile.render(container, {
          sitekey,
          callback: (token) => {
            cleanup();
            resolve(token);
          },
          "error-callback": (error) => {
            cleanup();
            reject(new Error(`Turnstile error: ${error}`));
          },
          "expired-callback": () => {
            cleanup();
            reject(new Error("Turnstile token expired"));
          },
          "timeout-callback": () => {
            cleanup();
            reject(new Error("Turnstile verification timed out"));
          }
        });
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to render Turnstile widget: ${error}`));
      }
    });
  } catch (error) {
    throw new Error(`Turnstile verification failed: ${error}`);
  }
}
const WORKER_BASE_URL = "https://febbox-api.ruixinhong20.workers.dev";
const TURNSTILE_SITE_KEY = "0x4AAAAAAGC3d6s-StHIYvqG";
const getUserToken$1 = () => {
  var _a;
  try {
    if (typeof window === "undefined") return null;
    const prefData = window.localStorage.getItem("__MW::preferences");
    if (!prefData) return null;
    const parsedAuth = JSON.parse(prefData);
    return ((_a = parsedAuth == null ? void 0 : parsedAuth.state) == null ? void 0 : _a.febboxKey) || null;
  } catch (e) {
    console.warn("Unable to access localStorage or parse auth data:", e);
    return null;
  }
};
const getRegion = () => {
  var _a;
  try {
    if (typeof window === "undefined") return null;
    const regionData = window.localStorage.getItem("__MW::region");
    if (!regionData) return null;
    const parsed = JSON.parse(regionData);
    return ((_a = parsed == null ? void 0 : parsed.state) == null ? void 0 : _a.region) ?? null;
  } catch (e) {
    console.warn("Unable to access localStorage or parse region data:", e);
    return null;
  }
};
function selectSubdomainByRegion(input) {
  const region = (input || "").toLowerCase();
  const nodeMatch = region.match(/\b(usa5|usa6|usa7|uk1|de2|hk1|ca1|au1|sg1|in1)\b/);
  if (nodeMatch) return nodeMatch[1];
  if (region.includes("dallas")) return "usa5";
  if (region.includes("portland")) return "usa6";
  if (region.includes("new-york")) return "usa7";
  if (region.includes("paris")) return Math.random() < 0.5 ? "uk1" : "de2";
  if (region.includes("hong-kong")) return "hk1";
  if (region.includes("kansas")) return Math.random() < 0.5 ? "usa7" : "usa6";
  if (region.includes("sydney")) return "au1";
  if (region.includes("singapore")) return "sg1";
  if (region.includes("mumbai")) return "in1";
  if (region === "east") return "usa7";
  if (region === "west") return "usa6";
  if (region === "south") return "usa5";
  if (region === "europe") return Math.random() < 0.5 ? "uk1" : "de2";
  if (region === "asia") return "sg1";
  return null;
}
function rewriteSheguSubdomain(originalUrl, subdomain) {
  try {
    const parsed = new URL(originalUrl);
    if (parsed.hostname.endsWith(".shegu.net")) {
      parsed.hostname = `${subdomain}.shegu.net`;
      return parsed.toString();
    }
    return originalUrl;
  } catch {
    return originalUrl;
  }
}
function applyRegion(streams) {
  const subdomain = selectSubdomainByRegion(getRegion());
  if (!subdomain) return streams;
  return Object.entries(streams).reduce((acc, [quality, s]) => {
    acc[quality] = { ...s, url: rewriteSheguSubdomain(s.url, subdomain) };
    return acc;
  }, {});
}
function parseStreams(raw) {
  return Object.entries(raw ?? {}).reduce((acc, [quality, entry]) => {
    const url = typeof entry === "string" ? entry : entry.url;
    const type = typeof entry === "string" ? "mp4" : entry.type;
    if (!url) return acc;
    if (quality === "ORG") {
      const urlPath = url.split("?")[0];
      if (urlPath.toLowerCase().includes(".mp4") || type === "hls") {
        acc.unknown = { url, type };
      }
      return acc;
    }
    if (quality.toUpperCase() === "AUTO") {
      if (!acc.auto) acc.auto = { url, type };
      return acc;
    }
    const qualityKey = quality === "4K" ? 2160 : parseInt(quality.replace("P", ""), 10);
    if (Number.isNaN(qualityKey) || acc[qualityKey]) return acc;
    acc[qualityKey] = { url, type };
    return acc;
  }, {});
}
function parseCaptions(subtitles) {
  var _a;
  const captions = [];
  if (!subtitles) return captions;
  for (const [langKey, subtitleData] of Object.entries(subtitles)) {
    const languageKeyPart = langKey.split("_")[0];
    const languageName = languageKeyPart.charAt(0).toUpperCase() + languageKeyPart.slice(1);
    const languageCode = ((_a = labelToLanguageCode(languageName)) == null ? void 0 : _a.toLowerCase()) ?? "unknown";
    if (subtitleData == null ? void 0 : subtitleData.subtitle_link) {
      const url = subtitleData.subtitle_link;
      const isVtt = url.toLowerCase().endsWith(".vtt");
      captions.push({
        type: isVtt ? "vtt" : "srt",
        id: url,
        url,
        language: languageCode,
        hasCorsRestrictions: false
      });
    }
  }
  return captions;
}
function isNotFound(data) {
  if (!data) return true;
  if (data.error && data.error.endsWith("not found in database")) return true;
  return !data.streams || Object.keys(data.streams).length === 0;
}
async function fetchFromWorker(path, userToken, turnstileToken) {
  const baseUrl2 = WORKER_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl2}${path}`, {
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Cf-Turnstile-Response": turnstileToken
    }
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new NotFoundError("API returned an invalid response");
  }
  if (!res.ok && (data == null ? void 0 : data.error) !== "not found in database") {
    throw new NotFoundError((data == null ? void 0 : data.error) ?? "API request failed");
  }
  if (isNotFound(data)) throw new NotFoundError("No stream found");
  return data;
}
async function fetchFromDb(ctx, userToken, turnstileToken) {
  const path = ctx.media.type === "movie" ? `/db/movie/${ctx.media.tmdbId}` : `/db/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  return fetchFromWorker(path, userToken, turnstileToken);
}
async function fetchFromApi(ctx, userToken, turnstileToken) {
  const path = ctx.media.type === "movie" ? `/api/movie/${ctx.media.tmdbId}` : `/api/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  return fetchFromWorker(path, userToken, turnstileToken);
}
async function getWorkerTurnstileToken() {
  try {
    return await getTurnstileToken(TURNSTILE_SITE_KEY);
  } catch (error) {
    alert("FED Turnstile verification failed. Please refresh the page and try again.");
    throw new NotFoundError(`Turnstile verification failed: ${error}`);
  }
}
function buildOutput(streams, captions) {
  var _a;
  const best = streams.auto ?? streams[2160] ?? streams[1080] ?? streams[720] ?? streams[480] ?? streams[360] ?? streams.unknown;
  if ((best == null ? void 0 : best.type) === "hls") {
    return {
      embeds: [],
      stream: [
        {
          id: "primary",
          captions,
          playlist: best.url,
          type: "hls",
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions,
        qualities: {
          ...streams[2160] && { "4k": { type: "mp4", url: streams[2160].url } },
          ...streams[1080] && { 1080: { type: "mp4", url: streams[1080].url } },
          ...streams[720] && { 720: { type: "mp4", url: streams[720].url } },
          ...streams[480] && { 480: { type: "mp4", url: streams[480].url } },
          ...streams[360] && { 360: { type: "mp4", url: streams[360].url } },
          ...streams.unknown && { unknown: { type: "mp4", url: streams.unknown.url } },
          ...((_a = streams.auto) == null ? void 0 : _a.type) === "mp4" && !streams.unknown ? { unknown: { type: "mp4", url: streams.auto.url } } : {}
        },
        type: "file",
        flags: [flags.CORS_ALLOWED]
      }
    ]
  };
}
async function attempt(source, run) {
  try {
    const data = await run();
    const streams = parseStreams(data.streams);
    if (Object.keys(streams).length === 0) throw new NotFoundError("No playable streams");
    return { source, data, streams };
  } catch (error) {
    console.warn(`FED ${source.toUpperCase()} failed:`, error);
    return null;
  }
}
async function comboScraper$x(ctx) {
  const userToken = getUserToken$1();
  if (!userToken) throw new NotFoundError("Requires a user token!");
  let turnstileToken = await getWorkerTurnstileToken();
  ctx.progress(30);
  let result = await attempt("db", () => fetchFromDb(ctx, userToken, turnstileToken));
  if (!result) {
    ctx.progress(50);
    turnstileToken = await getWorkerTurnstileToken();
    result = await attempt("api", () => fetchFromApi(ctx, userToken, turnstileToken));
  }
  if (!result) throw new NotFoundError("No stream found");
  ctx.progress(90);
  const streams = result.source === "db" ? applyRegion(result.streams) : result.streams;
  const captions = parseCaptions(result.data.subtitles);
  ctx.progress(100);
  return buildOutput(streams, captions);
}
const FedAPIScraper = makeSourcerer({
  id: "fedapi",
  name: "FED (4K) 🔥",
  rank: 300,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$x,
  scrapeShow: comboScraper$x
});
const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 10);
const PASS_MD5_PATTERNS = [
  /\$\.get\(['"](\/pass_md5\/[^'"]+)['"]/,
  /\$\.get\(["`](\/pass_md5\/[^"']+)["`]/,
  /\$\.get\s*\(['"](\/pass_md5\/[^'"]+)['"]/,
  /\$\.get\s*\(["`](\/pass_md5\/[^"']+)["`]/
];
const TOKEN_PATTERNS = [/token["']?\s*[:=]\s*["']([^"']+)["']/, /makePlay.*?token=([^"&']+)/];
function extractFirst(html, patterns) {
  for (const pat of patterns) {
    const m = pat.exec(html);
    if (m && m[1]) {
      return m[1];
    }
  }
  return null;
}
function resolveAbsoluteUrl(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}
async function extractVideoUrl(ctx, streamingLink) {
  try {
    const headers2 = {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      Connection: "keep-alive"
    };
    const response = await ctx.proxiedFetcher.full(streamingLink, {
      headers: headers2,
      allowRedirects: true
    });
    const passMd5Match = extractFirst(response.body, PASS_MD5_PATTERNS);
    if (!passMd5Match) {
      return null;
    }
    const baseUrl2 = `${response.finalUrl.split("://")[0]}://${response.finalUrl.split("://")[1].split("/")[0]}`;
    const passMd5Url = resolveAbsoluteUrl(baseUrl2, passMd5Match);
    const passMd5Response = await ctx.proxiedFetcher(passMd5Url, {
      headers: headers2,
      cookies: response.cookies
    });
    const videoUrl = passMd5Response.trim();
    const tokenMatch = extractFirst(response.body, TOKEN_PATTERNS);
    if (tokenMatch) {
      const randomString = nanoid();
      const expiry = Date.now();
      return `${videoUrl}${randomString}?token=${tokenMatch}&expiry=${expiry}`;
    }
    return videoUrl;
  } catch (e) {
    return null;
  }
}
const doodScraper = makeEmbed({
  id: "dood",
  name: "dood",
  disabled: false,
  rank: 173,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    let pageUrl = ctx.url;
    try {
      const url = new URL(pageUrl);
      if (url.hostname === "dood.watch") {
        pageUrl = `https://myvidplay.com${url.pathname}${url.search}`;
      }
    } catch {
    }
    const redirectReq = await ctx.proxiedFetcher.full(pageUrl);
    pageUrl = redirectReq.finalUrl;
    const videoUrl = await extractVideoUrl(ctx, pageUrl);
    if (!videoUrl) {
      throw new Error("dood: could not extract video URL");
    }
    const pageResp = await ctx.proxiedFetcher.full(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const thumbnailMatch = pageResp.body.match(/thumbnails:\s*\{\s*vtt:\s*['"]([^'"]+)['"]/);
    const thumbUrl = thumbnailMatch ? resolveAbsoluteUrl(pageUrl, thumbnailMatch[1]) : null;
    const pageOrigin = new URL(pageUrl).origin;
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.CORS_ALLOWED],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: videoUrl
            }
          },
          preferredHeaders: {
            Referer: pageOrigin
          },
          ...thumbUrl ? {
            thumbnailTrack: {
              type: "vtt",
              url: thumbUrl
            }
          } : {}
        }
      ]
    };
  }
});
const userAgent$2 = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36";
const filemoonScraper = makeEmbed({
  id: "filemoon",
  name: "Filemoon",
  rank: 405,
  flags: [],
  async scrape(ctx) {
    const headers2 = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      Referer: `${new URL(ctx.url).origin}/`,
      "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
      "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": userAgent$2
    };
    const response = await ctx.proxiedFetcher(ctx.url, { headers: headers2 });
    const soup = load(response);
    const iframe = soup("iframe").first();
    if (!iframe.length) throw new NotFoundError("No iframe found");
    const iframeUrl = iframe.attr("src");
    if (!iframeUrl) throw new NotFoundError("No iframe src found");
    const iframeResponse = await ctx.proxiedFetcher(iframeUrl, { headers: headers2 });
    const iframeSoup = load(iframeResponse);
    const jsCode = iframeSoup("script").filter((_, el) => {
      const text = iframeSoup(el).html() || "";
      return text.includes("eval(function(p,a,c,k,e,d)");
    }).first().html();
    if (!jsCode) throw new NotFoundError("No packed JS code found");
    const unpacked = unpack$2(jsCode);
    if (!unpacked) throw new NotFoundError("Failed to unpack JS code");
    const videoMatch = unpacked.match(/file:"([^"]+)"/);
    if (!videoMatch) throw new NotFoundError("No video URL found");
    const videoUrl = videoMatch[1];
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: videoUrl,
          headers: {
            Referer: `${new URL(ctx.url).origin}/`,
            "User-Agent": userAgent$2
          },
          flags: [],
          captions: []
        }
      ]
    };
  }
});
const mixdropBase = "https://mixdrop.ag";
const packedRegex$1 = /(eval\(function\(p,a,c,k,e,d\){.*{}\)\))/;
const linkRegex$1 = /MDCore\.wurl="(.*?)";/;
const mixdropScraper = makeEmbed({
  id: "mixdrop",
  name: "MixDrop",
  rank: 198,
  flags: [flags.IP_LOCKED],
  async scrape(ctx) {
    let embedUrl = ctx.url;
    if (ctx.url.includes("primewire")) embedUrl = (await ctx.fetcher.full(ctx.url)).finalUrl;
    const embedId = new URL(embedUrl).pathname.split("/")[2];
    const streamRes = await ctx.proxiedFetcher(`/e/${embedId}`, {
      baseUrl: mixdropBase
    });
    const packed = streamRes.match(packedRegex$1);
    if (!packed) {
      throw new Error("failed to find packed mixdrop JavaScript");
    }
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex$1);
    if (!link) {
      throw new Error("failed to find packed mixdrop source link");
    }
    const url = link[1];
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          flags: [flags.IP_LOCKED],
          captions: [],
          qualities: {
            unknown: {
              type: "mp4",
              url: url.startsWith("http") ? url : `https:${url}`,
              // URLs don't always start with the protocol
              headers: {
                // MixDrop requires this header on all streams
                Referer: mixdropBase
              }
            }
          }
        }
      ]
    };
  }
});
const serverMirrorEmbed = makeEmbed({
  id: "mirror",
  name: "Mirror",
  rank: 1,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    const context = JSON.parse(ctx.url);
    if (context.type === "hls") {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: context.stream,
            headers: context.headers,
            flags: context.flags,
            captions: context.captions,
            skipValidation: context.skipvalid
          }
        ]
      };
    }
    return {
      stream: [
        {
          id: "primary",
          type: "file",
          qualities: context.qualities,
          flags: context.flags,
          captions: context.captions,
          headers: context.headers,
          skipValidation: context.skipvalid
        }
      ]
    };
  }
});
function hexToChar(hex) {
  return String.fromCharCode(parseInt(hex, 16));
}
function decrypt(data, key2) {
  var _a;
  const formatedData = ((_a = data.match(/../g)) == null ? void 0 : _a.map(hexToChar).join("")) || "";
  return formatedData.split("").map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ key2.charCodeAt(i % key2.length))).join("");
}
const turbovidScraper = makeEmbed({
  id: "turbovid",
  name: "Turbovid",
  rank: 122,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    var _a, _b;
    const baseUrl2 = new URL(ctx.url).origin;
    const embedPage = await ctx.proxiedFetcher(ctx.url);
    ctx.progress(30);
    const apkey = (_a = embedPage.match(/const\s+apkey\s*=\s*"(.*?)";/)) == null ? void 0 : _a[1];
    const xxid = (_b = embedPage.match(/const\s+xxid\s*=\s*"(.*?)";/)) == null ? void 0 : _b[1];
    if (!apkey || !xxid) throw new Error("Failed to get required values");
    const encodedJuiceKey = JSON.parse(
      await ctx.proxiedFetcher("/api/cucked/juice_key", {
        baseUrl: baseUrl2,
        headers: {
          referer: ctx.url,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
          "Content-Type": "application/json",
          "X-Turbo": "TurboVidClient",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin"
        }
      })
    ).juice;
    if (!encodedJuiceKey) throw new Error("Failed to fetch the key");
    const juiceKey = atob(encodedJuiceKey);
    ctx.progress(60);
    const data = JSON.parse(
      await ctx.proxiedFetcher("/api/cucked/the_juice_v2/", {
        baseUrl: baseUrl2,
        query: {
          [apkey]: xxid
        },
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
          "Content-Type": "application/json",
          "X-Turbo": "TurboVidClient",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          referer: ctx.url
        }
      })
    ).data;
    if (!data) throw new Error("Failed to fetch required data");
    ctx.progress(90);
    const playlist = decrypt(data, juiceKey);
    const streamHeaders = {
      referer: `${baseUrl2}/`,
      origin: baseUrl2
    };
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist,
          preferredHeaders: streamHeaders,
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const origin = "https://rabbitstream.net";
const referer$2 = "https://rabbitstream.net/";
const { AES, enc } = CryptoJS;
function isJSON(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}
function extractKey(script) {
  const startOfSwitch = script.lastIndexOf("switch");
  const endOfCases = script.indexOf("partKeyStartPosition");
  const switchBody = script.slice(startOfSwitch, endOfCases);
  const nums = [];
  const matches = switchBody.matchAll(/:[a-zA-Z0-9]+=([a-zA-Z0-9]+),[a-zA-Z0-9]+=([a-zA-Z0-9]+);/g);
  for (const match of matches) {
    const innerNumbers = [];
    for (const varMatch of [match[1], match[2]]) {
      const regex = new RegExp(`${varMatch}=0x([a-zA-Z0-9]+)`, "g");
      const varMatches = [...script.matchAll(regex)];
      const lastMatch = varMatches[varMatches.length - 1];
      if (!lastMatch) return null;
      const number = parseInt(lastMatch[1], 16);
      innerNumbers.push(number);
    }
    nums.push([innerNumbers[0], innerNumbers[1]]);
  }
  return nums;
}
const upcloudScraper = makeEmbed({
  id: "upcloud",
  name: "UpCloud",
  rank: 200,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    const parsedUrl = new URL(ctx.url.replace("embed-5", "embed-4"));
    const dataPath = parsedUrl.pathname.split("/");
    const dataId = dataPath[dataPath.length - 1];
    const streamRes = await ctx.proxiedFetcher(`${parsedUrl.origin}/ajax/embed-4/getSources?id=${dataId}`, {
      headers: {
        Referer: parsedUrl.origin,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    let sources = null;
    if (!isJSON(streamRes.sources)) {
      const scriptJs = await ctx.proxiedFetcher(`https://rabbitstream.net/js/player/prod/e4-player.min.js`, {
        query: {
          // browser side caching on this endpoint is quite extreme. Add version query paramter to circumvent any caching
          v: Date.now().toString()
        }
      });
      const decryptionKey = extractKey(scriptJs);
      if (!decryptionKey) throw new Error("Key extraction failed");
      let extractedKey = "";
      let strippedSources = streamRes.sources;
      let totalledOffset = 0;
      decryptionKey.forEach(([a, b]) => {
        const start = a + totalledOffset;
        const end = start + b;
        extractedKey += streamRes.sources.slice(start, end);
        strippedSources = strippedSources.replace(streamRes.sources.substring(start, end), "");
        totalledOffset += b;
      });
      const decryptedStream = AES.decrypt(strippedSources, extractedKey).toString(enc.Utf8);
      const parsedStream = JSON.parse(decryptedStream)[0];
      if (!parsedStream) throw new Error("No stream found");
      sources = parsedStream;
    }
    if (!sources) throw new Error("upcloud source not found");
    const captions = [];
    streamRes.tracks.forEach((track) => {
      if (track.kind !== "captions") return;
      const type = getCaptionTypeFromUrl(track.file);
      if (!type) return;
      const language = labelToLanguageCode(track.label.split(" ")[0]);
      if (!language) return;
      captions.push({
        id: track.file,
        language,
        hasCorsRestrictions: false,
        type,
        url: track.file
      });
    });
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: sources.file,
          flags: [flags.CORS_ALLOWED],
          captions,
          preferredHeaders: {
            Referer: referer$2,
            Origin: origin
          }
        }
      ]
    };
  }
});
const apiUrl = "https://tom.autoembed.cc";
async function comboScraper$w(ctx) {
  const mediaType = ctx.media.type === "show" ? "tv" : "movie";
  let id = ctx.media.tmdbId;
  if (ctx.media.type === "show") {
    id = `${id}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  }
  const data = await ctx.proxiedFetcher(`/api/getVideoSource`, {
    baseUrl: apiUrl,
    query: {
      type: mediaType,
      id
    },
    headers: {
      Referer: apiUrl,
      Origin: apiUrl
    }
  });
  if (!data) throw new NotFoundError("Failed to fetch video source");
  if (!data.videoSource) throw new NotFoundError("No video source found");
  ctx.progress(50);
  const embeds = [
    {
      embedId: `autoembed-english`,
      url: data.videoSource
    }
  ];
  ctx.progress(90);
  return {
    embeds
  };
}
const autoembedScraper = makeSourcerer({
  id: "autoembed",
  name: "Autoembed",
  rank: 110,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$w,
  scrapeShow: comboScraper$w
});
const TMDB_API_KEY = "a500049f3e06109fe3e8289b06cf5685";
async function fetchTMDBName(ctx, lang = "en-US") {
  const type = ctx.media.type === "movie" ? "movie" : "tv";
  const url = `https://api.themoviedb.org/3/${type}/${ctx.media.tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error fetching TMDB data: ${response.statusText}`);
  }
  const data = await response.json();
  return ctx.media.type === "movie" ? data.title : data.name;
}
const BASE_URL$1 = "https://dopebox.to";
const SEARCH_URL = `${BASE_URL$1}/search/`;
const SEASONS_URL = `${BASE_URL$1}/ajax/season/list/`;
const EPISODES_URL = `${BASE_URL$1}/ajax/season/episodes/`;
const SHOW_SERVERS_URL = `${BASE_URL$1}/ajax/episode/servers/`;
const MOVIE_SERVERS_URL = `${BASE_URL$1}/ajax/episode/list/`;
const FETCH_EMBEDS_URL = `${BASE_URL$1}/ajax/episode/sources/`;
const FETCH_SOURCES_URL = "https://streameeeeee.site/embed-1/v3/e-1/getSources";
const CLIENT_KEY_PATTERN_1 = /window\._lk_db\s*?=\s*?{\s*?x:\s*?"(\w+)?",\s*?y:\s*?"(\w+)?",\s*?z:\s*?"(\w+)?"\s*?}/;
const CLIENT_KEY_PATTERN_2 = /window\._xy_ws\s*?=\s*?"(\w+)?"/;
const CLIENT_KEY_PATTERN_3 = /\s*?_is_th:\s*?(\w+)\s*?/;
function getSearchQuery(title) {
  return title.trim().split(" ").join("-").toLowerCase();
}
async function searchMedia(ctx, query) {
  const response = await ctx.proxiedFetcher.full(`${SEARCH_URL}${query}`, {
    headers: {
      Origin: BASE_URL$1,
      Referer: `${BASE_URL$1}/`
    }
  });
  const $ = cheerio.load(response.body);
  const results = [];
  $(".flw-item").each((_, film) => {
    var _a, _b, _c, _d;
    const detail = $(film).find(".film-detail").first();
    const nameURL = (_a = detail == null ? void 0 : detail.find(".film-name").first()) == null ? void 0 : _a.find("a").first();
    if (!detail || !nameURL) {
      return;
    }
    const pathname = (_b = nameURL.attr("href")) == null ? void 0 : _b.trim();
    const title = (_c = nameURL.attr("title")) == null ? void 0 : _c.trim();
    const info = (_d = detail.find(".fd-infor").first()) == null ? void 0 : _d.find("span").map((__, span) => $(span).text().trim()).toArray();
    if (!pathname || !title || !info || info.length === 0) {
      return;
    }
    const url = URL.parse(pathname, BASE_URL$1);
    const id = url == null ? void 0 : url.pathname.split("-").pop();
    if (!url || !id) {
      console.error("Could not parse media URL", pathname);
      return;
    }
    results.push({
      url,
      id,
      title,
      info
    });
  });
  return results;
}
async function getSeasons(ctx, media) {
  const response = await ctx.proxiedFetcher.full(`${SEASONS_URL}${media.id}`, {
    headers: {
      Origin: BASE_URL$1,
      Referer: `${BASE_URL$1}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  const $ = cheerio.load(response.body);
  const seasons = [];
  $(".ss-item").each((_, s) => {
    var _a, _b;
    const id = (_a = $(s).attr("data-id")) == null ? void 0 : _a.trim();
    const number = (_b = /(\d+)/.exec($(s).text().trim())) == null ? void 0 : _b[1].trim();
    if (!id || !number) {
      return;
    }
    seasons.push({
      id,
      number: parseInt(number, 10)
    });
  });
  return seasons;
}
async function getEpisodes$1(ctx, season) {
  const response = await ctx.proxiedFetcher.full(`${EPISODES_URL}${season.id}`, {
    headers: {
      Origin: BASE_URL$1,
      Referer: `${BASE_URL$1}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  const $ = cheerio.load(response.body);
  const episodes = [];
  $(".eps-item").each((_, ep) => {
    var _a, _b, _c, _d, _e;
    const id = (_a = $(ep).attr("data-id")) == null ? void 0 : _a.trim();
    const number = (_b = /(\d+)/.exec($(ep).find(".episode-number").first().text())) == null ? void 0 : _b[1].trim();
    const title = (_e = (_d = (_c = $(ep).find(".film-name").first()) == null ? void 0 : _c.find("a").first()) == null ? void 0 : _d.attr("title")) == null ? void 0 : _e.trim();
    if (!id || !number) {
      return;
    }
    episodes.push({
      id,
      number: parseInt(number, 10),
      title
    });
  });
  return episodes;
}
async function getPlayers(ctx, media, url) {
  const response = await ctx.proxiedFetcher.full(url, {
    headers: {
      Origin: BASE_URL$1,
      Referer: `${BASE_URL$1}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  const $ = cheerio.load(response.body);
  const players = [];
  $(".link-item").each((_, p) => {
    var _a, _b;
    const id = (_a = $(p).attr("data-id")) == null ? void 0 : _a.trim();
    const name = (_b = $(p).find("span").first()) == null ? void 0 : _b.text().trim();
    if (!id || !name) {
      return;
    }
    players.push({
      id,
      url: `${media.url.href.replace(/\/tv\//, "/watch-tv/").replace(/\/movie\//, "/watch-movie/")}.${id}`,
      name
    });
  });
  return players;
}
async function getEpisodePlayers(ctx, media, episode) {
  return getPlayers(ctx, media, `${SHOW_SERVERS_URL}${episode.id}`);
}
async function getMoviePlayers(ctx, media) {
  return getPlayers(ctx, media, `${MOVIE_SERVERS_URL}${media.id}`);
}
async function getEmbedLink(ctx, playerURL) {
  const sourceID = playerURL.split(".").pop();
  const response = await ctx.proxiedFetcher.full(`${FETCH_EMBEDS_URL}${sourceID}`, {
    headers: {
      Referer: playerURL,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  return response.body.link;
}
async function getClientKey(ctx, embedURL) {
  const response = await ctx.proxiedFetcher.full(embedURL, {
    headers: {
      Referer: `${BASE_URL$1}/`,
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site"
    }
  });
  const $ = cheerio.load(response.body);
  let key2 = "";
  $("script").each((_, script) => {
    if (key2) {
      return false;
    }
    const text = $(script).text().trim();
    let match = CLIENT_KEY_PATTERN_2.exec(text);
    if (match) {
      key2 = match.slice(1).join("").trim();
      return;
    }
    match = CLIENT_KEY_PATTERN_1.exec(text);
    if (!match) {
      return;
    }
    key2 = match[1].trim();
  });
  $("script").each((_, script) => {
    if (key2) {
      return false;
    }
    const attr = $(script).attr("nonce");
    if (!attr) {
      return;
    }
    key2 = attr.trim();
  });
  $("div").each((_, div) => {
    if (key2) {
      return false;
    }
    const attr = $(div).attr("data-dpi");
    if (!attr) {
      return;
    }
    key2 = attr.trim();
  });
  $("meta").each((_, meta) => {
    var _a, _b;
    if (key2) {
      return false;
    }
    const name = (_a = $(meta).attr("name")) == null ? void 0 : _a.trim();
    const content = (_b = $(meta).attr("content")) == null ? void 0 : _b.trim();
    if (!name || !content || name !== "_gg_fb") {
      return;
    }
    key2 = content.trim();
  });
  $("*").contents().each((_, node) => {
    if (key2) {
      return false;
    }
    if (node.nodeType === 8) {
      const match = CLIENT_KEY_PATTERN_3.exec(node.nodeValue.trim());
      if (!match) {
        return;
      }
      key2 = match[1].trim();
    }
  });
  return key2;
}
async function scrapeUpCloudEmbed(ctx) {
  const embedURL = URL.parse(await getEmbedLink(ctx, ctx.url));
  if (!embedURL) {
    throw new Error("Failed to get embed URL (invalid movie?)");
  }
  const embedID = embedURL.pathname.split("/").pop();
  if (!embedID) {
    throw new Error("Failed to get embed ID");
  }
  const clientKey = await getClientKey(ctx, embedURL.href);
  if (!clientKey) {
    throw new Error("Failed to get client key");
  }
  const response = await ctx.proxiedFetcher.full(`${FETCH_SOURCES_URL}?id=${embedID}&_k=${clientKey}`, {
    headers: {
      Referer: embedURL.href,
      Origin: "https://streameeeeee.site",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  if (!response.body.sources || response.body.sources.length === 0) {
    console.warn("Server gave no sources", response.body);
    return {
      stream: []
    };
  }
  const streamHeaders = {
    Referer: "https://streameeeeee.site/",
    Origin: "https://streameeeeee.site"
  };
  return {
    stream: response.body.sources.map((source, i) => {
      return {
        type: "hls",
        id: `stream-${i}`,
        flags: [flags.CORS_ALLOWED],
        captions: [],
        playlist: createM3U8ProxyUrl(source.file, ctx.features, streamHeaders),
        headers: streamHeaders
      };
    })
  };
}
async function handleContext(ctx) {
  var _a;
  if (ctx.media.type !== "movie" && ctx.media.type !== "show") {
    return [];
  }
  const mediaType = ctx.media.type === "show" ? "TV" : "Movie";
  const mediaTitle = await fetchTMDBName(ctx);
  const results = (await searchMedia(ctx, getSearchQuery(mediaTitle))).filter((r) => r.info.includes(mediaType));
  const fuse = new Fuse(results, {
    keys: ["title"]
  });
  const media = (_a = fuse.search(mediaTitle).find((r) => r.item.info.includes(ctx.media.releaseYear.toString()))) == null ? void 0 : _a.item;
  if (!media) {
    throw new Error("Could not find movie");
  }
  if (ctx.media.type === "show") {
    const seasonNumber = ctx.media.season.number;
    const epNumber = ctx.media.episode.number;
    const season = (await getSeasons(ctx, media)).find((s) => s.number === seasonNumber);
    if (!season) {
      throw new Error("Could not find season");
    }
    const episode = (await getEpisodes$1(ctx, season)).find((ep) => ep.number === epNumber);
    if (!episode) {
      throw new Error("Could not find episode");
    }
    return getEpisodePlayers(ctx, media, episode);
  }
  return getMoviePlayers(ctx, media);
}
function addEmbedFromPlayer(name, players, embeds) {
  const player = players.find((p) => p.name.toLowerCase().trim() === name.toLowerCase().trim());
  if (!player) {
    return;
  }
  embeds.push({
    embedId: `dopebox-${player.name.toLowerCase().trim()}`,
    url: player.url
  });
}
async function comboScraper$v(ctx) {
  const players = await handleContext(ctx);
  if (!players) {
    return {
      embeds: [],
      stream: []
    };
  }
  const embeds = [];
  addEmbedFromPlayer("UpCloud", players, embeds);
  if (embeds.length < 1) {
    throw new Error("No valid sources were found");
  }
  return {
    embeds
  };
}
const dopeboxScraper = makeSourcerer({
  id: "dopebox",
  name: "Dopebox",
  rank: 197,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$v,
  scrapeShow: comboScraper$v
});
const dopeboxEmbeds = [
  makeEmbed({
    id: "dopebox-upcloud",
    name: "UpCloud",
    rank: 101,
    disabled: true,
    flags: [flags.CORS_ALLOWED],
    scrape: scrapeUpCloudEmbed
  })
];
const apiBaseUrl = "https://borg.rips.cc";
const username = "_ps_";
const password = "defonotscraping";
async function fetchMovie(ctx, ee3Auth) {
  const authResp = await ctx.proxiedFetcher.full(
    `${apiBaseUrl}/api/collections/users/auth-with-password?expand=lists_liked`,
    {
      method: "POST",
      headers: {
        Origin: "https://ee3.me",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        identity: username,
        password: ee3Auth
      })
    }
  );
  if (authResp.statusCode !== 200) {
    throw new Error(`Auth failed with status: ${authResp.statusCode}: ${JSON.stringify(authResp.body)}`);
  }
  const jsonResponse = authResp.body;
  if (!(jsonResponse == null ? void 0 : jsonResponse.token)) {
    throw new Error(`No token in auth response: ${JSON.stringify(jsonResponse)}`);
  }
  const token = jsonResponse.token;
  ctx.progress(20);
  const movieUrl = `${apiBaseUrl}/api/collections/movies/records?page=1&perPage=48&filter=tmdb_data.id%20~%20${ctx.media.tmdbId}`;
  const movieResp = await ctx.proxiedFetcher.full(movieUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://ee3.me"
    }
  });
  if (movieResp.statusCode !== 200) {
    throw new Error(`Movie lookup failed with status: ${movieResp.statusCode}: ${JSON.stringify(movieResp.body)}`);
  }
  const movieJsonResponse = movieResp.body;
  if (!(movieJsonResponse == null ? void 0 : movieJsonResponse.items) || movieJsonResponse.items.length === 0) {
    throw new NotFoundError(`No items found for TMDB ID ${ctx.media.tmdbId}: ${JSON.stringify(movieJsonResponse)}`);
  }
  if (!movieJsonResponse.items[0].video) {
    throw new NotFoundError(`No video field in first item: ${JSON.stringify(movieJsonResponse.items[0])}`);
  }
  const movieId = movieJsonResponse.items[0].video;
  ctx.progress(40);
  const keyResp = await ctx.proxiedFetcher.full(`${apiBaseUrl}/video/${movieId}/key`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://ee3.me"
    }
  });
  if (keyResp.statusCode !== 200) {
    throw new Error(`Key fetch failed with status: ${keyResp.statusCode}: ${JSON.stringify(keyResp.body)}`);
  }
  const keyJsonResponse = keyResp.body;
  if (!(keyJsonResponse == null ? void 0 : keyJsonResponse.key)) {
    throw new Error(`No key in response: ${JSON.stringify(keyJsonResponse)}`);
  }
  ctx.progress(60);
  return `${movieId}?k=${keyJsonResponse.key}`;
}
async function comboScraper$u(ctx) {
  const movData = await fetchMovie(ctx, password);
  if (!movData) {
    throw new NotFoundError("No watchable item found");
  }
  ctx.progress(80);
  const videoUrl = `${apiBaseUrl}/video/${movData}`;
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        qualities: {
          unknown: {
            type: "mp4",
            url: videoUrl
          }
        },
        headers: {
          Origin: "https://ee3.me"
        },
        flags: [],
        captions: []
      }
    ]
  };
}
const ee3Scraper = makeSourcerer({
  id: "ee3",
  name: "EE3",
  rank: 188,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$u
});
function normalizeTitle$5(title) {
  let titleTrimmed = title.trim().toLowerCase();
  if (titleTrimmed !== "the movie" && titleTrimmed.endsWith("the movie")) {
    titleTrimmed = titleTrimmed.replace("the movie", "");
  }
  if (titleTrimmed !== "the series" && titleTrimmed.endsWith("the series")) {
    titleTrimmed = titleTrimmed.replace("the series", "");
  }
  return titleTrimmed.replace(/['":]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
}
function compareTitle(a, b) {
  return normalizeTitle$5(a) === normalizeTitle$5(b);
}
function compareMedia(media, title, releaseYear) {
  const isSameYear = releaseYear === void 0 ? true : media.releaseYear === releaseYear;
  return compareTitle(media.title, title) && isSameYear;
}
function getValidQualityFromString(quality) {
  switch (quality.toLowerCase().replace("p", "")) {
    case "360":
      return "360";
    case "480":
      return "480";
    case "720":
      return "720";
    case "1080":
      return "1080";
    case "2160":
      return "4k";
    case "4k":
      return "4k";
    default:
      return "unknown";
  }
}
const baseUrl$o = "https://fsharetv.co";
async function comboScraper$t(ctx) {
  var _a, _b;
  const searchPage = await ctx.proxiedFetcher("/search", {
    baseUrl: baseUrl$o,
    query: {
      q: ctx.media.title
    }
  });
  const search$ = load(searchPage);
  const searchResults = [];
  search$(".movie-item").each((_, element) => {
    var _a2;
    const [, title, year] = ((_a2 = search$(element).find("b").text()) == null ? void 0 : _a2.match(/^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/)) || [];
    const url = search$(element).find("a").attr("href");
    if (!title || !url) return;
    searchResults.push({ title, year: Number(year) ?? void 0, url });
  });
  const watchPageUrl = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!watchPageUrl) throw new NotFoundError("No watchable item found");
  ctx.progress(50);
  const watchPage = await ctx.proxiedFetcher(watchPageUrl.replace("/movie", "/w"), { baseUrl: baseUrl$o });
  const fileId = (_b = watchPage.match(/Movie\.setSource\('([^']*)'/)) == null ? void 0 : _b[1];
  if (!fileId) throw new Error("File ID not found");
  const apiRes = await ctx.proxiedFetcher(
    `/api/file/${fileId}/source`,
    {
      baseUrl: baseUrl$o,
      query: {
        type: "watch"
      }
    }
  );
  if (!apiRes.data.file.sources.length) throw new Error("No sources found");
  const mediaBase = new URL((await ctx.proxiedFetcher.full(apiRes.data.file.sources[0].src, { baseUrl: baseUrl$o })).finalUrl).origin;
  const qualities = apiRes.data.file.sources.reduce(
    (acc, source) => {
      const quality = typeof source.quality === "number" ? source.quality.toString() : source.quality;
      const validQuality = getValidQualityFromString(quality);
      acc[validQuality] = {
        type: "mp4",
        url: `${mediaBase}${source.src.replace("/api", "")}`
      };
      return acc;
    },
    {}
  );
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [],
        headers: {
          referer: "https://fsharetv.co"
        },
        qualities,
        captions: []
      }
    ]
  };
}
const fsharetvScraper = makeSourcerer({
  id: "fsharetv",
  name: "FshareTV",
  rank: 201,
  flags: [],
  scrapeMovie: comboScraper$t
});
const ORIGIN_HOST = "https://www3.fsonline.app";
const MOVIE_PAGE_URL = "https://www3.fsonline.app/film/";
const SHOW_PAGE_URL = "https://www3.fsonline.app/episoade/{{MOVIE}}-sezonul-{{SEASON}}-episodul-{{EPISODE}}/";
const EMBED_URL = "https://www3.fsonline.app/wp-admin/admin-ajax.php";
function throwOnResponse(response) {
  if (response.statusCode >= 400) {
    throw new Error(`Response does not indicate success: ${response.statusCode}`);
  }
}
function getMoviePageURL(name, season, episode) {
  const n = name.trim().normalize("NFD").toLowerCase().replace(/[^a-zA-Z0-9. ]+/g, "").replace(".", " ").split(" ").join("-");
  if (season && episode) {
    return SHOW_PAGE_URL.replace("{{MOVIE}}", n).replace("{{SEASON}}", `${season}`).replace("{{EPISODE}}", `${episode}`);
  }
  return `${MOVIE_PAGE_URL}${n}/`;
}
async function fetchIFrame(ctx, url) {
  const response = await ctx.proxiedFetcher.full(url, {
    headers: {
      Referer: ORIGIN_HOST,
      Origin: ORIGIN_HOST,
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site"
    }
  });
  throwOnResponse(response);
  return response;
}
const LOG_PREFIX$1 = `[Doodstream]`;
const STREAM_REQ_PATERN = /\$\.get\('(\/pass_md5\/.+?)'/;
const TOKEN_PARAMS_PATERN = /\+ "\?(token=.+?)"/;
function generateStreamKey() {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let o = 0; o < 10; o++) {
    result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return result;
}
function extractStreamInfo($) {
  let streamReq;
  let tokenParams;
  $("script").each((_, script) => {
    var _a, _b;
    if (streamReq && tokenParams) {
      return;
    }
    const text = $(script).text().trim();
    if (!streamReq) {
      streamReq = (_a = text.match(STREAM_REQ_PATERN)) == null ? void 0 : _a[1];
    }
    if (!tokenParams) {
      tokenParams = (_b = text.match(TOKEN_PARAMS_PATERN)) == null ? void 0 : _b[1];
    }
  });
  tokenParams = `${generateStreamKey()}?${tokenParams}${Date.now()}`;
  return [streamReq, tokenParams];
}
async function getStream$3(ctx, url) {
  let $;
  let streamHost;
  let reqReferer;
  try {
    const response = await fetchIFrame(ctx, url);
    if (!response) {
      return void 0;
    }
    $ = cheerio.load(response.body);
    streamHost = new URL(response.finalUrl).hostname;
    reqReferer = response.finalUrl;
  } catch (error) {
    console.error(LOG_PREFIX$1, "Failed to fetch iframe", error);
    return void 0;
  }
  const [streamReq, tokenParams] = extractStreamInfo($);
  if (!streamReq || !tokenParams) {
    console.error(LOG_PREFIX$1, "Couldn't find stream info", streamReq, tokenParams);
    return void 0;
  }
  let streamURL;
  try {
    const response = await ctx.proxiedFetcher.full(`https://${streamHost}${streamReq}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: reqReferer,
        Origin: ORIGIN_HOST
      }
    });
    throwOnResponse(response);
    streamURL = await response.body + tokenParams;
  } catch (error) {
    console.error(LOG_PREFIX$1, "Failed to request stream URL", error);
    return void 0;
  }
  return [streamURL, new URL(streamURL).hostname];
}
async function scrapeDoodstreamEmbed(ctx) {
  let streamURL;
  let streamHost;
  try {
    const stream = await getStream$3(ctx, ctx.url);
    if (!stream || !stream[0]) {
      return {
        stream: []
      };
    }
    [streamURL, streamHost] = stream;
  } catch (error) {
    console.warn(LOG_PREFIX$1, "Failed to get stream", error);
    throw error;
  }
  return {
    stream: [
      {
        type: "file",
        id: "primary",
        flags: [flags.CORS_ALLOWED],
        captions: [],
        qualities: {
          unknown: {
            type: "mp4",
            url: streamURL
          }
        },
        headers: {
          Referer: `https://${streamHost}/`,
          Origin: ORIGIN_HOST
        }
      }
    ]
  };
}
const LOG_PREFIX = "[FSOnline]";
async function getMovieID(ctx, url) {
  let $;
  try {
    const response = await ctx.proxiedFetcher.full(url, {
      headers: {
        Origin: ORIGIN_HOST,
        Referer: ORIGIN_HOST
      }
    });
    throwOnResponse(response);
    $ = cheerio.load(await response.body);
  } catch (error) {
    console.error(LOG_PREFIX, "Failed to fetch movie page", url, error);
    return void 0;
  }
  const movieID = $("#show_player_lazy").attr("movie-id");
  if (!movieID) {
    console.error(LOG_PREFIX, "Could not find movie ID", url);
    return void 0;
  }
  return movieID;
}
async function getMovieSources(ctx, id, refererHeader) {
  const sources = /* @__PURE__ */ new Map();
  let $;
  try {
    const response = await ctx.proxiedFetcher.full(EMBED_URL, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: refererHeader,
        Origin: ORIGIN_HOST
      },
      body: `action=lazy_player&movieID=${id}`
    });
    throwOnResponse(response);
    $ = cheerio.load(await response.body);
  } catch (error) {
    console.error(LOG_PREFIX, "Could not fetch source index", error);
    return sources;
  }
  $("li.dooplay_player_option").each((_, element) => {
    const name = $(element).find("span").text().trim();
    const url = $(element).attr("data-vs");
    if (!url) {
      console.warn(LOG_PREFIX, "Skipping invalid source", name);
      return;
    }
    sources.set(name, url);
  });
  return sources;
}
function addEmbedFromSources(name, sources, embeds) {
  const url = sources.get(name);
  if (!url) {
    return;
  }
  embeds.push({
    embedId: `fsonline-${name.toLowerCase()}`,
    url
  });
}
async function comboScraper$s(ctx) {
  const movieName = await fetchTMDBName(ctx);
  const moviePageURL = getMoviePageURL(
    ctx.media.type === "movie" ? `${movieName} ${ctx.media.releaseYear}` : movieName,
    ctx.media.type === "show" ? ctx.media.season.number : void 0,
    ctx.media.type === "show" ? ctx.media.episode.number : void 0
  );
  const movieID = await getMovieID(ctx, moviePageURL);
  if (!movieID) {
    return {
      embeds: [],
      stream: []
    };
  }
  const embeds = [];
  const sources = await getMovieSources(ctx, movieID, moviePageURL);
  addEmbedFromSources("Filemoon", sources, embeds);
  addEmbedFromSources("Doodstream", sources, embeds);
  if (embeds.length < 1) {
    throw new Error("No valid sources were found");
  }
  return {
    embeds
  };
}
const fsOnlineScraper = makeSourcerer({
  id: "fsonline",
  name: "FSOnline",
  rank: 140,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$s,
  scrapeShow: comboScraper$s
});
const fsOnlineEmbeds = [
  makeEmbed({
    id: "fsonline-doodstream",
    name: "Doodstream",
    rank: 140,
    scrape: scrapeDoodstreamEmbed,
    flags: [flags.CORS_ALLOWED]
  })
  // makeEmbed({
  //   id: 'fsonline-filemoon',
  //   name: 'Filemoon',
  //   rank: 140,
  //   scrape: scrapeFilemoonEmbed,
  //   flags: [flags.CORS_ALLOWED],
  // }),
];
const BASE_URL = "https://isut.streamflix.one";
async function comboScraper$r(ctx) {
  const embedPage = await ctx.fetcher(
    `${BASE_URL}/api/source/${ctx.media.type === "movie" ? `${ctx.media.tmdbId}` : `${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`
  );
  const sources = embedPage.sources;
  if (!sources || sources.length === 0) throw new NotFoundError("No sources found");
  const file = sources[0].file;
  if (!file) throw new NotFoundError("No file URL found");
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: file,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const insertunitScraper = makeSourcerer({
  id: "insertunit",
  name: "Insertunit",
  rank: 12,
  disabled: true,
  flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
  scrapeMovie: comboScraper$r,
  scrapeShow: comboScraper$r
});
const baseUrl$n = "https://mp4hydra.org/";
async function comboScraper$q(ctx) {
  var _a;
  const searchPage = await ctx.proxiedFetcher("/search", {
    baseUrl: baseUrl$n,
    query: {
      q: ctx.media.title
    }
  });
  ctx.progress(40);
  const $search = load(searchPage);
  const searchResults = [];
  $search(".search-details").each((_, element) => {
    var _a2;
    const [, title, year] = $search(element).find("a").first().text().trim().match(/^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/) || [];
    const url = (_a2 = $search(element).find("a").attr("href")) == null ? void 0 : _a2.split("/")[4];
    if (!title || !url) return;
    searchResults.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  const s = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!s) throw new NotFoundError("No watchable item found");
  ctx.progress(60);
  const data = await ctx.proxiedFetcher("/info2?v=8", {
    method: "POST",
    body: new URLSearchParams({ z: JSON.stringify([{ s, t: "movie" }]) }),
    baseUrl: baseUrl$n
  });
  if (!data.playlist[0].src || !data.servers) throw new NotFoundError("No watchable item found");
  ctx.progress(80);
  const embeds = [];
  [
    data.servers[data.servers.auto],
    ...Object.values(data.servers).filter((x) => x !== data.servers[data.servers.auto] && x !== data.servers.auto)
  ].forEach(
    (server, _) => embeds.push({ embedId: `mp4hydra-${_ + 1}`, url: `${server}${data.playlist[0].src}|${data.playlist[0].label}` })
  );
  ctx.progress(90);
  return {
    embeds
  };
}
const mp4hydraScraper = makeSourcerer({
  id: "mp4hydra",
  name: "Mp4Hydra",
  rank: 4,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$q,
  scrapeShow: comboScraper$q
});
const baseUrl$m = "https://mbp.pirxcy.dev";
function buildQualitiesFromStreams(data) {
  const streams = data.list.reduce((acc, stream) => {
    const { path, quality, format } = stream;
    const realQuality = stream.real_quality;
    if (format !== "mp4") return acc;
    let qualityKey;
    if (quality === "4K" || realQuality === "4K") {
      qualityKey = 2160;
    } else {
      const qualityStr = quality.replace("p", "");
      qualityKey = parseInt(qualityStr, 10);
    }
    if (Number.isNaN(qualityKey) || acc[qualityKey]) return acc;
    acc[qualityKey] = path;
    return acc;
  }, {});
  const filteredStreams = Object.entries(streams).reduce((acc, [quality, url]) => {
    acc[quality] = url;
    return acc;
  }, {});
  return {
    ...filteredStreams[2160] && {
      "4k": {
        type: "mp4",
        url: filteredStreams[2160]
      }
    },
    ...filteredStreams[1080] && {
      1080: {
        type: "mp4",
        url: filteredStreams[1080]
      }
    },
    ...filteredStreams[720] && {
      720: {
        type: "mp4",
        url: filteredStreams[720]
      }
    },
    ...filteredStreams[480] && {
      480: {
        type: "mp4",
        url: filteredStreams[480]
      }
    },
    ...filteredStreams[360] && {
      360: {
        type: "mp4",
        url: filteredStreams[360]
      }
    },
    ...filteredStreams.unknown && {
      unknown: {
        type: "mp4",
        url: filteredStreams.unknown
      }
    }
  };
}
async function findMediaByTMDBId(ctx, tmdbId, title, type, year) {
  const searchUrl = `${baseUrl$m}/search?q=${encodeURIComponent(title)}&type=${type}${year ? `&year=${year}` : ""}`;
  const searchRes = await ctx.proxiedFetcher(searchUrl);
  if (!searchRes.data || searchRes.data.length === 0) {
    throw new NotFoundError("No results found in search");
  }
  for (const result of searchRes.data) {
    const detailUrl = `${baseUrl$m}/details/${type}/${result.id}`;
    const detailRes = await ctx.proxiedFetcher(detailUrl);
    if (detailRes.data && detailRes.data.tmdb_id.toString() === tmdbId) {
      return result.id;
    }
  }
  throw new NotFoundError("Could not find matching media item for TMDB ID");
}
async function scrapeMovie$1(ctx) {
  var _a;
  const tmdbId = ctx.media.tmdbId;
  const title = ctx.media.title;
  const year = (_a = ctx.media.releaseYear) == null ? void 0 : _a.toString();
  if (!tmdbId || !title) {
    throw new NotFoundError("Missing required media information");
  }
  const mediaId = await findMediaByTMDBId(ctx, tmdbId, title, "movie", year);
  const streamUrl = `${baseUrl$m}/movie/${mediaId}`;
  const streamData = await ctx.proxiedFetcher(streamUrl);
  if (!streamData.data || !streamData.data.list) {
    throw new NotFoundError("No streams found for this movie");
  }
  const qualities = buildQualitiesFromStreams(streamData.data);
  return {
    stream: [
      {
        id: "pirxcy",
        type: "file",
        qualities,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ],
    embeds: []
  };
}
async function scrapeShow(ctx) {
  var _a;
  const tmdbId = ctx.media.tmdbId;
  const title = ctx.media.title;
  const year = (_a = ctx.media.releaseYear) == null ? void 0 : _a.toString();
  const season = ctx.media.season.number;
  const episode = ctx.media.episode.number;
  if (!tmdbId || !title || !season || !episode) {
    throw new NotFoundError("Missing required media information");
  }
  const mediaId = await findMediaByTMDBId(ctx, tmdbId, title, "tv", year);
  const streamUrl = `${baseUrl$m}/tv/${mediaId}/${season}/${episode}`;
  const streamData = await ctx.proxiedFetcher(streamUrl);
  if (!streamData.data || !streamData.data.list) {
    throw new NotFoundError("No streams found for this episode");
  }
  const qualities = buildQualitiesFromStreams(streamData.data);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        qualities,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const pirxcyScraper = makeSourcerer({
  id: "pirxcy",
  name: "Pirxcy",
  rank: 290,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: scrapeMovie$1,
  scrapeShow
});
const baseUrl$l = "https://tugaflix.love/";
function parseSearch(page) {
  const results = [];
  const $ = load(page);
  $(".items .poster").each((_, element) => {
    var _a;
    const $link = $(element).find("a");
    const url = $link.attr("href");
    const [, title, year] = ((_a = $link.attr("title")) == null ? void 0 : _a.match(/^(.*?)\s*(?:\((\d{4})\))?\s*$/)) || [];
    if (!title || !url) return;
    results.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  return results;
}
const tugaflixScraper = makeSourcerer({
  id: "tugaflix",
  name: "Tugaflix",
  rank: 169,
  flags: [flags.CORS_ALLOWED],
  // No longer IP locked
  scrapeMovie: async (ctx) => {
    var _a;
    const searchResults = parseSearch(
      await ctx.proxiedFetcher("/filmes/", {
        baseUrl: baseUrl$l,
        query: {
          s: ctx.media.title
        }
      })
    );
    if (searchResults.length === 0) throw new NotFoundError("No watchable item found");
    const url = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
    if (!url) throw new NotFoundError("No watchable item found");
    ctx.progress(50);
    const videoPage = await ctx.proxiedFetcher(url, {
      method: "POST",
      body: new URLSearchParams({ play: "" })
    });
    const $ = load(videoPage);
    const embeds = [];
    for (const element of $(".play a")) {
      const embedUrl = $(element).attr("href");
      if (!embedUrl) continue;
      const embedPage = await ctx.proxiedFetcher.full(
        embedUrl.startsWith("https://") ? embedUrl : `https://${embedUrl}`
      );
      const finalUrl = load(embedPage.body)('a:contains("Download Filme")').attr("href");
      if (!finalUrl) continue;
      if (finalUrl.includes("streamtape")) {
        embeds.push({
          embedId: "streamtape",
          url: finalUrl
        });
      } else if (finalUrl.includes("dood")) {
        embeds.push({
          embedId: "dood",
          url: finalUrl
        });
      }
    }
    ctx.progress(90);
    return {
      embeds
    };
  },
  scrapeShow: async (ctx) => {
    var _a;
    const searchResults = parseSearch(
      await ctx.proxiedFetcher("/series/", {
        baseUrl: baseUrl$l,
        query: {
          s: ctx.media.title
        }
      })
    );
    if (searchResults.length === 0) throw new NotFoundError("No watchable item found");
    const url = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
    if (!url) throw new NotFoundError("No watchable item found");
    ctx.progress(50);
    const s = ctx.media.season.number < 10 ? `0${ctx.media.season.number}` : ctx.media.season.number.toString();
    const e = ctx.media.episode.number < 10 ? `0${ctx.media.episode.number}` : ctx.media.episode.number.toString();
    const videoPage = await ctx.proxiedFetcher(url, {
      method: "POST",
      body: new URLSearchParams({ [`S${s}E${e}`]: "" })
    });
    const embedUrl = load(videoPage)('iframe[name="player"]').attr("src");
    if (!embedUrl) throw new Error("Failed to find iframe");
    const playerPage = await ctx.proxiedFetcher(embedUrl.startsWith("https:") ? embedUrl : `https:${embedUrl}`, {
      method: "POST",
      body: new URLSearchParams({ submit: "" })
    });
    const embeds = [];
    const finalUrl = load(playerPage)('a:contains("Download Episodio")').attr("href");
    if (finalUrl == null ? void 0 : finalUrl.includes("streamtape")) {
      embeds.push({
        embedId: "streamtape",
        url: finalUrl
      });
    } else if (finalUrl == null ? void 0 : finalUrl.includes("dood")) {
      embeds.push({
        embedId: "dood",
        url: finalUrl
      });
    }
    ctx.progress(90);
    return {
      embeds
    };
  }
});
const baseUrl$k = "https://api2.vidsrc.vip";
function digitToLetterMap(digit) {
  const map = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  return map[parseInt(digit, 10)];
}
function encodeTmdbId(tmdb, type, season, episode) {
  let raw;
  if (type === "show" && season && episode) {
    raw = `${tmdb}-${season}-${episode}`;
  } else {
    raw = tmdb.split("").map(digitToLetterMap).join("");
  }
  const reversed = raw.split("").reverse().join("");
  return btoa(btoa(reversed));
}
async function comboScraper$p(ctx) {
  const apiType = ctx.media.type === "show" ? "tv" : "movie";
  const encodedId = encodeTmdbId(
    ctx.media.tmdbId,
    ctx.media.type,
    ctx.media.type === "show" ? ctx.media.season.number : void 0,
    ctx.media.type === "show" ? ctx.media.episode.number : void 0
  );
  const url = `${baseUrl$k}/${apiType}/${encodedId}`;
  const data = await ctx.proxiedFetcher(url);
  if (!data || !data.source1) throw new NotFoundError("No sources found");
  const embeds = [];
  const embedIds = ["vidsrc-comet", "vidsrc-pulsar", "vidsrc-nova"];
  let sourceIndex = 0;
  for (let i = 1; data[`source${i}`]; i++) {
    const source = data[`source${i}`];
    if (source == null ? void 0 : source.url) {
      embeds.push({
        embedId: embedIds[sourceIndex % embedIds.length],
        url: source.url
      });
      sourceIndex++;
    }
  }
  if (embeds.length === 0) throw new NotFoundError("No embeds found");
  return {
    embeds
  };
}
const vidsrcvipScraper = makeSourcerer({
  id: "vidsrcvip",
  name: "VidSrc.vip",
  rank: 150,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$p,
  scrapeShow: comboScraper$p
});
const zoeBase = "https://zoechip.org";
function createSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
}
async function extractFileFromFilemoon(ctx, filemoonUrl) {
  const headers2 = {
    Referer: zoeBase,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  };
  const redirectResponse = await ctx.proxiedFetcher.full(filemoonUrl, {
    method: "HEAD",
    headers: headers2
  });
  const redirectUrl = redirectResponse.finalUrl;
  if (!redirectUrl) {
    return null;
  }
  const redirectHtml = await ctx.proxiedFetcher(redirectUrl, {
    headers: headers2
  });
  const redirectCheerio = load(redirectHtml);
  const iframeUrl = redirectCheerio("iframe").attr("src");
  if (!iframeUrl) {
    throw new NotFoundError("No iframe URL found");
  }
  const iframeHtml = await ctx.proxiedFetcher(iframeUrl, {
    headers: headers2
  });
  const evalMatch = iframeHtml.match(/eval\(function\(p,a,c,k,e,.*\)\)/i);
  if (!evalMatch) {
    throw new NotFoundError("No packed JavaScript found");
  }
  const unpacked = unpack$2(evalMatch[0]);
  const fileMatch = unpacked.match(/file\s*:\s*"([^"]+)"/i);
  if (!fileMatch) {
    throw new NotFoundError("No file URL found in unpacked JavaScript");
  }
  const fileUrl = fileMatch[1];
  return fileUrl;
}
async function comboScraper$o(ctx) {
  const headers2 = {
    Referer: zoeBase,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  };
  let url;
  let movieId;
  if (ctx.media.type === "movie") {
    const slug = createSlug(ctx.media.title);
    url = `${zoeBase}/film/${slug}-${ctx.media.releaseYear}`;
  } else {
    const slug = createSlug(ctx.media.title);
    url = `${zoeBase}/episode/${slug}-season-${ctx.media.season.number}-episode-${ctx.media.episode.number}`;
  }
  ctx.progress(20);
  const html = await ctx.proxiedFetcher(url, { headers: headers2 });
  const $ = load(html);
  movieId = $("div#show_player_ajax").attr("movie-id");
  if (!movieId) {
    const altId = $("[data-movie-id]").attr("data-movie-id") || $("[movie-id]").attr("movie-id") || $(".player-wrapper").attr("data-id");
    if (altId) {
      movieId = altId;
    } else {
      throw new NotFoundError(`No content found for ${ctx.media.type === "movie" ? "movie" : "episode"}`);
    }
  }
  ctx.progress(40);
  const ajaxUrl = `${zoeBase}/wp-admin/admin-ajax.php`;
  const ajaxHeaders = {
    ...headers2,
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: url
  };
  const body = new URLSearchParams({
    action: "lazy_player",
    movieID: movieId
  });
  const ajaxHtml = await ctx.proxiedFetcher(ajaxUrl, {
    method: "POST",
    headers: ajaxHeaders,
    body: body.toString()
  });
  const $ajax = load(ajaxHtml);
  const filemoonUrl = $ajax("ul.nav a:contains(Filemoon)").attr("data-server");
  if (!filemoonUrl) {
    const allServers = $ajax("ul.nav a").map((_, el) => ({
      name: $ajax(el).text().trim(),
      url: $ajax(el).attr("data-server")
    })).get();
    if (allServers.length === 0) {
      throw new NotFoundError("No streaming servers found");
    }
    throw new NotFoundError("Filemoon server not available");
  }
  ctx.progress(60);
  const fileUrl = await extractFileFromFilemoon(ctx, filemoonUrl);
  if (!fileUrl) {
    throw new NotFoundError("Failed to extract file URL from streaming server");
  }
  ctx.progress(90);
  return {
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: fileUrl,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ],
    embeds: []
  };
}
const zoechipScraper = makeSourcerer({
  id: "zoechip",
  name: "ZoeChip",
  rank: 170,
  disabled: true,
  flags: [],
  scrapeMovie: comboScraper$o,
  scrapeShow: comboScraper$o
});
const ANIMETSU_SERVERS = ["pahe", "zoro", "zaza", "meg", "bato"];
const baseUrl$j = "https://backend.animetsu.net";
const headers$6 = {
  referer: "https://animetsu.net/",
  origin: "https://backend.animetsu.net",
  accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
};
function makeAnimetsuEmbed(id, rank = 100) {
  return makeEmbed({
    id: `animetsu-${id}`,
    name: `Animetsu ${id.charAt(0).toUpperCase() + id.slice(1)}`,
    rank,
    flags: [],
    async scrape(ctx) {
      var _a;
      const serverName = id;
      const query = JSON.parse(ctx.url);
      const { type, anilistId, episode } = query;
      if (type !== "movie" && type !== "show") {
        throw new NotFoundError("Unsupported media type");
      }
      const res = await ctx.proxiedFetcher(`/api/anime/tiddies`, {
        baseUrl: baseUrl$j,
        headers: headers$6,
        query: {
          server: serverName,
          id: String(anilistId),
          num: String(episode ?? 1),
          subType: "dub"
        }
      });
      console.log("Animetsu API Response:", JSON.stringify(res, null, 2));
      const source = (_a = res == null ? void 0 : res.sources) == null ? void 0 : _a[0];
      if (!(source == null ? void 0 : source.url)) throw new NotFoundError("No source URL found");
      const streamUrl = source.url;
      const sourceType = source.type;
      const sourceQuality = source.quality;
      ctx.progress(100);
      if (sourceType === "mp4") {
        let qualityKey = "unknown";
        if (sourceQuality) {
          const qualityMatch = sourceQuality.match(/(\d+)p?/);
          if (qualityMatch) {
            qualityKey = parseInt(qualityMatch[1], 10);
          }
        }
        return {
          stream: [
            {
              id: "primary",
              captions: [],
              qualities: {
                [qualityKey]: {
                  type: "mp4",
                  url: streamUrl
                }
              },
              type: "file",
              headers: headers$6,
              flags: []
            }
          ]
        };
      }
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: streamUrl,
            headers: headers$6,
            flags: [],
            captions: []
          }
        ]
      };
    }
  });
}
const AnimetsuEmbeds = ANIMETSU_SERVERS.map((server, i) => makeAnimetsuEmbed(server, 300 - i));
const providers$4 = [
  {
    id: "autoembed-english",
    rank: 10
  },
  {
    id: "autoembed-hindi",
    rank: 9,
    disabled: true
  },
  {
    id: "autoembed-tamil",
    rank: 8,
    disabled: true
  },
  {
    id: "autoembed-telugu",
    rank: 7,
    disabled: true
  },
  {
    id: "autoembed-bengali",
    rank: 6,
    disabled: true
  }
];
function embed$3(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    disabled: provider.disabled,
    rank: provider.rank,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: ctx.url,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [
  autoembedEnglishScraper,
  autoembedHindiScraper,
  autoembedBengaliScraper,
  autoembedTamilScraper,
  autoembedTeluguScraper
] = providers$4.map(embed$3);
const CINEMAOS_API = atob("aHR0cHM6Ly9jaW5lbWFvcy12My52ZXJjZWwuYXBwL2FwaS9uZW8vYmFja2VuZGZldGNo");
function makeCinemaOSEmbed(server, rank) {
  return makeEmbed({
    id: `cinemaos-${server}`,
    name: `${server.charAt(0).toUpperCase() + server.slice(1)}`,
    rank,
    flags: [flags.CORS_ALLOWED],
    disabled: true,
    async scrape(ctx) {
      var _a;
      const query = JSON.parse(ctx.url);
      const { tmdbId, type, season, episode } = query;
      let url = `${CINEMAOS_API}?requestID=${type === "show" ? "tvVideoProvider" : "movieVideoProvider"}&id=${tmdbId}&service=${server}`;
      if (type === "show") {
        url += `&season=${season}&episode=${episode}`;
      }
      const res = await ctx.proxiedFetcher(url);
      const data = typeof res === "string" ? JSON.parse(res) : res;
      const sources = (_a = data == null ? void 0 : data.data) == null ? void 0 : _a.sources;
      if (!sources || !Array.isArray(sources) || sources.length === 0) {
        throw new NotFoundError("No sources found");
      }
      ctx.progress(80);
      if (sources.length === 1) {
        return {
          stream: [
            {
              id: "primary",
              type: "hls",
              playlist: sources[0].url,
              flags: [flags.CORS_ALLOWED],
              captions: []
            }
          ]
        };
      }
      const qualityMap = {};
      for (const src of sources) {
        const quality = (src.quality || src.source || "unknown").toString();
        let qualityKey;
        if (quality === "4K") {
          qualityKey = 2160;
        } else {
          qualityKey = parseInt(quality.replace("P", ""), 10);
        }
        if (Number.isNaN(qualityKey) || qualityMap[qualityKey]) continue;
        qualityMap[qualityKey] = {
          type: "mp4",
          url: src.url
        };
      }
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            flags: [flags.CORS_ALLOWED],
            qualities: qualityMap,
            captions: []
          }
        ]
      };
    }
  });
}
const CINEMAOS_SERVERS = [
  //   'flowcast',
  "shadow",
  "asiacloud",
  //   'hindicast',
  //   'anime',
  //   'animez',
  //   'guard',
  //   'hq',
  //   'ninja',
  //   'alpha',
  //   'kaze',
  //   'zenith',
  //   'cast',
  //   'ghost',
  //   'halo',
  //   'kinoecho',
  //   'ee3',
  //   'volt',
  //   'putafilme',
  "ophim"
  //   'kage',
];
const cinemaosEmbeds = CINEMAOS_SERVERS.map((server, i) => makeCinemaOSEmbed(server, 300 - i));
function makeCinemaOSHexaEmbed(id, rank = 100) {
  return makeEmbed({
    id: `cinemaos-hexa-${id}`,
    name: `Hexa ${id.charAt(0).toUpperCase() + id.slice(1)}`,
    disabled: true,
    rank,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      const query = JSON.parse(ctx.url);
      const directUrl = query.directUrl;
      if (!directUrl) {
        throw new NotFoundError("No directUrl provided for Hexa embed");
      }
      const headers2 = {
        referer: "https://megacloud.store/",
        origin: "https://megacloud.store"
      };
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: createM3U8ProxyUrl(directUrl, ctx.features, headers2),
            headers: headers2,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const HEXA_SERVERS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
HEXA_SERVERS.map((server, i) => makeCinemaOSHexaEmbed(server, 315 - i));
function customAtob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const str = input.replace(/=+$/, "");
  let output = "";
  if (str.length % 4 === 1) {
    throw new Error("The string to be decoded is not correctly encoded.");
  }
  for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
    const buffer = str.charAt(i);
    const charIndex = chars.indexOf(buffer);
    if (charIndex === -1) continue;
    bs = bc % 4 ? bs * 64 + charIndex : charIndex;
    if (bc++ % 4) {
      output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
    }
  }
  return output;
}
function decodeCloseload(valueParts) {
  const value = valueParts.join("");
  let result = value;
  result = atob(result);
  result = result.replace(/[a-zA-Z]/g, function rot13Transform(c) {
    const charCode = c.charCodeAt(0);
    const newCharCode = charCode + 13;
    const maxCode = c <= "Z" ? 90 : 122;
    return String.fromCharCode(newCharCode <= maxCode ? newCharCode : newCharCode - 26);
  });
  result = result.split("").reverse().join("");
  let unmix = "";
  for (let i = 0; i < result.length; i++) {
    let charCode = result.charCodeAt(i);
    charCode = (charCode - 399756995 % (i + 5) + 256) % 256;
    unmix += String.fromCharCode(charCode);
  }
  return unmix;
}
const referer$1 = "https://ridomovies.tv/";
const closeLoadScraper = makeEmbed({
  id: "closeload",
  name: "CloseLoad",
  rank: 106,
  flags: [flags.IP_LOCKED],
  disabled: true,
  async scrape(ctx) {
    const baseUrl2 = new URL(ctx.url).origin;
    const iframeRes = await ctx.proxiedFetcher(ctx.url, {
      headers: { referer: referer$1 }
    });
    const iframeRes$ = load(iframeRes);
    const captions = iframeRes$("track").map((_, el) => {
      const track = iframeRes$(el);
      const url2 = `${baseUrl2}${track.attr("src")}`;
      const label = track.attr("label") ?? "";
      const language = labelToLanguageCode(label);
      const captionType = getCaptionTypeFromUrl(url2);
      if (!language || !captionType) return null;
      return {
        id: url2,
        language,
        hasCorsRestrictions: true,
        type: captionType,
        url: url2
      };
    }).get().filter((x) => x !== null);
    const evalCode = iframeRes$("script").filter((_, el) => {
      var _a;
      const script = iframeRes$(el);
      return (script.attr("type") === "text/javascript" && ((_a = script.html()) == null ? void 0 : _a.includes("p,a,c,k,e,d"))) ?? false;
    }).html();
    if (!evalCode) throw new Error("Couldn't find eval code");
    const decoded = unpack$2(evalCode);
    let base64EncodedUrl;
    const functionCallMatch = decoded.match(/dc_\w+\(\[([^\]]+)\]\)/);
    if (functionCallMatch) {
      const arrayContent = functionCallMatch[1];
      const stringMatches = arrayContent.match(/"([^"]+)"/g);
      if (stringMatches) {
        const valueParts = stringMatches.map((s) => s.slice(1, -1));
        try {
          const decodedUrl = decodeCloseload(valueParts);
          if (decodedUrl.startsWith("http://") || decodedUrl.startsWith("https://")) {
            base64EncodedUrl = decodedUrl;
          }
        } catch (error) {
        }
      }
    }
    if (!base64EncodedUrl) {
      const patterns = [/var\s+(\w+)\s*=\s*"([^"]+)";/g, /(\w+)\s*=\s*"([^"]+)"/g, /"([A-Za-z0-9+/=]+)"/g];
      for (const pattern of patterns) {
        const match = pattern.exec(decoded);
        if (match) {
          const potentialUrl = match[2] || match[1];
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(potentialUrl) && potentialUrl.length > 10) {
            base64EncodedUrl = potentialUrl;
            break;
          }
        }
      }
    }
    if (!base64EncodedUrl) throw new NotFoundError("Unable to find source url");
    let url;
    if (base64EncodedUrl.startsWith("http://") || base64EncodedUrl.startsWith("https://")) {
      url = base64EncodedUrl;
    } else {
      const isValidBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(base64EncodedUrl);
      if (!isValidBase64) {
        throw new NotFoundError("Invalid base64 encoding found in source url");
      }
      let decodedString;
      try {
        decodedString = atob(base64EncodedUrl);
      } catch (error) {
        try {
          decodedString = customAtob(base64EncodedUrl);
        } catch (customError) {
          throw new NotFoundError(`Failed to decode base64 source url: ${base64EncodedUrl.substring(0, 50)}...`);
        }
      }
      const urlMatch = decodedString.match(/(https?:\/\/[^\s"']+)/);
      if (urlMatch) {
        url = urlMatch[1];
      } else if (decodedString.startsWith("http://") || decodedString.startsWith("https://")) {
        url = decodedString;
      } else {
        throw new NotFoundError(`Decoded string is not a valid URL: ${decodedString.substring(0, 100)}...`);
      }
    }
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions,
          flags: [flags.IP_LOCKED],
          headers: {
            Referer: "https://closeload.top/",
            Origin: "https://closeload.top"
          }
        }
      ]
    };
  }
});
const tracksRegex = /\{file:"([^"]+)",kind:"thumbnails"\}/g;
function extractUrlFromPacked$1(html, patterns) {
  const $ = load(html);
  const packedScript = $("script").filter((_, el) => {
    const htmlContent = $(el).html();
    return htmlContent != null && htmlContent.includes("eval(function(p,a,c,k,e,d)");
  }).first().html();
  if (!packedScript) throw new NotFoundError("Packed script not found");
  try {
    const unpacked = unpack$2(packedScript);
    for (const pattern of patterns) {
      const match = unpacked.match(pattern);
      if (match == null ? void 0 : match[1]) {
        return match[1];
      }
    }
  } catch (error) {
    console.warn("Unpacking failed, trying fallback patterns");
  }
  throw new NotFoundError("Failed to find file URL in packed code");
}
function extractThumbnailTrack(html) {
  const $ = load(html);
  const packedScript = $("script").filter((_, el) => {
    const htmlContent = $(el).html();
    return htmlContent != null && htmlContent.includes("eval(function(p,a,c,k,e,d)");
  }).first().html();
  if (!packedScript) return null;
  try {
    const unpacked = unpack$2(packedScript);
    const thumbnailMatch = tracksRegex.exec(unpacked);
    return (thumbnailMatch == null ? void 0 : thumbnailMatch[1]) || null;
  } catch (error) {
    return null;
  }
}
const droploadScraper = makeEmbed({
  id: "dropload",
  name: "Dropload",
  rank: 120,
  flags: [flags.CORS_ALLOWED],
  scrape: async (ctx) => {
    const headers2 = {
      referer: ctx.url
    };
    const html = await ctx.proxiedFetcher(ctx.url, {
      headers: headers2
    });
    if (html.includes("File Not Found") || html.includes("Pending in queue")) {
      throw new NotFoundError();
    }
    const playlistUrl = extractUrlFromPacked$1(html, [/sources:\[{file:"(.*?)"/]);
    const mainPageUrl = new URL(ctx.url);
    const thumbnailTrack = extractThumbnailTrack(html);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: playlistUrl,
          flags: [flags.CORS_ALLOWED],
          captions: [],
          ...thumbnailTrack && {
            thumbnailTrack: {
              type: "vtt",
              url: mainPageUrl.origin + thumbnailTrack
            }
          }
        }
      ]
    };
  }
});
const filelionsScraper = makeEmbed({
  id: "filelions",
  name: "Filelions",
  rank: 115,
  flags: [],
  async scrape(ctx) {
    const html = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        Referer: "https://primesrc.me/"
      }
    });
    const $ = load(html);
    const packedScript = $("script").filter((_, el) => {
      const htmlContent = $(el).html();
      return htmlContent != null && htmlContent.includes("eval(function(p,a,c,k,e,d)");
    }).first().html();
    if (!packedScript) throw new NotFoundError("Packed script not found");
    const evalMatch = packedScript.match(/eval\((.*)\)/);
    if (!evalMatch) throw new NotFoundError("Eval code not found");
    const unpacked = unpack$2(evalMatch[1]);
    const linksMatch = unpacked.match(/var links=(\{.*?\})/);
    if (!linksMatch) throw new NotFoundError("Links object not found");
    const links = JSON.parse(linksMatch[1]);
    Object.keys(links).forEach((key2) => {
      if (links[key2].startsWith("/stream/")) {
        links[key2] = `https://dinisglows.com${links[key2]}`;
      }
    });
    const streamUrl = links.hls4 || Object.values(links)[0];
    if (!streamUrl) throw new NotFoundError("No stream URL found");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: streamUrl,
          headers: {
            Referer: "https://primesrc.me/"
          },
          flags: [],
          captions: []
        }
      ]
    };
  }
});
const providers$3 = [
  {
    id: "mp4hydra-1",
    name: "MP4Hydra Server 1",
    rank: 36
  },
  {
    id: "mp4hydra-2",
    name: "MP4Hydra Server 2",
    rank: 35,
    disabled: true
  }
];
function embed$2(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    disabled: true,
    rank: provider.rank,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      const [url, quality] = ctx.url.split("|");
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            qualities: {
              [getValidQualityFromString(quality || "")]: { url, type: "mp4" }
            },
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [mp4hydraServer1Scraper, mp4hydraServer2Scraper] = providers$3.map(embed$2);
const myanimedubScraper = makeEmbed({
  id: "myanimedub",
  name: "MyAnime (Dub)",
  rank: 205,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    var _a, _b, _c;
    const streamData = await ctx.proxiedFetcher(
      `https://anime.aether.mom/api/stream?id=${ctx.url}&server=HD-2&type=dub`
    );
    if (!((_b = (_a = streamData.results.streamingLink) == null ? void 0 : _a.link) == null ? void 0 : _b.file)) {
      throw new NotFoundError("No watchable sources found");
    }
    const getValidTimestamp = (timestamp) => {
      if (!timestamp || typeof timestamp !== "object") return null;
      const start = parseInt(timestamp.start, 10);
      const end = parseInt(timestamp.end, 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start <= 0 || end <= 0 || start >= end) return null;
      return { start, end };
    };
    const intro = getValidTimestamp(streamData.results.streamingLink.intro);
    const outro = getValidTimestamp(streamData.results.streamingLink.outro);
    return {
      stream: [
        {
          id: "dub",
          type: "hls",
          playlist: createM3U8ProxyUrl(streamData.results.streamingLink.link.file, ctx.features, {
            Referer: "https://rapid-cloud.co/"
          }),
          headers: {
            Referer: "https://rapid-cloud.co/"
          },
          flags: [flags.CORS_ALLOWED],
          captions: ((_c = streamData.results.streamingLink.tracks) == null ? void 0 : _c.map((track) => {
            const lang = labelToLanguageCode(track.label);
            const type = getCaptionTypeFromUrl(track.file);
            if (!lang || !type) return null;
            return {
              id: track.file,
              url: track.file,
              language: lang,
              type,
              hasCorsRestrictions: true
            };
          }).filter((x) => x)) ?? [],
          intro,
          outro
        }
      ]
    };
  }
});
const myanimesubScraper = makeEmbed({
  id: "myanimesub",
  name: "MyAnime (Sub)",
  rank: 204,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    var _a, _b, _c;
    const streamData = await ctx.proxiedFetcher(
      `https://anime.aether.mom/api/stream?id=${ctx.url}&server=HD-2&type=sub`
    );
    if (!((_b = (_a = streamData.results.streamingLink) == null ? void 0 : _a.link) == null ? void 0 : _b.file)) {
      throw new NotFoundError("No watchable sources found");
    }
    const getValidTimestamp = (timestamp) => {
      if (!timestamp || typeof timestamp !== "object") return null;
      const start = parseInt(timestamp.start, 10);
      const end = parseInt(timestamp.end, 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start <= 0 || end <= 0 || start >= end) return null;
      return { start, end };
    };
    const intro = getValidTimestamp(streamData.results.streamingLink.intro);
    const outro = getValidTimestamp(streamData.results.streamingLink.outro);
    return {
      stream: [
        {
          id: "sub",
          type: "hls",
          playlist: createM3U8ProxyUrl(streamData.results.streamingLink.link.file, ctx.features, {
            Referer: "https://rapid-cloud.co/"
          }),
          headers: {
            Referer: "https://rapid-cloud.co/"
          },
          flags: [flags.CORS_ALLOWED],
          captions: ((_c = streamData.results.streamingLink.tracks) == null ? void 0 : _c.map((track) => {
            const lang = labelToLanguageCode(track.label);
            const type = getCaptionTypeFromUrl(track.file);
            if (!lang || !type) return null;
            return {
              id: track.file,
              url: track.file,
              language: lang,
              type,
              hasCorsRestrictions: true
            };
          }).filter((x) => x)) ?? [],
          intro,
          outro
        }
      ]
    };
  }
});
const referer = "https://ridomovies.tv/";
const playlistHeaders = {
  referer: "https://ridoo.net/",
  origin: "https://ridoo.net"
};
const ridooScraper = makeEmbed({
  id: "ridoo",
  name: "Ridoo",
  rank: 121,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    var _a;
    const res = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer
      }
    });
    const regexPattern = /file:"([^"]+)"/g;
    const url = (_a = regexPattern.exec(res)) == null ? void 0 : _a[1];
    if (!url) throw new NotFoundError("Unable to find source url");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          headers: playlistHeaders,
          captions: [],
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const packedRegex = /(eval\(function\(p,a,c,k,e,d\).*\)\)\))/;
const linkRegex = /src:"(https:\/\/[^"]+)"/;
const streamvidScraper = makeEmbed({
  id: "streamvid",
  name: "Streamvid",
  rank: 215,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex);
    if (!packed) throw new Error("streamvid packed not found");
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex);
    if (!link) throw new Error("streamvid link not found");
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist: link[1],
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
let Unbaser$1 = class Unbaser {
  constructor(base) {
    this.ALPHABET = {
      62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      95: "' !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'"
    };
    this.dictionary = {};
    this.base = base;
    if (base > 36 && base < 62) {
      this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substring(0, base);
    }
    if (base >= 2 && base <= 36) {
      this.unbase = (value) => parseInt(value, base);
    } else {
      try {
        [...this.ALPHABET[base]].forEach((cipher, index) => {
          this.dictionary[cipher] = index;
        });
      } catch {
        throw new Error("Unsupported base encoding.");
      }
      this.unbase = this._dictunbaser.bind(this);
    }
  }
  _dictunbaser(value) {
    let ret = 0;
    [...value].reverse().forEach((cipher, index) => {
      ret += this.base ** index * this.dictionary[cipher];
    });
    return ret;
  }
};
function _filterargs$1(code) {
  const juicers = [
    /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
    /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/
  ];
  for (const juicer of juicers) {
    const args = juicer.exec(code);
    if (args) {
      try {
        return {
          payload: args[1],
          symtab: args[4].split("|"),
          radix: parseInt(args[2], 10),
          count: parseInt(args[3], 10)
        };
      } catch {
        throw new Error("Corrupted p.a.c.k.e.r. data.");
      }
    }
  }
  throw new Error("Could not make sense of p.a.c.k.e.r data (unexpected code structure)");
}
function _replacestrings(str) {
  return str;
}
function unpack$1(packedCode) {
  const { payload, symtab, radix, count } = _filterargs$1(packedCode);
  if (count !== symtab.length) {
    throw new Error("Malformed p.a.c.k.e.r. symtab.");
  }
  let unbase;
  try {
    unbase = new Unbaser$1(radix);
  } catch {
    throw new Error("Unknown p.a.c.k.e.r. encoding.");
  }
  const lookup = (match) => {
    const word = match;
    const word2 = radix === 1 ? symtab[parseInt(word, 10)] : symtab[unbase.unbase(word)];
    return word2 || word;
  };
  const replaced = payload.replace(/\b\w+\b/g, lookup);
  return _replacestrings(replaced);
}
const providers$2 = [
  {
    id: "streamwish-japanese",
    name: "StreamWish (Japanese Sub Español)",
    rank: 171
  },
  {
    id: "streamwish-latino",
    name: "streamwish (latino)",
    rank: 170
  },
  {
    id: "streamwish-spanish",
    name: "streamwish (castellano)",
    rank: 169
  },
  {
    id: "streamwish-english",
    name: "streamwish (english)",
    rank: 168
  }
];
function embed$1(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    flags: [flags.CORS_ALLOWED],
    disabled: provider.disabled,
    async scrape(ctx) {
      const headers2 = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
      };
      const domains = [
        "hgplaycdn.com",
        "habetar.com",
        "yuguaab.com",
        "guxhag.com",
        "auvexiug.com",
        "xenolyzb.com",
        "tryzendm.com"
      ];
      ctx.url = `https://${domains[Math.floor(Math.random() * domains.length)]}${ctx.url.replace("https://streamwish.to", "")}`;
      let html;
      try {
        html = await ctx.proxiedFetcher(ctx.url, { headers: headers2 });
      } catch (error) {
        console.error(`Error:`, {
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error.cause || void 0,
          url: ctx.url
        });
        throw error;
      }
      const obfuscatedScript = html.match(/<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/);
      if (!obfuscatedScript) {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      let unpackedScript;
      try {
        unpackedScript = unpack$1(obfuscatedScript[1]);
      } catch {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      const hls2Match = unpackedScript.match(/"hls2"\s*:\s*"([^"]+)"/);
      if (!hls2Match) {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      let videoUrl = hls2Match[1];
      if (!/^https?:\/\//.test(videoUrl)) {
        videoUrl = `https://swiftplayers.com/${videoUrl.replace(/^\/+/, "")}`;
      }
      const videoHeaders = {
        Referer: ctx.url,
        Origin: ctx.url
      };
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: createM3U8ProxyUrl(videoUrl, ctx.features, videoHeaders),
            headers: videoHeaders,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ],
        embeds: []
      };
    }
  });
}
const [streamwishLatinoScraper, streamwishSpanishScraper, streamwishEnglishScraper, streamwishJapaneseScraper] = providers$2.map(embed$1);
function extractUrlFromPacked(html, patterns) {
  const $ = load(html);
  const packedScript = $("script").filter((_, el) => {
    const htmlContent = $(el).html();
    return htmlContent != null && htmlContent.includes("eval(function(p,a,c,k,e,d)");
  }).first().html();
  if (!packedScript) throw new NotFoundError("Packed script not found");
  try {
    const unpacked = unpack$2(packedScript);
    for (const pattern of patterns) {
      const match = unpacked.match(pattern);
      if (match == null ? void 0 : match[1]) {
        return match[1];
      }
    }
  } catch (error) {
    console.warn("Unpacking failed, trying fallback patterns");
  }
  throw new NotFoundError("Failed to find file URL in packed code");
}
const supervideoScraper = makeEmbed({
  id: "supervideo",
  name: "SuperVideo",
  rank: 130,
  flags: [flags.CORS_ALLOWED],
  scrape: async (ctx) => {
    let url = ctx.url;
    url = url.replace("/e/", "/").replace("/k/", "/").replace("/embed-", "/");
    const headers2 = {
      referer: ctx.url
    };
    let html = await ctx.proxiedFetcher(url, {
      headers: headers2
    });
    if (html.includes("This video can be watched as embed only")) {
      const embedUrl = url.replace(/\/([^/]*)$/, "/e$1");
      html = await ctx.proxiedFetcher(embedUrl, {
        headers: { ...headers2, referer: embedUrl }
      });
    }
    if (/The file was deleted|The file expired|Video is processing/.test(html)) {
      throw new NotFoundError();
    }
    const m3u8Url = extractUrlFromPacked(html, [/sources:\[{file:"(.*?)"/]);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: m3u8Url,
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const vidCloudScraper = makeEmbed({
  id: "vidcloud",
  name: "VidCloud",
  rank: 201,
  disabled: true,
  flags: [],
  async scrape(ctx) {
    const result = await upcloudScraper.scrape(ctx);
    return {
      stream: result.stream.map((s) => ({
        ...s,
        flags: []
      }))
    };
  }
});
class Unbaser2 {
  constructor(base) {
    this.ALPHABET = {
      62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      95: " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
    };
    this.dictionary = {};
    this.base = base;
    if (base > 36 && base < 62) {
      this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substring(0, base);
    }
    if (base >= 2 && base <= 36) {
      this.unbase = (value) => parseInt(value, base);
    } else {
      try {
        [...this.ALPHABET[base]].forEach((cipher, index) => {
          this.dictionary[cipher] = index;
        });
      } catch {
        throw new Error("Unsupported base encoding.");
      }
      this.unbase = this._dictunbaser.bind(this);
    }
  }
  _dictunbaser(value) {
    let ret = 0;
    [...value].reverse().forEach((cipher, index) => {
      ret += this.base ** index * this.dictionary[cipher];
    });
    return ret;
  }
}
function _filterargs(code) {
  const juicers = [/}\s*\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\)/];
  for (const juicer of juicers) {
    const args = juicer.exec(code);
    if (args) {
      try {
        return {
          payload: args[1],
          radix: parseInt(args[2], 10),
          count: parseInt(args[3], 10),
          symtab: args[4].split("|")
        };
      } catch {
        throw new Error("Corrupted p.a.c.k.e.r. data.");
      }
    }
  }
  throw new Error("Could not make sense of p.a.c.k.e.r data (unexpected code structure)");
}
function unpack(packedCode) {
  const { payload, symtab, radix, count } = _filterargs(packedCode);
  if (count !== symtab.length) throw new Error("Malformed p.a.c.k.e.r. symtab.");
  let unbase;
  try {
    unbase = new Unbaser2(radix);
  } catch {
    throw new Error("Unknown p.a.c.k.e.r. encoding.");
  }
  const lookup = (match) => {
    const word = match;
    const word2 = radix === 1 ? symtab[parseInt(word, 10)] : symtab[unbase.unbase(word)];
    return word2 || word;
  };
  return payload.replace(/\b\w+\b/g, lookup);
}
const VIDHIDE_DOMAINS = ["https://vidhidepro.com", "https://vidhidefast.com", "https://dinisglows.com"];
function buildOfficialUrl(originalUrl, officialDomain) {
  try {
    const u = new URL(originalUrl);
    return `${officialDomain}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return originalUrl;
  }
}
async function fetchWithOfficialDomains(ctx, headers2) {
  for (const domain of VIDHIDE_DOMAINS) {
    const testUrl = buildOfficialUrl(ctx.url, domain);
    try {
      const html = await ctx.proxiedFetcher(testUrl, { headers: headers2 });
      if (html && html.includes("eval(function(p,a,c,k,e,d")) {
        return { html, usedUrl: testUrl };
      }
      if (html) {
        return { html, usedUrl: testUrl };
      }
    } catch (err) {
    }
  }
  throw new Error("Could not get valid HTML from any official domain");
}
const providers$1 = [
  {
    id: "vidhide-latino",
    name: "VidHide (Latino)",
    rank: 13
  },
  {
    id: "vidhide-spanish",
    name: "VidHide (Castellano)",
    rank: 14
  },
  {
    id: "vidhide-english",
    name: "VidHide (English)",
    rank: 15
  }
];
function extractSubtitles(unpackedScript) {
  const subtitleRegex = /{file:"([^"]+)",label:"([^"]+)"}/g;
  const results = [];
  const matches = unpackedScript.matchAll(subtitleRegex);
  for (const match of matches) {
    results.push({ file: match[1], label: match[2] });
  }
  return results;
}
function makeVidhideScraper(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    flags: [flags.IP_LOCKED],
    async scrape(ctx) {
      const headers2 = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0"
      };
      const { html, usedUrl } = await fetchWithOfficialDomains(ctx, headers2);
      const obfuscatedScript = html.match(/<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/);
      if (!obfuscatedScript) {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      let unpackedScript;
      try {
        unpackedScript = unpack(obfuscatedScript[1]);
      } catch (e) {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      const m3u8Links = Array.from(unpackedScript.matchAll(/"(http[^"]*?\.m3u8[^"]*?)"/g)).map((m) => m[1]);
      const masterUrl = m3u8Links.find((url) => url.includes("master.m3u8"));
      if (!masterUrl) {
        return { stream: [], embeds: [{ embedId: provider.id, url: ctx.url }] };
      }
      let videoUrl = masterUrl;
      const subtitles = extractSubtitles(unpackedScript);
      try {
        const m3u8Content = await ctx.proxiedFetcher(videoUrl, {
          headers: { Referer: ctx.url }
        });
        const variants = Array.from(
          m3u8Content.matchAll(/#EXT-X-STREAM-INF:[^\n]+\n(?!iframe)([^\n]*master\.m3u8[^\n]*)/gi)
        );
        if (variants.length > 0) {
          const best = variants[0];
          const base = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);
          videoUrl = base + best[1];
        }
      } catch (e) {
      }
      const directHeaders = {
        Referer: usedUrl,
        Origin: new URL(usedUrl).origin
      };
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: videoUrl,
            headers: directHeaders,
            flags: [flags.IP_LOCKED],
            captions: subtitles.map((s, idx) => {
              var _a;
              const ext = (_a = s.file.split(".").pop()) == null ? void 0 : _a.toLowerCase();
              const type = ext === "srt" ? "srt" : "vtt";
              return {
                type,
                id: `caption-${idx}`,
                url: s.file,
                hasCorsRestrictions: false,
                language: s.label || "unknown"
              };
            })
          }
        ]
      };
    }
  });
}
const [vidhideLatinoScraper, vidhideSpanishScraper, vidhideEnglishScraper] = providers$1.map(makeVidhideScraper);
const VIDIFY_SERVERS$1 = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett"];
const baseUrl$i = "api.vidify.top";
const playerUrl = "https://player.vidify.top/";
let cachedAuthHeader = null;
let lastFetched = 0;
async function getAuthHeader(ctx) {
  const now = Date.now();
  if (cachedAuthHeader && now - lastFetched < 1e3 * 60 * 60) {
    return cachedAuthHeader;
  }
  const playerPage = await ctx.proxiedFetcher(playerUrl, {
    headers: {
      Referer: playerUrl
    }
  });
  const jsFileRegex = /\/assets\/index-([a-zA-Z0-9-]+)\.js/;
  const jsFileMatch = playerPage.match(jsFileRegex);
  if (!jsFileMatch) {
    throw new Error("Could not find the JS file URL in the player page");
  }
  const jsFileUrl = new URL(jsFileMatch[0], playerUrl).href;
  const jsContent = await ctx.proxiedFetcher(jsFileUrl, {
    headers: {
      Referer: playerUrl
    }
  });
  const authRegex = /Authorization:"Bearer\s*([^"]+)"/;
  const authMatch = jsContent.match(authRegex);
  if (!authMatch || !authMatch[1]) {
    throw new Error("Could not extract the authorization header from the JS file");
  }
  cachedAuthHeader = `Bearer ${authMatch[1]}`;
  lastFetched = now;
  return cachedAuthHeader;
}
function makeVidifyEmbed(id, rank = 100) {
  const serverIndex = VIDIFY_SERVERS$1.indexOf(id) + 1;
  return makeEmbed({
    id: `vidify-${id}`,
    name: `${id.charAt(0).toUpperCase() + id.slice(1)}`,
    rank,
    disabled: true,
    flags: [],
    async scrape(ctx) {
      const query = JSON.parse(ctx.url);
      const { type, tmdbId, season, episode } = query;
      let url = `https://${baseUrl$i}/`;
      if (type === "movie") {
        url += `/movie/${tmdbId}?sr=${serverIndex}`;
      } else if (type === "show") {
        url += `/tv/${tmdbId}/season/${season}/episode/${episode}?sr=${serverIndex}`;
      } else {
        throw new NotFoundError("Unsupported media type");
      }
      const authHeader = await getAuthHeader(ctx);
      const headers2 = {
        referer: "https://player.vidify.top/",
        origin: "https://player.vidify.top",
        Authorization: authHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      };
      const res = await ctx.proxiedFetcher(url, { headers: headers2 });
      console.log(res);
      const playlistUrl = res.m3u8 ?? res.url;
      if (Array.isArray(res.result) && res.result.length > 0) {
        const qualities = {};
        res.result.forEach((r) => {
          if (r.url.includes(".mp4")) {
            qualities[`${r.resolution}p`] = { type: "mp4", url: decodeURIComponent(r.url) };
          }
        });
        if (Object.keys(qualities).length === 0) {
          throw new NotFoundError("No MP4 streams found");
        }
        console.log(`Found MP4 streams: `, qualities);
        return {
          stream: [
            {
              id: "primary",
              type: "file",
              qualities,
              flags: [],
              captions: [],
              headers: {
                Host: "proxy-worker.himanshu464121.workers.dev"
                // seems to be their only mp4 proxy
              }
            }
          ]
        };
      }
      if (!playlistUrl) throw new NotFoundError("No playlist URL found");
      const streamHeaders = { ...headers2 };
      let playlist;
      if (playlistUrl.includes("proxyv1.vidify.top")) {
        console.log(`Found stream (proxyv1): `, playlistUrl, streamHeaders);
        streamHeaders.Host = "proxyv1.vidify.top";
        playlist = decodeURIComponent(playlistUrl);
      } else if (playlistUrl.includes("proxyv2.vidify.top")) {
        console.log(`Found stream (proxyv2): `, playlistUrl, streamHeaders);
        streamHeaders.Host = "proxyv2.vidify.top";
        playlist = decodeURIComponent(playlistUrl);
      } else {
        console.log(`Found normal stream: `, playlistUrl);
        playlist = createM3U8ProxyUrl(decodeURIComponent(playlistUrl), ctx.features, streamHeaders);
      }
      ctx.progress(100);
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist,
            headers: streamHeaders,
            flags: [],
            captions: []
          }
        ]
      };
    }
  });
}
const vidifyEmbeds = VIDIFY_SERVERS$1.map((server, i) => makeVidifyEmbed(server, 230 - i));
const VIDNEST_SERVERS = ["hollymoviehd", "allmovies"];
const baseUrl$h = "https://second.vidnest.fun";
const PASSPHRASE = "A7kP9mQeXU2BWcD4fRZV+Sg8yN0/M5tLbC1HJQwYe6pOKFaE3vTnPZsRuYdVmLq2";
const serverConfigs = {
  hollymoviehd: {
    streamDomains: ["pkaystream.cc", "flashstream.cc"],
    origin: "https://flashstream.cc",
    referer: "https://flashstream.cc/"
  },
  allmovies: {
    streamDomains: null,
    origin: "",
    referer: ""
  }
};
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
async function decryptVidnestData(encryptedBase64) {
  const encryptedBytes = base64ToUint8Array(encryptedBase64);
  const iv2 = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12, -16);
  const tag = encryptedBytes.slice(-16);
  const keyData = base64ToUint8Array(PASSPHRASE).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["decrypt"]);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv2 }, cryptoKey, combined);
  return JSON.parse(new TextDecoder("utf-8").decode(decrypted));
}
function makeVidnestEmbed(id, rank = 100) {
  const config = serverConfigs[id];
  return makeEmbed({
    id: `vidnest-${id}`,
    name: `Vidnest ${id}`,
    rank,
    disabled: false,
    flags: [],
    async scrape(ctx) {
      const query = JSON.parse(ctx.url);
      const { type, tmdbId, season, episode } = query;
      const endpoint = type === "movie" ? `/${id}/movie/${tmdbId}` : `/${id}/tv/${tmdbId}/${season}/${episode}`;
      const res = await ctx.proxiedFetcher(endpoint, {
        baseUrl: baseUrl$h,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      if (!(res == null ? void 0 : res.data)) throw new NotFoundError("No data");
      const decrypted = await decryptVidnestData(res.data);
      const sources = decrypted.sources || decrypted.streams || [];
      const streams = [];
      for (const source of sources) {
        const url = source.file || source.url;
        if (!url) continue;
        if ((config == null ? void 0 : config.streamDomains) && !config.streamDomains.some((d) => url.includes(d))) continue;
        streams.push(url);
      }
      if (!streams.length) throw new NotFoundError("No streams");
      ctx.progress(100);
      return {
        stream: [
          {
            id,
            type: "hls",
            playlist: streams[0],
            headers: {
              Origin: config == null ? void 0 : config.origin,
              Referer: config == null ? void 0 : config.referer
            },
            flags: [],
            captions: []
          }
        ]
      };
    }
  });
}
const VidnestEmbeds = VIDNEST_SERVERS.map((server, i) => makeVidnestEmbed(server, 104 - i));
const providers = [
  {
    id: "server-13",
    rank: 112
  },
  {
    id: "server-18",
    rank: 111,
    flags: []
  },
  {
    id: "server-11",
    rank: 102
  },
  {
    id: "server-7",
    rank: 92
  },
  {
    id: "server-10",
    rank: 82
  },
  {
    id: "server-1",
    rank: 72
  },
  {
    id: "server-16",
    rank: 64
  },
  {
    id: "server-3",
    rank: 62
  },
  {
    id: "server-17",
    rank: 52
  },
  {
    id: "server-2",
    rank: 42
  },
  {
    id: "server-4",
    rank: 32
  },
  {
    id: "server-5",
    rank: 24
  },
  {
    id: "server-14",
    // catflix? uwu.m3u8
    rank: 22
  },
  {
    id: "server-6",
    rank: 21
  },
  {
    id: "server-15",
    rank: 20
  },
  {
    id: "server-8",
    rank: 19
  },
  {
    id: "server-9",
    rank: 18
  },
  {
    id: "server-19",
    rank: 17
  },
  {
    id: "server-12",
    rank: 16
  }
  // { // Looks like this was removed
  //   id: 'server-20',
  //   rank: 1,
  //   name: 'Cineby',
  // },
];
function embed(provider) {
  return makeEmbed({
    id: provider.id,
    name: provider.name || provider.id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    // disabled: provider.disabled,
    disabled: true,
    rank: provider.rank,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: ctx.url,
            flags: [flags.CORS_ALLOWED],
            captions: []
          }
        ]
      };
    }
  });
}
const [
  VidsrcsuServer1Scraper,
  VidsrcsuServer2Scraper,
  VidsrcsuServer3Scraper,
  VidsrcsuServer4Scraper,
  VidsrcsuServer5Scraper,
  VidsrcsuServer6Scraper,
  VidsrcsuServer7Scraper,
  VidsrcsuServer8Scraper,
  VidsrcsuServer9Scraper,
  VidsrcsuServer10Scraper,
  VidsrcsuServer11Scraper,
  VidsrcsuServer12Scraper,
  VidsrcsuServer20Scraper
] = providers.map(embed);
const viperScraper = makeEmbed({
  id: "viper",
  name: "Viper",
  rank: 182,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    const apiResponse = await ctx.proxiedFetcher.full(ctx.url, {
      headers: {
        Accept: "application/json",
        Referer: "https://embed.su/"
      }
    });
    if (!apiResponse.body.source) {
      throw new NotFoundError("No source found");
    }
    const playlistUrl = apiResponse.body.source.replace(/^.*\/viper\//, "https://");
    const headers2 = {
      referer: "https://megacloud.store/",
      origin: "https://megacloud.store"
    };
    return {
      stream: [
        {
          type: "hls",
          id: "primary",
          playlist: createM3U8ProxyUrl(playlistUrl, ctx.features, headers2),
          headers: headers2,
          flags: [flags.CORS_ALLOWED],
          captions: []
        }
      ]
    };
  }
});
const userAgent$1 = "Mozilla/5.0 (Linux; Android 11; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
function cleanSymbols(s) {
  let result = s;
  for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) {
    result = result.replaceAll(p, "_");
  }
  return result;
}
function cleanUnderscores(s) {
  return s.replace(/_/g, "");
}
function shiftBack(s, n) {
  return Array.from(s).map((c) => String.fromCharCode(c.charCodeAt(0) - n)).join("");
}
function rot13(str) {
  return str.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
}
const voeScraper = makeEmbed({
  id: "voe",
  name: "Voe",
  rank: 180,
  flags: [flags.IP_LOCKED],
  async scrape(ctx) {
    const url = ctx.url;
    const defaultDomain = (() => {
      try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}/`;
      } catch {
        return void 0;
      }
    })();
    const headers2 = {
      "User-Agent": userAgent$1
    };
    if (defaultDomain) {
      headers2.Referer = defaultDomain;
    }
    let html = await ctx.proxiedFetcher(url, { headers: headers2 });
    if (html.includes("Redirecting...")) {
      const match = html.match(/href\s*=\s*'(.*?)';/);
      if (!match) throw new NotFoundError("Redirect target not found");
      const redirectUrl = match[1];
      html = await ctx.proxiedFetcher(redirectUrl, { headers: headers2 });
    }
    const jsonScriptMatch = html.match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!jsonScriptMatch) throw new NotFoundError("Obfuscated script not found");
    const obfuscatedScript = jsonScriptMatch[1];
    const encodedMatch = obfuscatedScript.match(/\["(.*?)"\]/);
    if (!encodedMatch) throw new NotFoundError("Encoded data not found");
    const encodedData = encodedMatch[1];
    let decoded = rot13(encodedData);
    decoded = cleanSymbols(decoded);
    decoded = cleanUnderscores(decoded);
    decoded = Buffer.from(decoded, "base64").toString("utf-8");
    decoded = shiftBack(decoded, 3);
    decoded = decoded.split("").reverse().join("");
    decoded = Buffer.from(decoded, "base64").toString("utf-8");
    const json = JSON.parse(decoded);
    const videoUrl = json == null ? void 0 : json.source;
    if (!videoUrl) throw new NotFoundError("No video URL found");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: videoUrl,
          flags: [flags.IP_LOCKED],
          captions: [],
          headers: {
            Referer: defaultDomain || url,
            Origin: (defaultDomain == null ? void 0 : defaultDomain.replace(/\/$/, "")) || new URL(url).origin,
            "User-Agent": userAgent$1
          }
        }
      ]
    };
  }
});
async function getVideowlUrlStream(ctx, decryptedId) {
  var _a;
  const sharePage = await ctx.proxiedFetcher("https://cloud.mail.ru/public/uaRH/2PYWcJRpH");
  const regex = /"videowl_view":\{"count":"(\d+)","url":"([^"]+)"\}/g;
  const videowlUrl = (_a = regex.exec(sharePage)) == null ? void 0 : _a[2];
  if (!videowlUrl) throw new NotFoundError("Failed to get videoOwlUrl");
  return `${videowlUrl}/0p/${btoa(decryptedId)}.m3u8?${new URLSearchParams({
    double_encode: "1"
  })}`;
}
const warezcdnembedHlsScraper = makeEmbed({
  id: "warezcdnembedhls",
  // WarezCDN is both a source and an embed host
  name: "WarezCDN HLS",
  // method no longer works
  disabled: true,
  rank: 83,
  flags: [flags.IP_LOCKED],
  async scrape(ctx) {
    const decryptedId = await getDecryptedId(ctx);
    if (!decryptedId) throw new NotFoundError("can't get file id");
    const streamUrl = await getVideowlUrlStream(ctx, decryptedId);
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          flags: [flags.IP_LOCKED],
          captions: [],
          playlist: streamUrl
        }
      ]
    };
  }
});
const warezPlayerScraper = makeEmbed({
  id: "warezplayer",
  name: "warezPLAYER",
  disabled: true,
  rank: 85,
  flags: [],
  async scrape(ctx) {
    const playerPageUrl = new URL(ctx.url);
    const hash = playerPageUrl.pathname.split("/")[2];
    const playerApiRes = await ctx.proxiedFetcher("/player/index.php", {
      baseUrl: playerPageUrl.origin,
      query: {
        data: hash,
        do: "getVideo"
      },
      method: "POST",
      body: new URLSearchParams({
        hash
      }),
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const sources = JSON.parse(playerApiRes);
    if (!sources.videoSource) throw new Error("Playlist not found");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          flags: [],
          captions: [],
          playlist: sources.videoSource,
          headers: {
            // without this it returns "security error"
            Accept: "*/*"
          }
        }
      ]
    };
  }
});
const ZUNIME_SERVERS = ["hd-2", "miko", "shiro", "zaza"];
const baseUrl$g = "https://backend.xaiby.sbs";
const headers$5 = {
  referer: "https://vidnest.fun/",
  origin: "https://vidnest.fun",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
};
function makeZunimeEmbed(id, rank = 100) {
  return makeEmbed({
    id: `zunime-${id}`,
    name: `Zunime ${id.charAt(0).toUpperCase() + id.slice(1)}`,
    rank,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      var _a, _b;
      const serverName = id;
      const query = JSON.parse(ctx.url);
      const { anilistId, episode } = query;
      const res = await ctx.proxiedFetcher(`${"/sources"}`, {
        baseUrl: baseUrl$g,
        headers: headers$5,
        query: {
          id: String(anilistId),
          ep: String(episode ?? 1),
          host: serverName,
          type: "dub"
        }
      });
      console.log(res);
      const resAny = res;
      if (!(resAny == null ? void 0 : resAny.success) || !((_a = resAny == null ? void 0 : resAny.sources) == null ? void 0 : _a.url)) {
        throw new NotFoundError("No stream URL found in response");
      }
      const streamUrl = resAny.sources.url;
      const upstreamHeaders = ((_b = resAny == null ? void 0 : resAny.sources) == null ? void 0 : _b.headers) && Object.keys(resAny.sources.headers).length > 0 ? resAny.sources.headers : headers$5;
      ctx.progress(100);
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: `https://proxy-2.madaraverse.online/proxy?url=${encodeURIComponent(streamUrl)}`,
            headers: upstreamHeaders,
            flags: [],
            captions: []
          }
        ]
      };
    }
  });
}
const zunimeEmbeds = ZUNIME_SERVERS.map((server, i) => makeZunimeEmbed(server, 260 - i));
async function getStream$2(ctx, id) {
  var _a, _b;
  try {
    const baseUrl2 = "https://ftmoh345xme.com";
    const headers2 = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1"
    };
    const url = `${baseUrl2}/play/${id}`;
    const result = await ctx.proxiedFetcher(url, {
      headers: {
        ...headers2
      },
      method: "GET"
    });
    const $ = cheerio.load(result);
    const script = $("script").last().html();
    if (!script) {
      throw new NotFoundError("Failed to extract script data");
    }
    const content = ((_a = script.match(/(\{[^;]+});/)) == null ? void 0 : _a[1]) || ((_b = script.match(/\((\{.*\})\)/)) == null ? void 0 : _b[1]);
    if (!content) {
      throw new NotFoundError("Media not found");
    }
    const data = JSON.parse(content);
    let file = data.file;
    if (!file) {
      throw new NotFoundError("File not found");
    }
    if (file.startsWith("/")) {
      file = baseUrl2 + file;
    }
    const key2 = data.key;
    const headers22 = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1",
      "X-Csrf-Token": key2
    };
    const PlayListRes = await ctx.proxiedFetcher(file, {
      headers: {
        ...headers22
      },
      method: "GET"
    });
    const playlist = PlayListRes;
    return {
      success: true,
      data: {
        playlist,
        key: key2
      }
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch media info");
  }
}
async function getStream$1(ctx, file, key2) {
  const f = file;
  const path = `${f.slice(1)}.txt`;
  try {
    const baseUrl2 = "https://ftmoh345xme.com";
    const headers2 = {
      Origin: "https://friness-cherlormur-i-275.site",
      Referer: "https://google.com/",
      Dnt: "1",
      "X-Csrf-Token": key2
    };
    const url = `${baseUrl2}/playlist/${path}`;
    const result = await ctx.proxiedFetcher(url, {
      headers: {
        ...headers2
      },
      method: "GET"
    });
    return {
      success: true,
      data: {
        link: result
      }
    };
  } catch (error) {
    throw new NotFoundError("Failed to fetch stream data");
  }
}
async function getMovie(ctx, id, lang = "English") {
  var _a, _b;
  try {
    const mediaInfo = await getStream$2(ctx, id);
    if (mediaInfo == null ? void 0 : mediaInfo.success) {
      const playlist = (_a = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _a.playlist;
      if (!playlist || !Array.isArray(playlist)) {
        throw new NotFoundError("Playlist not found or invalid");
      }
      let file = playlist.find((item) => (item == null ? void 0 : item.title) === lang);
      if (!file) {
        file = playlist == null ? void 0 : playlist[0];
      }
      if (!file) {
        throw new NotFoundError("No file found");
      }
      const availableLang = playlist.map((item) => item == null ? void 0 : item.title);
      const key2 = (_b = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _b.key;
      ctx.progress(70);
      const streamUrl = await getStream$1(ctx, file == null ? void 0 : file.file, key2);
      if (streamUrl == null ? void 0 : streamUrl.success) {
        return { success: true, data: streamUrl == null ? void 0 : streamUrl.data, availableLang };
      }
      throw new NotFoundError("No stream url found");
    }
    throw new NotFoundError("No media info found");
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch movie data");
  }
}
async function getTV(ctx, id, season, episode, lang) {
  var _a, _b, _c;
  try {
    const mediaInfo = await getStream$2(ctx, id);
    if (!(mediaInfo == null ? void 0 : mediaInfo.success)) {
      throw new NotFoundError("No media info found");
    }
    const playlist = (_a = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _a.playlist;
    const getSeason = playlist.find((item) => (item == null ? void 0 : item.id) === season.toString());
    if (!getSeason) {
      throw new NotFoundError("No season found");
    }
    const getEpisode = getSeason == null ? void 0 : getSeason.folder.find((item) => (item == null ? void 0 : item.episode) === episode.toString());
    if (!getEpisode) {
      throw new NotFoundError("No episode found");
    }
    let file = getEpisode == null ? void 0 : getEpisode.folder.find((item) => (item == null ? void 0 : item.title) === lang);
    if (!file) {
      file = (_b = getEpisode == null ? void 0 : getEpisode.folder) == null ? void 0 : _b[0];
    }
    if (!file) {
      throw new NotFoundError("No file found");
    }
    const availableLang = getEpisode == null ? void 0 : getEpisode.folder.map((item) => {
      return item == null ? void 0 : item.title;
    });
    const filterLang = availableLang.filter((item) => (item == null ? void 0 : item.length) > 0);
    const key2 = (_c = mediaInfo == null ? void 0 : mediaInfo.data) == null ? void 0 : _c.key;
    ctx.progress(70);
    const streamUrl = await getStream$1(ctx, file == null ? void 0 : file.file, key2);
    if (streamUrl == null ? void 0 : streamUrl.success) {
      return {
        success: true,
        data: streamUrl == null ? void 0 : streamUrl.data,
        availableLang: filterLang
      };
    }
    throw new NotFoundError("No stream url found");
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to fetch TV data");
  }
}
async function comboScraper$n(ctx) {
  ({
    title: ctx.media.title,
    releaseYear: ctx.media.releaseYear,
    tmdbId: ctx.media.tmdbId,
    imdbId: ctx.media.imdbId,
    type: ctx.media.type
  });
  if (ctx.media.type === "show") {
    ctx.media.season.number.toString();
    ctx.media.episode.number.toString();
  }
  if (ctx.media.type === "movie") {
    ctx.progress(40);
    const res = await getMovie(ctx, ctx.media.imdbId);
    if (res == null ? void 0 : res.success) {
      ctx.progress(90);
      return {
        embeds: [],
        stream: [
          {
            id: "primary",
            captions: [],
            playlist: res.data.link,
            type: "hls",
            flags: [flags.CORS_ALLOWED]
          }
        ]
      };
    }
    throw new NotFoundError("No providers available");
  }
  if (ctx.media.type === "show") {
    ctx.progress(40);
    const lang = "English";
    const res = await getTV(ctx, ctx.media.imdbId, ctx.media.season.number, ctx.media.episode.number, lang);
    if (res == null ? void 0 : res.success) {
      ctx.progress(90);
      return {
        embeds: [],
        stream: [
          {
            id: "primary",
            captions: [],
            playlist: res.data.link,
            type: "hls",
            flags: [flags.CORS_ALLOWED]
          }
        ]
      };
    }
    throw new NotFoundError("No providers available");
  }
  throw new NotFoundError("No providers available");
}
const EightStreamScraper = makeSourcerer({
  id: "8stream",
  name: "8stream",
  rank: 111,
  flags: [],
  disabled: true,
  scrapeMovie: comboScraper$n,
  scrapeShow: comboScraper$n
});
const baseUrl$f = "https://www3.animeflv.net";
async function searchAnimeFlv(ctx, title) {
  const searchUrl = `${baseUrl$f}/browse?q=${encodeURIComponent(title)}`;
  const html = await ctx.proxiedFetcher(searchUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const $ = load(html);
  const results = $("div.Container ul.ListAnimes li article");
  if (!results.length) throw new NotFoundError("No se encontró el anime en AnimeFLV");
  let animeUrl = "";
  results.each((_, el) => {
    const resultTitle = $(el).find("a h3").text().trim().toLowerCase();
    if (resultTitle === title.trim().toLowerCase()) {
      animeUrl = $(el).find("div.Description a.Button").attr("href") || "";
      return false;
    }
  });
  if (!animeUrl) {
    animeUrl = results.first().find("div.Description a.Button").attr("href") || "";
  }
  if (!animeUrl) throw new NotFoundError("No se encontró el anime en AnimeFLV");
  const fullUrl = animeUrl.startsWith("http") ? animeUrl : `${baseUrl$f}${animeUrl}`;
  return fullUrl;
}
async function getEpisodes(ctx, animeUrl) {
  const html = await ctx.proxiedFetcher(animeUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const $ = load(html);
  let episodes = [];
  $("script").each((_, script) => {
    var _a, _b, _c;
    const data = $(script).html() || "";
    if (data.includes("var anime_info =")) {
      const animeInfo = (_a = data.split("var anime_info = [")[1]) == null ? void 0 : _a.split("];")[0];
      const animeUri = (_b = animeInfo == null ? void 0 : animeInfo.split(",")[2]) == null ? void 0 : _b.replace(/"/g, "").trim();
      const episodesRaw = (_c = data.split("var episodes = [")[1]) == null ? void 0 : _c.split("];")[0];
      if (animeUri && episodesRaw) {
        const arrEpisodes = episodesRaw.split("],[");
        episodes = arrEpisodes.map((arrEp) => {
          const noEpisode = arrEp.replace("[", "").replace("]", "").split(",")[0];
          return {
            number: parseInt(noEpisode, 10),
            url: `${baseUrl$f}/ver/${animeUri}-${noEpisode}`
          };
        });
      } else {
        console.log("[AnimeFLV] No se encontró animeUri o lista de episodios en el script");
      }
    }
  });
  if (episodes.length === 0) {
    console.log("[AnimeFLV] No se encontraron episodios");
  }
  return episodes;
}
async function getEmbeds$1(ctx, episodeUrl) {
  const html = await ctx.proxiedFetcher(episodeUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const $ = load(html);
  const script = $('script:contains("var videos =")').html();
  if (!script) return {};
  const match = script.match(/var videos = (\{[\s\S]*?\});/);
  if (!match) return {};
  let videos = {};
  try {
    videos = JSON.parse(match[1]);
  } catch {
    return {};
  }
  let streamwishJapanese;
  if (videos.SUB) {
    const sw = videos.SUB.find((s) => {
      var _a;
      return ((_a = s.title) == null ? void 0 : _a.toLowerCase()) === "sw";
    });
    if (sw && (sw.url || sw.code)) {
      streamwishJapanese = sw.url || sw.code;
      if (streamwishJapanese && streamwishJapanese.startsWith("/e/")) {
        streamwishJapanese = `https://streamwish.to${streamwishJapanese}`;
      }
    }
  }
  let streamtapeLatino;
  if (videos.LAT) {
    const stape = videos.LAT.find(
      (s) => {
        var _a, _b;
        return ((_a = s.title) == null ? void 0 : _a.toLowerCase()) === "stape" || ((_b = s.title) == null ? void 0 : _b.toLowerCase()) === "streamtape";
      }
    );
    if (stape && (stape.url || stape.code)) {
      streamtapeLatino = stape.url || stape.code;
      if (streamtapeLatino && streamtapeLatino.startsWith("/e/")) {
        streamtapeLatino = `https://streamtape.com${streamtapeLatino}`;
      }
    }
  }
  return {
    "streamwish-japanese": streamwishJapanese,
    "streamtape-latino": streamtapeLatino
  };
}
async function comboScraper$m(ctx) {
  var _a;
  const title = ctx.media.title;
  if (!title) throw new NotFoundError("Falta el título");
  console.log(`[AnimeFLV] Iniciando scraping para: ${title}`);
  const animeUrl = await searchAnimeFlv(ctx, title);
  let episodeUrl = animeUrl;
  if (ctx.media.type === "show") {
    const episode = (_a = ctx.media.episode) == null ? void 0 : _a.number;
    if (!episode) throw new NotFoundError("Faltan datos de episodio");
    const episodes = await getEpisodes(ctx, animeUrl);
    const ep = episodes.find((e) => e.number === episode);
    if (!ep) throw new NotFoundError(`No se encontró el episodio ${episode}`);
    episodeUrl = ep.url;
  } else if (ctx.media.type === "movie") {
    const html = await ctx.proxiedFetcher(animeUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const $ = load(html);
    let animeUri = null;
    $("script").each((_, script) => {
      var _a2, _b;
      const data = $(script).html() || "";
      if (data.includes("var anime_info =")) {
        const animeInfo = (_a2 = data.split("var anime_info = [")[1]) == null ? void 0 : _a2.split("];")[0];
        animeUri = ((_b = animeInfo == null ? void 0 : animeInfo.split(",")[2]) == null ? void 0 : _b.replace(/"/g, "").trim()) || null;
      }
    });
    if (!animeUri) throw new NotFoundError("No se pudo obtener el animeUri para la película");
    episodeUrl = `${baseUrl$f}/ver/${animeUri}-1`;
  }
  const embedsObj = await getEmbeds$1(ctx, episodeUrl);
  const filteredEmbeds = Object.entries(embedsObj).filter(([, url]) => typeof url === "string" && !!url).map(([embedId, url]) => ({ embedId, url }));
  if (filteredEmbeds.length === 0) {
    throw new NotFoundError("No se encontraron streams válidos");
  }
  return { embeds: filteredEmbeds };
}
const animeflvScraper = makeSourcerer({
  id: "animeflv",
  name: "AnimeFLV",
  rank: 90,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeShow: comboScraper$m,
  scrapeMovie: comboScraper$m
});
const cache = /* @__PURE__ */ new Map();
function normalizeTitle$4(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function matchesType(mediaType, anilist) {
  if (mediaType === "show") {
    return ["TV", "TV_SHORT", "OVA", "ONA", "SPECIAL"].includes(anilist.format);
  }
  return anilist.format === "MOVIE";
}
const anilistQuery = `
query ($search: String, $type: MediaType) {
  Page(page: 1, perPage: 20) {
    media(search: $search, type: $type, sort: POPULARITY_DESC) {
      id
      type
      format
      seasonYear
      title {
        romaji
        english
        native
      }
    }
  }
}
`;
async function getAnilistIdFromMedia(ctx, media) {
  var _a, _b, _c;
  const key2 = `${media.type}:${media.title}:${media.releaseYear}`;
  const cached = cache.get(key2);
  if (cached) return cached;
  const res = await ctx.proxiedFetcher("", {
    baseUrl: "https://graphql.anilist.co",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query: anilistQuery,
      variables: {
        search: media.title,
        type: "ANIME"
      }
    })
  });
  const items = ((_b = (_a = res.data) == null ? void 0 : _a.Page) == null ? void 0 : _b.media) ?? [];
  if (!items.length) {
    throw new Error("AniList id not found");
  }
  const targetTitle = normalizeTitle$4(media.title);
  const scored = items.filter((it) => matchesType(media.type, it)).map((it) => {
    const titles = [it.title.romaji];
    if (it.title.english) titles.push(it.title.english);
    if (it.title.native) titles.push(it.title.native);
    const normTitles = titles.map(normalizeTitle$4).filter(Boolean);
    const exact = normTitles.includes(targetTitle);
    const partial = normTitles.some((t) => t.includes(targetTitle) || targetTitle.includes(t));
    const yearDelta = it.seasonYear ? Math.abs(it.seasonYear - media.releaseYear) : 5;
    let score = 0;
    if (exact) score += 100;
    else if (partial) score += 50;
    score += Math.max(0, 20 - yearDelta * 4);
    return { it, score };
  }).sort((a, b) => b.score - a.score);
  const winner = ((_c = scored[0]) == null ? void 0 : _c.it) ?? items[0];
  const anilistId = winner == null ? void 0 : winner.id;
  if (!anilistId) throw new Error("AniList id not found");
  cache.set(key2, anilistId);
  return anilistId;
}
const anilistTitlesQuery = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    title {
      romaji
      english
      native
    }
    synonyms
  }
}
`;
async function getAnilistEnglishTitle(ctx, media) {
  const id = await getAnilistIdFromMedia(ctx, media);
  const res = await ctx.proxiedFetcher("", {
    baseUrl: "https://graphql.anilist.co",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query: anilistTitlesQuery,
      variables: {
        id
      }
    })
  });
  const englishTitle = res.data.Media.title.english;
  return englishTitle ? englishTitle.toLowerCase() : null;
}
async function comboScraper$l(ctx) {
  const anilistId = await getAnilistIdFromMedia(ctx, ctx.media);
  const query = {
    type: ctx.media.type,
    title: ctx.media.title,
    tmdbId: ctx.media.tmdbId,
    imdbId: ctx.media.imdbId,
    anilistId,
    ...ctx.media.type === "show" && {
      season: ctx.media.season.number,
      episode: ctx.media.episode.number
    },
    ...ctx.media.type === "movie" && { episode: 1 },
    releaseYear: ctx.media.releaseYear
  };
  return {
    embeds: [
      {
        embedId: "animetsu-pahe",
        url: JSON.stringify(query)
      },
      {
        embedId: "animetsu-zoro",
        url: JSON.stringify(query)
      },
      {
        embedId: "animetsu-zaza",
        url: JSON.stringify(query)
      },
      {
        embedId: "animetsu-meg",
        url: JSON.stringify(query)
      },
      {
        embedId: "animetsu-bato",
        url: JSON.stringify(query)
      }
    ]
  };
}
const animetsuScraper = makeSourcerer({
  id: "animetsu",
  name: "Animetsu",
  rank: 112,
  flags: [],
  scrapeShow: comboScraper$l
});
const baseUrl$e = "https://cinehdplus.gratis";
async function comboScraper$k(ctx) {
  const searchUrl = `${baseUrl$e}/series/?story=${ctx.media.tmdbId}&do=search&subaction=search`;
  const searchPage = await ctx.proxiedFetcher(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Referer: baseUrl$e
    }
  });
  const $search = load(searchPage);
  const seriesUrl = $search(".card__title a[href]:first").attr("href");
  if (!seriesUrl) {
    throw new NotFoundError("Series not found in search results");
  }
  ctx.progress(30);
  const seriesPageUrl = new URL(seriesUrl, baseUrl$e);
  const seriesPage = await ctx.proxiedFetcher(seriesPageUrl.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Referer: baseUrl$e
    }
  });
  const $ = load(seriesPage);
  const episodeSelector = `[data-num="${ctx.media.season.number}x${ctx.media.episode.number}"]`;
  const mirrorUrls = $(episodeSelector).siblings(".mirrors").children("[data-link]").map((_, el) => $(el).attr("data-link")).get().filter(Boolean).filter((link) => !link.match(/cinehdplus/)).map((link) => {
    const url = link.startsWith("http") ? link : `https://${link}`;
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }).filter((url) => url !== null && url.hostname !== "cinehdplus.gratis");
  if (!mirrorUrls.length) {
    throw new NotFoundError("No streaming links found for this episode");
  }
  ctx.progress(70);
  const embeds = mirrorUrls.map((url) => {
    let embedId;
    if (url.hostname.includes("supervideo")) {
      embedId = "supervideo";
    } else if (url.hostname.includes("dropload")) {
      embedId = "dropload";
    } else {
      return null;
    }
    return {
      embedId,
      url: url.href
    };
  }).filter((embed2) => embed2 !== null);
  ctx.progress(90);
  return {
    embeds
  };
}
const cinehdplusScraper = makeSourcerer({
  id: "cinehdplus",
  name: "CineHDPlus (Latino)",
  rank: 4,
  disabled: false,
  flags: [],
  scrapeShow: comboScraper$k
});
const baseUrl$d = "https://api.coitus.ca";
async function comboScraper$j(ctx) {
  const apiUrl2 = ctx.media.type === "movie" ? `${baseUrl$d}/movie/${ctx.media.tmdbId}` : `${baseUrl$d}/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2);
  if (!apiRes.videoSource) throw new NotFoundError("No watchable item found");
  let processedUrl = apiRes.videoSource;
  let streamHeaders = {};
  if (processedUrl.includes("orbitproxy")) {
    try {
      const urlParts = processedUrl.split(/orbitproxy\.[^/]+\//);
      if (urlParts.length >= 2) {
        const encryptedPart = urlParts[1].split(".m3u8")[0];
        try {
          const decodedData = Buffer.from(encryptedPart, "base64").toString("utf-8");
          const jsonData = JSON.parse(decodedData);
          const originalUrl = jsonData.u;
          const referer2 = jsonData.r || "";
          streamHeaders = { referer: referer2 };
          processedUrl = createM3U8ProxyUrl(originalUrl, ctx.features, streamHeaders);
        } catch (jsonError) {
          console.error("Error decoding/parsing orbitproxy data:", jsonError);
        }
      }
    } catch (error) {
      console.error("Error processing orbitproxy URL:", error);
    }
  }
  console.log(apiRes);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions: [],
        playlist: processedUrl,
        type: "hls",
        headers: streamHeaders,
        flags: [flags.CORS_ALLOWED]
      }
    ]
  };
}
const coitusScraper = makeSourcerer({
  id: "coitus",
  name: "Autoembed+",
  rank: 91,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$j,
  scrapeShow: comboScraper$j
});
const baseUrl$c = "https://www.cuevana3.eu";
function normalizeTitle$3(title) {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s-]/gi, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}
async function getStreamUrl(ctx, embedUrl) {
  try {
    const html = await ctx.proxiedFetcher(embedUrl);
    const match = html.match(/var url = '([^']+)'/);
    if (match) {
      return match[1];
    }
  } catch {
  }
  return null;
}
function validateStream(url) {
  return url.startsWith("https://") && (url.includes("streamwish") || url.includes("filemoon") || url.includes("vidhide"));
}
async function extractVideos(ctx, videos) {
  const videoList = [];
  for (const [lang, videoArray] of Object.entries(videos)) {
    if (!videoArray) continue;
    for (const video of videoArray) {
      if (!video.result) continue;
      const realUrl = await getStreamUrl(ctx, video.result);
      if (!realUrl || !validateStream(realUrl)) continue;
      let embedId = "";
      if (realUrl.includes("filemoon")) embedId = "filemoon";
      else if (realUrl.includes("streamwish")) {
        if (lang === "latino") embedId = "streamwish-latino";
        else if (lang === "spanish") embedId = "streamwish-spanish";
        else if (lang === "english") embedId = "streamwish-english";
        else embedId = "streamwish-latino";
      } else if (realUrl.includes("vidhide")) embedId = "vidhide";
      else if (realUrl.includes("voe")) embedId = "voe";
      else continue;
      videoList.push({
        embedId,
        url: realUrl
      });
    }
  }
  return videoList;
}
async function comboScraper$i(ctx) {
  var _a, _b, _c, _d;
  const mediaType = ctx.media.type;
  const tmdbId = ctx.media.tmdbId;
  if (!tmdbId) {
    throw new NotFoundError("TMDB ID is required to fetch the title in Spanish");
  }
  const translatedTitle = await fetchTMDBName(ctx, "es-ES");
  let normalizedTitle = normalizeTitle$3(translatedTitle);
  let pageUrl = mediaType === "movie" ? `${baseUrl$c}/ver-pelicula/${normalizedTitle}` : `${baseUrl$c}/episodio/${normalizedTitle}-temporada-${(_a = ctx.media.season) == null ? void 0 : _a.number}-episodio-${(_b = ctx.media.episode) == null ? void 0 : _b.number}`;
  ctx.progress(60);
  let pageContent = await ctx.proxiedFetcher(pageUrl);
  let $ = load(pageContent);
  let script = $("script").toArray().find((scriptEl) => {
    var _a2;
    const content = ((_a2 = scriptEl.children[0]) == null ? void 0 : _a2.data) || "";
    return content.includes('{"props":{"pageProps":');
  });
  let embeds = [];
  if (script) {
    let jsonData;
    try {
      const jsonString = script.children[0].data;
      const start = jsonString.indexOf('{"props":{"pageProps":');
      if (start === -1) throw new Error("No valid JSON start found");
      const partialJson = jsonString.slice(start);
      jsonData = JSON.parse(partialJson);
    } catch (error) {
      throw new NotFoundError(`Failed to parse JSON: ${error.message}`);
    }
    if (mediaType === "movie") {
      const movieData = jsonData.props.pageProps.thisMovie;
      if (movieData == null ? void 0 : movieData.videos) {
        embeds = await extractVideos(ctx, movieData.videos) ?? [];
      }
    } else {
      const episodeData = jsonData.props.pageProps.episode;
      if (episodeData == null ? void 0 : episodeData.videos) {
        embeds = await extractVideos(ctx, episodeData.videos) ?? [];
      }
    }
  }
  if (embeds.length === 0) {
    normalizedTitle = normalizeTitle$3(ctx.media.title);
    pageUrl = mediaType === "movie" ? `${baseUrl$c}/ver-pelicula/${normalizedTitle}` : `${baseUrl$c}/episodio/${normalizedTitle}-temporada-${(_c = ctx.media.season) == null ? void 0 : _c.number}-episodio-${(_d = ctx.media.episode) == null ? void 0 : _d.number}`;
    pageContent = await ctx.proxiedFetcher(pageUrl);
    $ = load(pageContent);
    script = $("script").toArray().find((scriptEl) => {
      var _a2;
      const content = ((_a2 = scriptEl.children[0]) == null ? void 0 : _a2.data) || "";
      return content.includes('{"props":{"pageProps":');
    });
    if (script) {
      let jsonData;
      try {
        const jsonString = script.children[0].data;
        const start = jsonString.indexOf('{"props":{"pageProps":');
        if (start === -1) throw new Error("No valid JSON start found");
        const partialJson = jsonString.slice(start);
        jsonData = JSON.parse(partialJson);
      } catch (error) {
        throw new NotFoundError(`Failed to parse JSON: ${error.message}`);
      }
      if (mediaType === "movie") {
        const movieData = jsonData.props.pageProps.thisMovie;
        if (movieData == null ? void 0 : movieData.videos) {
          embeds = await extractVideos(ctx, movieData.videos) ?? [];
        }
      } else {
        const episodeData = jsonData.props.pageProps.episode;
        if (episodeData == null ? void 0 : episodeData.videos) {
          embeds = await extractVideos(ctx, episodeData.videos) ?? [];
        }
      }
    }
  }
  if (embeds.length === 0) {
    throw new NotFoundError("No valid streams found");
  }
  return { embeds };
}
const cuevana3Scraper = makeSourcerer({
  id: "cuevana3",
  name: "Cuevana3",
  rank: 80,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$i,
  scrapeShow: comboScraper$i
});
async function getAddonStreams(addonUrl, ctx) {
  if (!ctx.media.imdbId) {
    throw new Error("Error: ctx.media.imdbId is required.");
  }
  let addonResponse;
  if (ctx.media.type === "show") {
    addonResponse = await ctx.proxiedFetcher(
      `${addonUrl}/stream/series/${ctx.media.imdbId}:${ctx.media.season.number}:${ctx.media.episode.number}.json`
    );
  } else {
    addonResponse = await ctx.proxiedFetcher(`${addonUrl}/stream/movie/${ctx.media.imdbId}.json`);
  }
  if (!addonResponse) {
    throw new Error("Error: addon did not respond");
  }
  return addonResponse;
}
async function parseStreamData(streams, ctx) {
  return ctx.proxiedFetcher("https://torrent-parse.pstream.mov", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(streams)
  });
}
async function getCometStreams(token, debridProvider, ctx) {
  const cometBaseUrl = "https://comet.elfhosted.com";
  const cometConfig = btoa(
    JSON.stringify({
      maxResultsPerResolution: 0,
      maxSize: 0,
      cachedOnly: false,
      removeTrash: true,
      resultFormat: ["all"],
      debridService: debridProvider,
      debridApiKey: token,
      debridStreamProxyPassword: "",
      languages: { exclude: [], preferred: ["en"] },
      resolutions: {},
      options: { remove_ranks_under: -1e10, allow_english_in_languages: false, remove_unknown_languages: false }
    })
  );
  const cometStreamsRaw = (await getAddonStreams(`${cometBaseUrl}/${cometConfig}`, ctx)).streams;
  const newStreams = [];
  for (let i = 0; i < cometStreamsRaw.length; i++) {
    if (cometStreamsRaw[i].description !== void 0)
      newStreams.push({
        title: cometStreamsRaw[i].description.replace(/\n/g, ""),
        url: cometStreamsRaw[i].url
      });
  }
  const parsedData = await parseStreamData(newStreams, ctx);
  return parsedData;
}
const OVERRIDE_TOKEN = "";
const OVERRIDE_SERVICE = "";
const getDebridToken = () => {
  var _a;
  try {
    if (OVERRIDE_TOKEN) ;
  } catch {
  }
  try {
    if (typeof window === "undefined") return null;
    const prefData = window.localStorage.getItem("__MW::preferences");
    if (!prefData) return null;
    const parsedAuth = JSON.parse(prefData);
    return ((_a = parsedAuth == null ? void 0 : parsedAuth.state) == null ? void 0 : _a.debridToken) || null;
  } catch (e) {
    console.error("Error getting debrid token:", e);
    return null;
  }
};
const getDebridService = () => {
  var _a;
  try {
    if (OVERRIDE_SERVICE) ;
  } catch {
  }
  try {
    if (typeof window === "undefined") return "real-debrid";
    const prefData = window.localStorage.getItem("__MW::preferences");
    if (!prefData) return "real-debrid";
    const parsedPrefs = JSON.parse(prefData);
    const saved = (_a = parsedPrefs == null ? void 0 : parsedPrefs.state) == null ? void 0 : _a.debridService;
    if (saved === "realdebrid" || !saved) return "real-debrid";
    return saved;
  } catch (e) {
    console.error("Error getting debrid service (defaulting to real-debrid):", e);
    return "real-debrid";
  }
};
function normalizeQuality(resolution) {
  if (!resolution) return "unknown";
  const res = resolution.toLowerCase();
  if (res === "4k" || res === "2160p") return "4k";
  if (res === "1080p") return 1080;
  if (res === "720p") return 720;
  if (res === "480p") return 480;
  if (res === "360p") return 360;
  return "unknown";
}
function scoreStream(stream) {
  let score = 0;
  if (stream.container === "mp4") score += 10;
  if (stream.audio === "aac") score += 5;
  if (stream.codec === "h265") score += 2;
  if (stream.container === "mkv") score -= 2;
  if (stream.complete) score += 1;
  return score;
}
async function comboScraper$h(ctx) {
  const apiKey = getDebridToken();
  if (!apiKey) {
    throw new NotFoundError("Debrid API token is required");
  }
  const debridProvider = getDebridService();
  const [torrentioResult, cometStreams] = await Promise.all([
    getAddonStreams(`https://torrentio.strem.fun/${debridProvider}=${apiKey}`, ctx),
    getCometStreams(apiKey, debridProvider, ctx).catch(() => {
      return [];
    })
  ]);
  ctx.progress(33);
  const torrentioStreams = await parseStreamData(
    torrentioResult.streams.map((s) => ({
      ...s,
      title: s.title ?? ""
    })),
    ctx
  );
  const allStreams = [...torrentioStreams, ...cometStreams];
  if (allStreams.length === 0) {
    console.log("No streams found from either source!");
    throw new NotFoundError("No streams found or parse failed!");
  }
  console.log(
    `Total streams: ${allStreams.length} (${torrentioStreams.length} from Torrentio, ${cometStreams.length} from Comet)`
  );
  ctx.progress(66);
  const qualities = {};
  const byQuality = {};
  for (const stream of allStreams) {
    const quality = normalizeQuality(stream.resolution);
    if (!byQuality[quality]) byQuality[quality] = [];
    byQuality[quality].push(stream);
  }
  for (const [quality, streams] of Object.entries(byQuality)) {
    const mp4Aac = streams.find((s) => s.container === "mp4" && s.audio === "aac");
    if (mp4Aac) {
      qualities[quality] = {
        type: "mp4",
        url: mp4Aac.url
      };
      continue;
    }
    const mp4 = streams.find((s) => s.container === "mp4");
    if (mp4) {
      qualities[quality] = {
        type: "mp4",
        url: mp4.url
      };
      continue;
    }
    streams.sort((a, b) => scoreStream(b) - scoreStream(a));
    const best = streams[0];
    if (best) {
      qualities[quality] = {
        type: "mp4",
        // has to be set as mp4 because of types..... But mkvs *can* work in a browser depending on codec, usually it cant be hevc and has to have AAC audio
        url: best.url
      };
    }
  }
  ctx.progress(100);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        qualities,
        captions: [],
        flags: []
      }
    ]
  };
}
const debridScraper = makeSourcerer({
  id: "debrid",
  name: "Debrid",
  rank: 450,
  disabled: !getDebridToken(),
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$h,
  scrapeShow: comboScraper$h
});
async function stringAtob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const str = input.replace(/=+$/, "");
  let output = "";
  if (str.length % 4 === 1) {
    throw new Error("The string to be decoded is not correctly encoded.");
  }
  for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
    const buffer = str.charAt(i);
    const charIndex = chars.indexOf(buffer);
    if (charIndex === -1) continue;
    bs = bc % 4 ? bs * 64 + charIndex : charIndex;
    if (bc++ % 4) {
      output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
    }
  }
  return output;
}
async function comboScraper$g(ctx) {
  const embedUrl = `https://embed.su/embed/${ctx.media.type === "movie" ? `movie/${ctx.media.tmdbId}` : `tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`}`;
  const embedPage = await ctx.proxiedFetcher(embedUrl, {
    headers: {
      Referer: "https://embed.su/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });
  const vConfigMatch = embedPage.match(/window\.vConfig\s*=\s*JSON\.parse\(atob\(`([^`]+)/i);
  const encodedConfig = vConfigMatch == null ? void 0 : vConfigMatch[1];
  if (!encodedConfig) throw new NotFoundError("No encoded config found");
  const decodedConfig = JSON.parse(await stringAtob(encodedConfig));
  if (!(decodedConfig == null ? void 0 : decodedConfig.hash)) throw new NotFoundError("No stream hash found");
  const firstDecode = (await stringAtob(decodedConfig.hash)).split(".").map((item) => item.split("").reverse().join(""));
  const secondDecode = JSON.parse(await stringAtob(firstDecode.join("").split("").reverse().join("")));
  if (!(secondDecode == null ? void 0 : secondDecode.length)) throw new NotFoundError("No servers found");
  ctx.progress(50);
  const embeds = secondDecode.map((server) => ({
    embedId: "viper",
    url: `https://embed.su/api/e/${server.hash}`
  }));
  ctx.progress(90);
  return { embeds };
}
const embedsuScraper = makeSourcerer({
  id: "embedsu",
  name: "embed.su",
  rank: 165,
  disabled: true,
  flags: [],
  scrapeMovie: comboScraper$g,
  scrapeShow: comboScraper$g
});
function rtt(str) {
  return str.replace(/[a-z]/gi, (c) => {
    return String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() < "n" ? 13 : -13));
  });
}
function decodeAtom(e) {
  const t = atob(e.split("").reverse().join(""));
  let o = "";
  for (let i = 0; i < t.length; i++) {
    const r = "K9L"[i % 3];
    const n = t.charCodeAt(i) - (r.charCodeAt(0) % 5 + 1);
    o += String.fromCharCode(n);
  }
  return atob(o);
}
function extractPackerParams(rawInput) {
  const regex = /'((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/;
  const match = regex.exec(rawInput);
  if (!match) {
    console.error("Could not parse parameters. Format is not as expected.");
    return null;
  }
  return {
    payload: match[1],
    radix: parseInt(match[2], 10),
    count: parseInt(match[3], 10),
    keywords: match[4].split("|")
  };
}
function decodeDeanEdwards(params) {
  const { payload, radix, count, keywords } = params;
  const dict = /* @__PURE__ */ Object.create(null);
  const encodeBase = (num) => {
    if (num < radix) {
      const char2 = num % radix;
      return char2 > 35 ? String.fromCharCode(char2 + 29) : char2.toString(36);
    }
    const prefix = encodeBase(Math.floor(num / radix));
    const char = num % radix;
    const suffix = char > 35 ? String.fromCharCode(char + 29) : char.toString(36);
    return prefix + suffix;
  };
  let i = count;
  while (i--) {
    const key2 = encodeBase(i);
    const value = keywords[i] || key2;
    dict[key2] = value;
  }
  return payload.replace(/\b\w+\b/g, (word) => {
    if (word in dict) {
      return dict[word];
    }
    return word;
  });
}
function decodeHex(str) {
  return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hexGroup) => {
    return String.fromCharCode(parseInt(hexGroup, 16));
  });
}
function unescapeString(str) {
  return str.replace(/\\(.)/g, (match, char) => char);
}
const baseUrl$b = "https://www.fullhdfilmizlesene.tv";
const headers$4 = {
  Referer: baseUrl$b,
  Accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
};
function extractVidmoxy(body) {
  const regex = /eval\(function\(p,a,c,k,e,d\){.+}}return p}\((\\?'.+.split\(\\?'\|\\?'\)).+$/m;
  let decoded = body;
  let i = 0;
  while (decoded.includes("eval(")) {
    const decodedMatch = decoded.match(regex);
    if (!decodedMatch) {
      throw new NotFoundError("Decryption unsuccessful");
    }
    const parameters = extractPackerParams(i > 0 ? unescapeString(decodedMatch[1]) : decodedMatch[1]);
    if (!parameters) throw new NotFoundError("Decryption unsuccessful");
    decoded = decodeDeanEdwards(parameters);
    i++;
  }
  const fileMatch = decoded.match(/"file":"(.+?)"/);
  if (!fileMatch) throw new NotFoundError("No playlist found");
  const playlistUrl = unescapeString(decodeHex(fileMatch[1]));
  return playlistUrl;
}
function extractAtom(body) {
  const fileMatch = body.match(/"file": av\('(.+)'\),$/m);
  if (!fileMatch) throw new NotFoundError("No playlist found");
  const playlistUrl = decodeAtom(fileMatch[1]);
  return playlistUrl;
}
async function scrapeMovie(ctx) {
  if (!ctx.media.imdbId) {
    throw new NotFoundError("IMDb id not provided");
  }
  const searchJson = await ctx.proxiedFetcher(
    `/autocomplete/q.php?q=${ctx.media.imdbId}`,
    {
      baseUrl: baseUrl$b,
      headers: headers$4
    }
  );
  ctx.progress(30);
  if (!searchJson.length) throw new NotFoundError("Media not found");
  const searchResult = searchJson[0];
  const mediaUrl = `/${searchResult.prefix}/${searchResult.dizilink}`;
  const mediaPage = await ctx.proxiedFetcher(mediaUrl, {
    baseUrl: baseUrl$b,
    headers: headers$4
  });
  const playerMatch = mediaPage.match(/var scx = {.+"t":\["(.+)"\]},/);
  if (!playerMatch) throw new NotFoundError("No source found");
  ctx.progress(60);
  const playerUrl2 = atob(rtt(playerMatch[1]));
  const isVidmoxy = playerUrl2.startsWith("https://vidmoxy.com");
  const playerResponse = await ctx.proxiedFetcher(playerUrl2 + (isVidmoxy ? "?vst=1" : ""), {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: baseUrl$b,
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-User": "?1",
      "Sec-GPC": "1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
  });
  ctx.progress(80);
  if (!playerResponse || playerResponse === "404") throw new NotFoundError("Player 404: Source is inaccessible");
  const playlistUrl = isVidmoxy ? extractVidmoxy(playerResponse) : extractAtom(playerResponse);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: createM3U8ProxyUrl(playlistUrl, ctx.features, headers$4),
        headers: headers$4,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const fullhdfilmizleScraper = makeSourcerer({
  id: "fullhdfilmizle",
  name: "FullHDFilmizle (Turkish)",
  rank: 6,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie
});
function generateRandomFavs() {
  const randomHex = () => Math.floor(Math.random() * 16).toString(16);
  const generateSegment = (length) => Array.from({ length }, randomHex).join("");
  return `${generateSegment(8)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(
    12
  )}`;
}
function parseSubtitleLinks(inputString) {
  if (!inputString || typeof inputString === "boolean") return [];
  const linksArray = inputString.split(",");
  const captions = [];
  linksArray.forEach((link) => {
    const match = link.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/);
    if (match) {
      const type = getCaptionTypeFromUrl(match[2]);
      const language = labelToLanguageCode(match[1]);
      if (!type || !language) return;
      captions.push({
        id: match[2],
        language,
        hasCorsRestrictions: false,
        type,
        url: match[2]
      });
    }
  });
  return captions;
}
function parseVideoLinks(inputString) {
  if (!inputString) throw new NotFoundError("No video links found");
  try {
    const qualityMap = {};
    const links = inputString.split(",");
    links.forEach((link) => {
      const match = link.match(/\[([^\]]+)\](https?:\/\/[^\s,]+)/);
      if (match) {
        const [_, quality, url] = match;
        if (url === "null") return;
        const normalizedQuality = quality.replace(/<[^>]+>/g, "").toLowerCase().replace("p", "").trim();
        qualityMap[normalizedQuality] = {
          type: "mp4",
          url: url.trim()
        };
      }
    });
    const result = {};
    Object.entries(qualityMap).forEach(([quality, data]) => {
      const validQuality = getValidQualityFromString(quality);
      result[validQuality] = data;
    });
    return result;
  } catch (error) {
    console.error("Error parsing video links:", error);
    throw new NotFoundError("Failed to parse video links");
  }
}
const rezkaBase = "https://hdrezka.ag/";
const baseHeaders = {
  "X-Hdrezka-Android-App": "1",
  "X-Hdrezka-Android-App-Version": "2.2.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "CF-IPCountry": "RU"
};
async function searchAndFindMediaId(ctx) {
  const searchData = await ctx.proxiedFetcher(`/engine/ajax/search.php`, {
    baseUrl: rezkaBase,
    headers: baseHeaders,
    query: { q: ctx.media.title }
  });
  const $ = load(searchData);
  const items = $("a").map((_, el) => {
    var _a;
    const $el = $(el);
    const url = $el.attr("href");
    const titleText = $el.find("span.enty").text();
    const yearMatch = titleText.match(/\((\d{4})\)/) || (url == null ? void 0 : url.match(/-(\d{4})(?:-|\.html)/)) || titleText.match(/(\d{4})/);
    const itemYear = yearMatch ? yearMatch[1] : null;
    const id = (_a = url == null ? void 0 : url.match(/\/(\d+)-[^/]+\.html$/)) == null ? void 0 : _a[1];
    if (id) {
      return {
        id,
        year: itemYear ? parseInt(itemYear, 10) : ctx.media.releaseYear,
        type: ctx.media.type,
        url: url || ""
      };
    }
    return null;
  }).get().filter(Boolean);
  items.sort((a, b) => {
    const diffA = Math.abs(a.year - ctx.media.releaseYear);
    const diffB = Math.abs(b.year - ctx.media.releaseYear);
    return diffA - diffB;
  });
  return items[0] || null;
}
async function getStream(id, translatorId, ctx) {
  const searchParams = new URLSearchParams();
  searchParams.append("id", id);
  searchParams.append("translator_id", translatorId);
  if (ctx.media.type === "show") {
    searchParams.append("season", ctx.media.season.number.toString());
    searchParams.append("episode", ctx.media.episode.number.toString());
  }
  searchParams.append("favs", generateRandomFavs());
  searchParams.append("action", ctx.media.type === "show" ? "get_stream" : "get_movie");
  searchParams.append("t", Date.now().toString());
  const response = await ctx.proxiedFetcher("/ajax/get_cdn_series/", {
    baseUrl: rezkaBase,
    method: "POST",
    body: searchParams,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${rezkaBase}films/action/${id}-novokain-2025-latest.html`
    }
  });
  try {
    const data = JSON.parse(response);
    if (!data.url && data.success) {
      throw new NotFoundError("Movie found but no stream available (might be premium or not yet released)");
    }
    if (!data.url) {
      throw new NotFoundError("No stream URL found in response");
    }
    return data;
  } catch (error) {
    console.error("Error parsing stream response:", error);
    throw new NotFoundError("Failed to parse stream response");
  }
}
async function getTranslatorId(url, id, ctx) {
  const response = await ctx.proxiedFetcher(url, {
    headers: baseHeaders
  });
  if (response.includes(`data-translator_id="238"`)) {
    return "238";
  }
  const functionName = ctx.media.type === "movie" ? "initCDNMoviesEvents" : "initCDNSeriesEvents";
  const regexPattern = new RegExp(`sof\\.tv\\.${functionName}\\(${id}, ([^,]+)`, "i");
  const match = response.match(regexPattern);
  const translatorId = match ? match[1] : null;
  return translatorId;
}
const universalScraper$4 = async (ctx) => {
  const result = await searchAndFindMediaId(ctx);
  if (!result || !result.id) throw new NotFoundError("No result found");
  const translatorId = await getTranslatorId(result.url, result.id, ctx);
  if (!translatorId) throw new NotFoundError("No translator id found");
  const { url: streamUrl, subtitle: streamSubtitle } = await getStream(result.id, translatorId, ctx);
  const parsedVideos = parseVideoLinks(streamUrl);
  const parsedSubtitles = parseSubtitleLinks(streamSubtitle);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
        captions: parsedSubtitles,
        qualities: parsedVideos
      }
    ]
  };
};
const hdRezkaScraper = makeSourcerer({
  id: "hdrezka",
  name: "HDRezka",
  rank: 105,
  flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
  scrapeShow: universalScraper$4,
  scrapeMovie: universalScraper$4
});
async function getVideoSources(ctx, id, media) {
  let path = "";
  if (media.type === "show") {
    path = `/v1/episodes/view`;
  } else if (media.type === "movie") {
    path = `/v1/movies/view`;
  }
  const data = await ctx.proxiedFetcher(path, {
    baseUrl: baseUrl$a,
    query: { expand: "streams,subtitles", id }
  });
  return data;
}
async function getVideo(ctx, id, media) {
  const data = await getVideoSources(ctx, id, media);
  const videoSources = data.streams;
  const opts = ["auto", "1080p", "1080", "720p", "720", "480p", "480", "240p", "240", "360p", "360", "144", "144p"];
  let videoUrl = null;
  for (const res of opts) {
    if (videoSources[res] && !videoUrl) {
      videoUrl = videoSources[res];
    }
  }
  let captions = [];
  for (const sub of data.subtitles) {
    const language = labelToLanguageCode(sub.language);
    if (!language) continue;
    captions.push({
      id: sub.url,
      type: "vtt",
      url: `${baseUrl$a}${sub.url}`,
      hasCorsRestrictions: false,
      language
    });
  }
  captions = removeDuplicatedLanguages(captions);
  return {
    playlist: videoUrl,
    captions
  };
}
const baseUrl$a = "https://lmscript.xyz";
async function searchAndFindMedia(ctx, media) {
  if (media.type === "show") {
    const searchRes = await ctx.proxiedFetcher(`/v1/shows`, {
      baseUrl: baseUrl$a,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
  if (media.type === "movie") {
    const searchRes = await ctx.proxiedFetcher(`/v1/movies`, {
      baseUrl: baseUrl$a,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
}
async function scrape(ctx, media, result) {
  var _a;
  let id = null;
  if (media.type === "movie") {
    id = result.id_movie;
  } else if (media.type === "show") {
    const data = await ctx.proxiedFetcher(`/v1/shows`, {
      baseUrl: baseUrl$a,
      query: { expand: "episodes", id: result.id_show }
    });
    const episode = (_a = data.episodes) == null ? void 0 : _a.find((v) => {
      return Number(v.season) === Number(media.season.number) && Number(v.episode) === Number(media.episode.number);
    });
    if (episode) id = episode.id;
  }
  if (id === null) throw new NotFoundError("Not found");
  const video = await getVideo(ctx, id, media);
  return video;
}
async function universalScraper$3(ctx) {
  const lookmovieData = await searchAndFindMedia(ctx, ctx.media);
  if (!lookmovieData) throw new NotFoundError("Media not found");
  ctx.progress(30);
  const video = await scrape(ctx, ctx.media, lookmovieData);
  if (!video.playlist) throw new NotFoundError("No video found");
  ctx.progress(60);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: video.playlist,
        type: "hls",
        flags: [flags.IP_LOCKED],
        captions: video.captions
      }
    ]
  };
}
const lookmovieScraper = makeSourcerer({
  id: "lookmovie",
  name: "LookMovie",
  disabled: false,
  rank: 171,
  flags: [flags.IP_LOCKED],
  scrapeShow: universalScraper$3,
  scrapeMovie: universalScraper$3
});
const baseUrl$9 = "https://movies4f.com";
const headers$3 = {
  Referer: "https://movies4f.com/",
  Origin: "https://movies4f.com",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};
async function comboScraper$f(ctx) {
  let searchQuery = encodeURIComponent(ctx.media.title);
  let searchUrl = `${baseUrl$9}/search?q=${searchQuery}`;
  let searchPage = await ctx.proxiedFetcher(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });
  if (!searchPage.includes("/film/")) {
    searchQuery = encodeURIComponent(`${ctx.media.title} ${ctx.media.releaseYear}`);
    searchUrl = `${baseUrl$9}/search?q=${searchQuery}`;
    searchPage = await ctx.proxiedFetcher(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
  }
  ctx.progress(40);
  let filmUrl = null;
  const filmCardRegex = /<a[^>]*href="([^"]*\/film\/\d+\/[^"]*)"[^>]*class="[^"]*poster[^"]*"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*>/g;
  let filmMatch;
  for (; ; ) {
    filmMatch = filmCardRegex.exec(searchPage);
    if (filmMatch === null) break;
    const link = filmMatch[1];
    const title = filmMatch[2];
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normalizedSearchTitle = ctx.media.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedTitle.includes(normalizedSearchTitle)) {
      if (ctx.media.type === "show") {
        const episode = ctx.media.episode.number;
        const episodeUrl = `${baseUrl$9}${link}/episode-${episode}`;
        if (title.toLowerCase().includes("season") || link.includes("/film/")) {
          filmUrl = episodeUrl;
          break;
        }
      } else {
        filmUrl = `${baseUrl$9}${link}`;
        break;
      }
    }
  }
  if (!filmUrl) {
    throw new NotFoundError("No matching film found in search results");
  }
  ctx.progress(50);
  const filmPage = await ctx.proxiedFetcher(filmUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });
  ctx.progress(60);
  const $film = load(filmPage);
  const iframeSrc = $film("iframe#iframeStream").attr("src");
  if (!iframeSrc) {
    throw new NotFoundError("No embed iframe found");
  }
  const embedUrl = new URL(iframeSrc);
  const videoId = embedUrl.searchParams.get("id");
  if (!videoId) {
    throw new NotFoundError("No video ID found in embed URL");
  }
  ctx.progress(70);
  const tokenResponse = await ctx.proxiedFetcher("https://moviking.childish2x2.fun/geturl", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=----geckoformboundaryc5f480bcac13a77346dab33881da6bfb",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: iframeSrc
    },
    body: `------geckoformboundaryc5f480bcac13a77346dab33881da6bfb
Content-Disposition: form-data; name="renderer"

ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar
------geckoformboundaryc5f480bcac13a77346dab33881da6bfb
Content-Disposition: form-data; name="id"

6164426f797cf4b2fe93e4b20c0a4338
------geckoformboundaryc5f480bcac13a77346dab33881da6bfb
Content-Disposition: form-data; name="videoId"

${videoId}
------geckoformboundaryc5f480bcac13a77346dab33881da6bfb
Content-Disposition: form-data; name="domain"

${baseUrl$9}/
------geckoformboundaryc5f480bcac13a77346dab33881da6bfb--`
  });
  ctx.progress(80);
  const tokenMatch = tokenResponse.match(/token1=(\w+)&token2=(\w+)&token3=(\w+)/);
  if (!tokenMatch) {
    throw new NotFoundError("Failed to extract tokens");
  }
  const [, token1, token2, token3] = tokenMatch;
  const streamingUrl = `https://cdn4.zenty.store/streaming?id=${videoId}&web=movies4f.com&token1=${token1}&token2=${token2}&token3=${token3}&cdn=https%3A%2F%2Fcdn4.zenty.store&lang=en`;
  const streamingPage = await ctx.proxiedFetcher(streamingUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://moviking.childish2x2.fun/"
    }
  });
  ctx.progress(90);
  const urlRegex = /url = '([^']+)'/;
  const urlMatch = streamingPage.match(urlRegex);
  if (!urlMatch) {
    throw new NotFoundError("Failed to extract stream URL from streaming page");
  }
  const streamBaseUrl = urlMatch[1];
  const videoIdMatch = streamingUrl.match(/id=([^&]+)/);
  if (!videoIdMatch) {
    throw new NotFoundError("Failed to extract videoId from streaming URL");
  }
  const streamVideoId = videoIdMatch[1];
  const streamUrl = `${streamBaseUrl}${streamVideoId}/?token1=${token1}&token3=${token3}`;
  ctx.progress(95);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: streamUrl,
        headers: headers$3,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const movies4fScraper = makeSourcerer({
  id: "movies4f",
  name: "M4F",
  rank: 166,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$f,
  scrapeShow: comboScraper$f
});
const GEMINI_BASE_URL = "https://gemini.aether.mom/v1beta/models/gemini-2.5-flash-lite:generateContent";
function buildPrompt(media, searchResults) {
  const seasons = media.season.number > 1 ? ` and has ${media.season.number} seasons` : "";
  const prompt = `
    You are an AI that matches TMDB movie and show data to myanime search results.
    The user is searching for "${media.title}" which was released in ${media.releaseYear}${seasons}.
    The user is looking for season ${media.season.number} (TMDB title: "${media.season.title}", ${media.season.episodeCount ?? "unknown"} episodes), episode ${media.episode.number}.

    Here are the search results from myanime:
    ${JSON.stringify(searchResults, null, 2)}

    IMPORTANT: Some shows on TMDB have continuous episode numbering across seasons (e.g., episode 25 is the first episode of season 2), but myanime lists seasons as separate entries with their own episode counts. The myanime entry may also have a different title (e.g., "Mugen Train Arc").
    To solve this, please return a JSON object with a "results" array that contains ALL entries from the search results that match the requested show, including all of its seasons, even if the user is only asking for one.
    Each object in the "results" array should have the "id" of the matching anime from the myanime search results, and the "season" number. You must determine the season number for each entry based on its title.
    The results MUST be sorted by season number in ascending order so the calling code can correctly map the episode number.
    Pay close attention to the season title and episode counts from both TMDB and the myanime results to find the best match. If TMDB combines seasons into one, you must split them based on the episode counts in the search results.
    Use the TMDB season title as the primary key for matching, and do not assign the same season number to different arcs.
    Your response must only be the raw JSON object, without any markdown formatting, comments, or other text.
  `;
  return prompt.trim();
}
async function getAiMatching(ctx, media, searchResults) {
  try {
    const prompt = buildPrompt(media, searchResults);
    const response = await ctx.fetcher(GEMINI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    const text = response.candidates[0].content.parts[0].text;
    const firstBracket = text.indexOf("{");
    const lastBracket = text.lastIndexOf("}");
    if (firstBracket === -1 || lastBracket === -1) {
      throw new Error("Invalid AI response: No JSON object found");
    }
    const jsonString = text.substring(firstBracket, lastBracket + 1);
    const data = JSON.parse(jsonString);
    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid AI response format");
    }
    return data;
  } catch (error) {
    if (error instanceof Error) {
      ctx.progress(0);
    }
    return null;
  }
}
const showScraper = async (ctx) => {
  var _a, _b, _c;
  const title = await getAnilistEnglishTitle(ctx, ctx.media);
  if (!title) throw new NotFoundError("Anime not found");
  const allAnimes = [];
  for (const t of [ctx.media.title, title]) {
    try {
      const searchResult = await ctx.proxiedFetcher(
        `https://anime.aether.mom/api/search?keyword=${encodeURIComponent(t)}`
      );
      if ((_a = searchResult == null ? void 0 : searchResult.results) == null ? void 0 : _a.data) {
        allAnimes.push(...searchResult.results.data);
      }
    } catch (err) {
    }
  }
  const uniqueAnimes = [...new Map(allAnimes.map((item) => [item.id, item])).values()];
  if (uniqueAnimes.length === 0) throw new NotFoundError("Anime not found");
  const tvAnimes = uniqueAnimes.filter((v) => v.tvInfo.showType === "TV");
  const aiResult = await getAiMatching(ctx, ctx.media, tvAnimes);
  let seasons = [];
  if (aiResult && aiResult.results.length > 0) {
    seasons = aiResult.results.map((v) => {
      const anime = tvAnimes.find((a) => a.id === v.id);
      if (!anime) return null;
      return {
        ...anime,
        seasonNum: v.season ?? 1
      };
    }).filter((v) => v !== null).sort((a, b) => a.seasonNum - b.seasonNum);
  }
  if (seasons.length === 0) throw new NotFoundError("Anime not found");
  let episodeId;
  let season = seasons.find((v) => v.seasonNum === ctx.media.season.number);
  const seasonEntries = seasons.filter((v) => v.seasonNum === ctx.media.season.number);
  if (seasonEntries.length > 1) {
    const sorted = seasonEntries.sort((a, b) => {
      const aTitleText = a.title;
      const bTitleText = b.title;
      const targetTitle = ctx.media.season.title;
      return Number(compareTitle(bTitleText, targetTitle)) - Number(compareTitle(aTitleText, targetTitle));
    });
    season = sorted[0];
  }
  if (season) {
    const episodeData = await ctx.proxiedFetcher(`https://anime.aether.mom/api/episodes/${season.id}`);
    if ((_b = episodeData == null ? void 0 : episodeData.results) == null ? void 0 : _b.episodes) {
      const episode = episodeData.results.episodes.find((ep) => ep.episode_no === ctx.media.episode.number);
      if (episode) episodeId = episode.id;
    }
  }
  if (!episodeId) {
    let episodeNumber = ctx.media.episode.number;
    for (const s of seasons) {
      const epCount = s.tvInfo.sub ?? 0;
      if (episodeNumber <= epCount) {
        const targetEpisodeNumber = episodeNumber;
        const episodeData = await ctx.proxiedFetcher(`https://anime.aether.mom/api/episodes/${s.id}`);
        if ((_c = episodeData == null ? void 0 : episodeData.results) == null ? void 0 : _c.episodes) {
          const episode = episodeData.results.episodes.find((ep) => ep.episode_no === targetEpisodeNumber);
          if (episode) {
            episodeId = episode.id;
            break;
          }
        }
      }
      if (episodeId) break;
      episodeNumber -= epCount;
    }
  }
  if (!episodeId) throw new NotFoundError("Episode not found");
  return {
    embeds: [
      {
        embedId: "myanimesub",
        url: episodeId
      },
      {
        embedId: "myanimedub",
        url: episodeId
      }
    ]
  };
};
const universalScraper$2 = async (ctx) => {
  const searchResults = await ctx.proxiedFetcher(
    `https://anime.aether.mom/api/search?keyword=${encodeURIComponent(ctx.media.title)}`
  );
  const movie = searchResults.results.data.find((v) => v.tvInfo.showType === "Movie");
  if (!movie) throw new NotFoundError("No watchable sources found");
  const episodeData = await ctx.proxiedFetcher(`https://anime.aether.mom/api/episodes/${movie.id}`);
  const episode = episodeData.results.episodes.find((e) => e.episode_no === 1);
  if (!episode) throw new NotFoundError("No watchable sources found");
  return {
    embeds: [
      {
        embedId: "myanimesub",
        url: episode.id
      },
      {
        embedId: "myanimedub",
        url: episode.id
      }
    ]
  };
};
const myanimeScraper = makeSourcerer({
  id: "myanime",
  name: "MyAnime",
  rank: 113,
  disabled: true,
  // disabled since AI api is not privated
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper$2,
  scrapeShow: showScraper
});
const mamaApiBase = "https://mama.up.railway.app/api/showbox";
const getUserToken = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem("febbox_ui_token") : null;
  } catch (e) {
    console.warn("Unable to access localStorage:", e);
    return null;
  }
};
async function comboScraper$e(ctx) {
  const userToken = getUserToken();
  const apiUrl2 = ctx.media.type === "movie" ? `${mamaApiBase}/movie/${ctx.media.tmdbId}?token=${userToken}` : `${mamaApiBase}/tv/${ctx.media.tmdbId}?season=${ctx.media.season.number}&episode=${ctx.media.episode.number}&token=${userToken}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2);
  if (!apiRes) {
    throw new NotFoundError("No response from API");
  }
  const data = await apiRes;
  if (!data.success) {
    throw new NotFoundError("No streams found");
  }
  const streamItems = Array.isArray(data.streams) ? data.streams : [data.streams];
  if (streamItems.length === 0 || !streamItems[0].player_streams) {
    throw new NotFoundError("No valid streams found");
  }
  let bestStreamItem = streamItems[0];
  for (const item of streamItems) {
    if (item.quality.includes("4K") || item.quality.includes("2160p")) {
      bestStreamItem = item;
      break;
    }
  }
  const streams = bestStreamItem.player_streams.reduce((acc, stream) => {
    let qualityKey;
    if (stream.quality === "4K" || stream.quality.includes("4K")) {
      qualityKey = 2160;
    } else if (stream.quality === "ORG" || stream.quality.includes("ORG")) {
      return acc;
    } else {
      qualityKey = parseInt(stream.quality.replace("P", ""), 10);
    }
    if (Number.isNaN(qualityKey) || acc[qualityKey]) return acc;
    acc[qualityKey] = stream.file;
    return acc;
  }, {});
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions: [],
        qualities: {
          ...streams[2160] && {
            "4k": {
              type: "mp4",
              url: streams[2160]
            }
          },
          ...streams[1080] && {
            1080: {
              type: "mp4",
              url: streams[1080]
            }
          },
          ...streams[720] && {
            720: {
              type: "mp4",
              url: streams[720]
            }
          },
          ...streams[480] && {
            480: {
              type: "mp4",
              url: streams[480]
            }
          },
          ...streams[360] && {
            360: {
              type: "mp4",
              url: streams[360]
            }
          }
        },
        type: "file",
        flags: [flags.CORS_ALLOWED]
      }
    ]
  };
}
const nunflixScraper = makeSourcerer({
  id: "nunflix",
  name: "NFlix",
  rank: 155,
  disabled: !getUserToken(),
  // disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$e,
  scrapeShow: comboScraper$e
});
const baseUrl$8 = "https://ww3.pelisplus.to";
function normalizeTitle$2(title) {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s-]/gi, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}
function decodeBase64(str) {
  try {
    return atob(str);
  } catch {
    return "";
  }
}
function fetchUrls(text) {
  if (!text) return [];
  const linkRegex2 = /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])/g;
  return Array.from(text.matchAll(linkRegex2)).map((m) => m[0].replace(/^"+|"+$/g, ""));
}
async function resolvePlayerUrl(ctx, url) {
  try {
    const html = await ctx.proxiedFetcher(url);
    const $ = load(html);
    const script = $('script:contains("window.onload")').html() || "";
    return fetchUrls(script)[0] || "";
  } catch {
    return "";
  }
}
async function extractVidhideEmbed(ctx, $) {
  const regIsUrl = /^https?:\/\/([\w.-]+\.[a-z]{2,})(\/.*)?$/i;
  const playerLinks = [];
  $(".bg-tabs ul li").each((idx, el) => {
    var _a, _b;
    const li = $(el);
    const langBtn = (_b = (_a = li.parent()) == null ? void 0 : _a.parent()) == null ? void 0 : _b.find("button").first().text().trim().toLowerCase();
    const dataServer = li.attr("data-server") || "";
    const decoded = decodeBase64(dataServer);
    const url = regIsUrl.test(decoded) ? decoded : `${baseUrl$8}/player/${btoa(dataServer)}`;
    playerLinks.push({ idx, langBtn, url });
  });
  const results = [];
  for (const link of playerLinks) {
    let realUrl = link.url;
    if (realUrl.includes("/player/")) {
      realUrl = await resolvePlayerUrl(ctx, realUrl);
    }
    if (/vidhide/i.test(realUrl)) {
      let embedId = "vidhide";
      if (link.langBtn.includes("latino")) embedId = "vidhide-latino";
      else if (link.langBtn.includes("castellano") || link.langBtn.includes("español")) embedId = "vidhide-spanish";
      else if (link.langBtn.includes("ingles") || link.langBtn.includes("english")) embedId = "vidhide-english";
      results.push({ embedId, url: realUrl });
    }
  }
  return results;
}
async function fetchTmdbTitleInSpanish(tmdbId, apiKey, mediaType) {
  const endpoint = mediaType === "movie" ? `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=es-ES` : `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}&language=es-ES`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Error fetching TMDB data: ${response.statusText}`);
  }
  const tmdbData = await response.json();
  return mediaType === "movie" ? tmdbData.title : tmdbData.name;
}
async function fallbackSearchByGithub(ctx) {
  var _a, _b;
  const tmdbId = ctx.media.tmdbId;
  const mediaType = ctx.media.type;
  if (!tmdbId) return [];
  const jsonFile = mediaType === "movie" ? "pelisplushd_movies.json" : "pelisplushd_series.json";
  let fallbacks = {};
  try {
    const url = `https://raw.githubusercontent.com/moonpic/fixed-titles/main/${jsonFile}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error();
    fallbacks = await response.json();
  } catch {
    return [];
  }
  const fallbackTitle = fallbacks[tmdbId.toString()];
  if (!fallbackTitle) return [];
  const normalizedTitle = normalizeTitle$2(fallbackTitle);
  const pageUrl = mediaType === "movie" ? `${baseUrl$8}/pelicula/${normalizedTitle}` : `${baseUrl$8}/serie/${normalizedTitle}/season/${(_a = ctx.media.season) == null ? void 0 : _a.number}/episode/${(_b = ctx.media.episode) == null ? void 0 : _b.number}`;
  let html = "";
  try {
    html = await ctx.proxiedFetcher(pageUrl);
  } catch {
    return [];
  }
  const $ = load(html);
  return extractVidhideEmbed(ctx, $);
}
async function comboScraper$d(ctx) {
  var _a, _b;
  const mediaType = ctx.media.type;
  const tmdbId = ctx.media.tmdbId;
  const apiKey = "7604525319adb2db8e7e841cb98e9217";
  if (!tmdbId) throw new NotFoundError("TMDB ID is required to fetch the title in Spanish");
  let translatedTitle = "";
  try {
    translatedTitle = await fetchTmdbTitleInSpanish(Number(tmdbId), apiKey, mediaType);
  } catch {
    throw new NotFoundError("Could not get the title from TMDB");
  }
  const normalizedTitle = normalizeTitle$2(translatedTitle);
  const pageUrl = mediaType === "movie" ? `${baseUrl$8}/pelicula/${normalizedTitle}` : `${baseUrl$8}/serie/${normalizedTitle}/season/${(_a = ctx.media.season) == null ? void 0 : _a.number}/episode/${(_b = ctx.media.episode) == null ? void 0 : _b.number}`;
  ctx.progress(60);
  let html = "";
  try {
    html = await ctx.proxiedFetcher(pageUrl);
  } catch {
    html = "";
  }
  let embeds = [];
  if (html) {
    const $ = load(html);
    try {
      embeds = await extractVidhideEmbed(ctx, $);
    } catch {
      embeds = [];
    }
  }
  if (!embeds.length) {
    embeds = await fallbackSearchByGithub(ctx);
  }
  if (!embeds.length) {
    throw new NotFoundError("No vidhide embed found in PelisPlusHD");
  }
  return { embeds };
}
const pelisplushdScraper = makeSourcerer({
  id: "pelisplushd",
  name: "PelisPlusHD",
  rank: 75,
  flags: [flags.IP_LOCKED],
  // Vidhide embeds are IP locked
  scrapeMovie: comboScraper$d,
  scrapeShow: comboScraper$d
});
async function comboScraper$c(ctx) {
  let apiUrl2;
  if (ctx.media.type === "movie") {
    if (!ctx.media.imdbId) throw new NotFoundError("IMDB ID required for movies");
    apiUrl2 = `https://primewire.pstream.mov/movie/${ctx.media.imdbId}`;
  } else {
    if (!ctx.media.imdbId) throw new NotFoundError("IMDB ID required for TV shows");
    apiUrl2 = `https://primewire.pstream.mov/tv/${ctx.media.imdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  }
  ctx.progress(30);
  const response = await ctx.fetcher(apiUrl2, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    }
  });
  if (!response.streams || !Array.isArray(response.streams) || response.streams.length === 0) {
    throw new NotFoundError("No streams found");
  }
  ctx.progress(60);
  const embeds = [];
  for (const stream of response.streams) {
    if (!stream.link || !stream.quality) continue;
    let mirrorContext;
    if (stream.type === "m3u8") {
      mirrorContext = {
        type: "hls",
        stream: stream.link,
        headers: stream.headers || [],
        captions: [],
        flags: !stream.headers || Object.keys(stream.headers).length === 0 ? [flags.CORS_ALLOWED] : []
      };
    } else {
      let qualityKey;
      if (stream.quality === "ORG") {
        const urlPath = stream.link.split("?")[0];
        if (urlPath.toLowerCase().endsWith(".mp4")) {
          qualityKey = "unknown";
        } else {
          continue;
        }
      } else if (stream.quality === "4K") {
        qualityKey = "4k";
      } else {
        const parsed = parseInt(stream.quality.replace("P", ""), 10);
        if (Number.isNaN(parsed)) continue;
        qualityKey = parsed.toString();
      }
      mirrorContext = {
        type: "file",
        qualities: {
          [qualityKey === "unknown" || qualityKey === "4k" ? qualityKey : parseInt(qualityKey, 10)]: {
            type: "mp4",
            url: stream.link
          }
        },
        flags: !stream.headers || Object.keys(stream.headers).length === 0 ? [flags.CORS_ALLOWED] : [],
        headers: stream.headers || [],
        captions: []
      };
    }
    embeds.push({
      embedId: "mirror",
      url: JSON.stringify(mirrorContext)
    });
  }
  if (embeds.length === 0) {
    throw new NotFoundError("No valid streams found");
  }
  ctx.progress(90);
  return { embeds };
}
const primewireScraper = makeSourcerer({
  id: "primewire",
  name: "PrimeWire 🔥",
  rank: 206,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$c,
  scrapeShow: comboScraper$c
});
const baseUrl$7 = "api.rgshows.ru";
const headers$2 = {
  referer: "https://rgshows.ru/",
  origin: "https://rgshows.ru",
  host: baseUrl$7,
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
};
async function comboScraper$b(ctx) {
  var _a;
  let url = `https://${baseUrl$7}/main`;
  if (ctx.media.type === "movie") {
    url += `/movie/${ctx.media.tmdbId}`;
  } else if (ctx.media.type === "show") {
    url += `/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  }
  const res = await ctx.proxiedFetcher(url, { headers: headers$2 });
  if (!((_a = res == null ? void 0 : res.stream) == null ? void 0 : _a.url)) {
    throw new NotFoundError("No streams found");
  }
  if (res.stream.url === "https://vidzee.wtf/playlist/69/master.m3u8") {
    throw new NotFoundError("Found only vidzee porn stream");
  }
  const streamUrl = res.stream.url;
  const streamHost = new URL(streamUrl).host;
  const m3u8Headers = {
    ...headers$2,
    host: streamHost,
    origin: "https://www.rgshows.ru",
    referer: "https://www.rgshows.ru/"
  };
  ctx.progress(100);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: streamUrl,
        headers: m3u8Headers,
        flags: [],
        captions: []
      }
    ]
  };
}
const rgshowsScraper = makeSourcerer({
  id: "rgshows",
  name: "RGShows",
  rank: 176,
  flags: [],
  scrapeMovie: comboScraper$b,
  scrapeShow: comboScraper$b
});
const ridoMoviesBase = `https://ridomovies.tv`;
const ridoMoviesApiBase = `${ridoMoviesBase}/core/api`;
const normalizeTitle$1 = (title) => {
  return title.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
};
const universalScraper$1 = async (ctx) => {
  var _a;
  const searchResult = await ctx.proxiedFetcher("/search", {
    baseUrl: ridoMoviesApiBase,
    query: {
      q: ctx.media.title
    }
  });
  if (!((_a = searchResult.data) == null ? void 0 : _a.items) || searchResult.data.items.length === 0) {
    throw new NotFoundError("No search results found");
  }
  const mediaData = searchResult.data.items.map((movieEl) => {
    const name = movieEl.title;
    const year = movieEl.contentable.releaseYear;
    const fullSlug = movieEl.fullSlug;
    return { name, year, fullSlug };
  });
  const normalizedSearchTitle = normalizeTitle$1(ctx.media.title);
  const searchYear = ctx.media.releaseYear.toString();
  let targetMedia = mediaData.find((m) => normalizeTitle$1(m.name) === normalizedSearchTitle && m.year === searchYear);
  if (!targetMedia) {
    targetMedia = mediaData.find((m) => {
      const normalizedName = normalizeTitle$1(m.name);
      return m.year === searchYear && (normalizedName.includes(normalizedSearchTitle) || normalizedSearchTitle.includes(normalizedName));
    });
  }
  if (!(targetMedia == null ? void 0 : targetMedia.fullSlug)) {
    throw new NotFoundError("No matching media found");
  }
  ctx.progress(40);
  let iframeSourceUrl = `/${targetMedia.fullSlug}/videos`;
  if (ctx.media.type === "show") {
    const showPageResult = await ctx.proxiedFetcher(`/${targetMedia.fullSlug}`, {
      baseUrl: ridoMoviesBase
    });
    const fullEpisodeSlug = `season-${ctx.media.season.number}/episode-${ctx.media.episode.number}`;
    const regexPattern = new RegExp(
      `\\\\"id\\\\":\\\\"(\\d+)\\\\"(?=.*?\\\\"fullSlug\\\\":\\\\"[^"]*${fullEpisodeSlug}[^"]*\\\\")`,
      "g"
    );
    const matches = [...showPageResult.matchAll(regexPattern)];
    const episodeIds = matches.map((match) => match[1]);
    if (episodeIds.length === 0) {
      throw new NotFoundError("Episode not found");
    }
    const episodeId = episodeIds[episodeIds.length - 1];
    iframeSourceUrl = `/episodes/${episodeId}/videos`;
  }
  const iframeSource = await ctx.proxiedFetcher(iframeSourceUrl, {
    baseUrl: ridoMoviesApiBase
  });
  if (!iframeSource.data || iframeSource.data.length === 0) {
    throw new NotFoundError("No video sources found");
  }
  const iframeSource$ = load(iframeSource.data[0].url);
  const iframeUrl = iframeSource$("iframe").attr("data-src");
  if (!iframeUrl) {
    throw new NotFoundError("No iframe URL found");
  }
  ctx.progress(60);
  const embeds = [];
  let embedId = "closeload";
  if (iframeUrl.includes("ridoo")) {
    embedId = "ridoo";
  }
  embeds.push({
    embedId,
    url: iframeUrl
  });
  ctx.progress(80);
  if (embeds.length === 0) {
    throw new NotFoundError("No supported embeds found");
  }
  ctx.progress(90);
  return {
    embeds
  };
};
const ridooMoviesScraper = makeSourcerer({
  id: "ridomovies",
  name: "RidoMovies",
  rank: 203,
  flags: [],
  disabled: false,
  scrapeMovie: universalScraper$1,
  scrapeShow: universalScraper$1
});
const baseUrl$6 = "https://pupp.slidemovies-dev.workers.dev";
async function comboScraper$a(ctx) {
  const watchPageUrl = ctx.media.type === "movie" ? `${baseUrl$6}/movie/${ctx.media.tmdbId}` : `${baseUrl$6}/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/-${ctx.media.episode.number}`;
  const watchPage = await ctx.proxiedFetcher(watchPageUrl);
  const $ = load(watchPage);
  ctx.progress(50);
  const proxiedStreamUrl = $("media-player").attr("src");
  if (!proxiedStreamUrl) {
    throw new NotFoundError("Stream URL not found");
  }
  const proxyUrl = new URL(proxiedStreamUrl);
  const encodedUrl = proxyUrl.searchParams.get("url") || "";
  const playlist = decodeURIComponent(encodedUrl);
  const captions = $("media-provider track").map((_, el) => {
    const url = $(el).attr("src") || "";
    const rawLang = $(el).attr("lang") || "unknown";
    const languageCode = labelToLanguageCode(rawLang) || rawLang;
    const isVtt = url.endsWith(".vtt") ? "vtt" : "srt";
    return {
      type: isVtt,
      id: url,
      url,
      language: languageCode,
      hasCorsRestrictions: false
    };
  }).get();
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        flags: [],
        playlist,
        captions
      }
    ]
  };
}
const slidemoviesScraper = makeSourcerer({
  id: "slidemovies",
  name: "SlideMovies",
  rank: 135,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$a,
  scrapeShow: comboScraper$a
});
async function convertPlaylistsToDataUrls(fetcher, playlistUrl, headers2) {
  const playlistData = await fetcher(playlistUrl, { headers: headers2 });
  const playlist = parse(playlistData);
  if (playlist.isMasterPlaylist) {
    const baseUrl2 = new URL(playlistUrl).origin;
    await Promise.all(
      playlist.variants.map(async (variant) => {
        let variantUrl = variant.uri;
        if (!variantUrl.startsWith("http")) {
          if (!variantUrl.startsWith("/")) {
            variantUrl = `/${variantUrl}`;
          }
          variantUrl = baseUrl2 + variantUrl;
        }
        const variantPlaylistData = await fetcher(variantUrl, { headers: headers2 });
        const variantPlaylist = parse(variantPlaylistData);
        variant.uri = `data:application/vnd.apple.mpegurl;base64,${btoa(stringify(variantPlaylist))}`;
      })
    );
  }
  return `data:application/vnd.apple.mpegurl;base64,${btoa(stringify(playlist))}`;
}
const baseUrl$5 = "https://soaper.cc";
const universalScraper = async (ctx) => {
  var _a;
  const searchResult = await ctx.proxiedFetcher("/search.html", {
    baseUrl: baseUrl$5,
    query: {
      keyword: ctx.media.title
    }
  });
  const search$ = load(searchResult);
  const searchResults = [];
  search$(".thumbnail").each((_, element) => {
    const title = search$(element).find("h5").find("a").first().text().trim();
    const year = search$(element).find(".img-tip").first().text().trim();
    const url = search$(element).find("h5").find("a").first().attr("href");
    if (!title || !url) return;
    searchResults.push({ title, year: year ? parseInt(year, 10) : void 0, url });
  });
  let showLink = (_a = searchResults.find((x) => x && compareMedia(ctx.media, x.title, x.year))) == null ? void 0 : _a.url;
  if (!showLink) throw new NotFoundError("Content not found");
  if (ctx.media.type === "show") {
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const showPage = await ctx.proxiedFetcher(showLink, { baseUrl: baseUrl$5 });
    const showPage$ = load(showPage);
    const seasonBlock = showPage$("h4").filter((_, el) => showPage$(el).text().trim().split(":")[0].trim() === `Season${seasonNumber}`).parent();
    const episodes = seasonBlock.find("a").toArray();
    showLink = showPage$(
      episodes.find((el) => parseInt(showPage$(el).text().split(".")[0], 10) === episodeNumber)
    ).attr("href");
  }
  if (!showLink) throw new NotFoundError("Content not found");
  const contentPage = await ctx.proxiedFetcher(showLink, { baseUrl: baseUrl$5 });
  const contentPage$ = load(contentPage);
  const pass = contentPage$("#hId").attr("value");
  if (!pass) throw new NotFoundError("Content not found");
  ctx.progress(50);
  const formData = new URLSearchParams();
  formData.append("pass", pass);
  formData.append("e2", "0");
  formData.append("server", "0");
  const infoEndpoint = ctx.media.type === "show" ? "/home/index/getEInfoAjax" : "/home/index/getMInfoAjax";
  const streamRes = await ctx.proxiedFetcher(infoEndpoint, {
    baseUrl: baseUrl$5,
    method: "POST",
    body: formData,
    headers: {
      referer: `${baseUrl$5}${showLink}`,
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Viewport-Width": "375"
    }
  });
  const streamResJson = JSON.parse(streamRes);
  const captions = [];
  if (Array.isArray(streamResJson.subs)) {
    for (const sub of streamResJson.subs) {
      let language = "";
      if (sub.name.includes(".srt")) {
        const langName = sub.name.split(".srt")[0].trim();
        language = labelToLanguageCode(langName);
      } else if (sub.name.includes(":")) {
        const langName = sub.name.split(":")[0].trim();
        language = labelToLanguageCode(langName);
      } else {
        const langName = sub.name.trim();
        language = labelToLanguageCode(langName);
      }
      if (!language) continue;
      captions.push({
        id: sub.path,
        url: `${baseUrl$5}${sub.path}`,
        type: "srt",
        hasCorsRestrictions: false,
        language
      });
    }
  }
  ctx.progress(90);
  const headers2 = {
    referer: `${baseUrl$5}${showLink}`,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Viewport-Width": "375",
    Origin: baseUrl$5
  };
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: await convertPlaylistsToDataUrls(ctx.proxiedFetcher, `${baseUrl$5}/${streamResJson.val}`, headers2),
        type: "hls",
        proxyDepth: 2,
        flags: [flags.CORS_ALLOWED],
        captions
      },
      ...streamResJson.val_bak ? [
        {
          id: "backup",
          playlist: await convertPlaylistsToDataUrls(
            ctx.proxiedFetcher,
            `${baseUrl$5}/${streamResJson.val_bak}`,
            headers2
          ),
          type: "hls",
          flags: [flags.CORS_ALLOWED],
          proxyDepth: 2,
          captions
        }
      ] : []
    ]
  };
};
const soaperTvScraper = makeSourcerer({
  id: "soapertv",
  name: "SoaperTV",
  rank: 130,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper,
  scrapeShow: universalScraper
});
const streamboxBase = "https://vidjoy.pro/embed/api/fastfetch";
async function comboScraper$9(ctx) {
  var _a, _b;
  const apiRes = await ctx.proxiedFetcher(
    ctx.media.type === "movie" ? `${streamboxBase}/${ctx.media.tmdbId}?sr=0` : `${streamboxBase}/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}?sr=0`
  );
  if (!apiRes) {
    throw new NotFoundError("Failed to fetch StreamBox data");
  }
  console.log(apiRes);
  const data = await apiRes;
  const streams = {};
  data.url.forEach((stream) => {
    streams[stream.resulation] = stream.link;
  });
  const captions = data.tracks.map((track) => ({
    id: track.lang,
    url: track.url,
    language: track.code,
    type: "srt"
  }));
  if (data.provider === "MovieBox") {
    return {
      embeds: [],
      stream: [
        {
          id: "primary",
          captions,
          qualities: {
            ...streams["1080"] && {
              1080: {
                type: "mp4",
                url: streams["1080"]
              }
            },
            ...streams["720"] && {
              720: {
                type: "mp4",
                url: streams["720"]
              }
            },
            ...streams["480"] && {
              480: {
                type: "mp4",
                url: streams["480"]
              }
            },
            ...streams["360"] && {
              360: {
                type: "mp4",
                url: streams["360"]
              }
            }
          },
          type: "file",
          flags: [flags.CORS_ALLOWED],
          preferredHeaders: {
            Referer: (_a = data.headers) == null ? void 0 : _a.Referer
          }
        }
      ]
    };
  }
  const hlsStream = data.url.find((stream) => stream.type === "hls") || data.url[0];
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        captions,
        playlist: hlsStream.link,
        type: "hls",
        flags: [flags.CORS_ALLOWED],
        preferredHeaders: {
          Referer: (_b = data.headers) == null ? void 0 : _b.Referer
        }
      }
    ]
  };
}
const streamboxScraper = makeSourcerer({
  id: "streambox",
  name: "StreamBox",
  rank: 119,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$9,
  scrapeShow: comboScraper$9
});
const baseUrl$4 = "https://turbovid.eu";
async function comboScraper$8(ctx) {
  const embedUrl = ctx.media.type === "movie" ? `${baseUrl$4}/api/req/movie/${ctx.media.tmdbId}` : `${baseUrl$4}/api/req/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  return {
    embeds: [
      {
        embedId: "turbovid",
        url: embedUrl
      }
    ]
  };
}
const turbovidSourceScraper = makeSourcerer({
  id: "turbovidSource",
  name: "TurboVid",
  rank: 120,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$8,
  scrapeShow: comboScraper$8
});
const baseUrl$3 = "https://vidapi.click";
async function comboScraper$7(ctx) {
  const apiUrl2 = ctx.media.type === "show" ? `${baseUrl$3}/api/video/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}` : `${baseUrl$3}/api/video/movie/${ctx.media.tmdbId}`;
  const apiRes = await ctx.proxiedFetcher(apiUrl2, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  if (!apiRes) throw new NotFoundError("Failed to fetch video source");
  if (!apiRes.sources[0].file) throw new NotFoundError("No video source found");
  ctx.progress(50);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: apiRes.sources[0].file,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const vidapiClickScraper = makeSourcerer({
  id: "vidapi-click",
  name: "vidapi.click",
  rank: 89,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$7,
  scrapeShow: comboScraper$7
});
const VIDIFY_SERVERS = [
  { name: "Mbox", sr: 17 },
  { name: "Xprime", sr: 15 },
  { name: "Hexo", sr: 8 },
  { name: "Prime", sr: 9 },
  { name: "Nitro", sr: 20 },
  { name: "Meta", sr: 6 },
  { name: "Veasy", sr: 16 },
  { name: "Lux", sr: 26 },
  { name: "Vfast", sr: 11 },
  { name: "Zozo", sr: 7 },
  { name: "Tamil", sr: 13 },
  { name: "Telugu", sr: 14 },
  { name: "Beta", sr: 5 },
  { name: "Alpha", sr: 1 },
  { name: "Vplus", sr: 18 },
  { name: "Cobra", sr: 12 }
];
async function comboScraper$6(ctx) {
  const query = {
    type: ctx.media.type,
    tmdbId: ctx.media.tmdbId,
    ...ctx.media.type === "show" && {
      season: ctx.media.season.number,
      episode: ctx.media.episode.number
    }
  };
  return {
    embeds: VIDIFY_SERVERS.map((server) => ({
      embedId: `vidify-${server.name.toLowerCase()}`,
      url: JSON.stringify({ ...query, sr: server.sr })
    }))
  };
}
const vidifyScraper = makeSourcerer({
  id: "vidify",
  name: "Vidify 🔥",
  rank: 204,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$6,
  scrapeShow: comboScraper$6
});
const API_BASE = "https://enc-dec.app/api";
const VIDLINK_BASE = "https://vidlink.pro/api/b";
const headers$1 = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Connection: "keep-alive",
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
async function encryptTmdbId(ctx, tmdbId) {
  const response = await ctx.proxiedFetcher(`${API_BASE}/enc-vidlink`, {
    method: "GET",
    query: { text: tmdbId }
  });
  if (!(response == null ? void 0 : response.result)) {
    throw new NotFoundError("Failed to encrypt TMDB ID");
  }
  return response.result;
}
async function comboScraper$5(ctx) {
  const { tmdbId } = ctx.media;
  ctx.progress(10);
  const encryptedId = await encryptTmdbId(ctx, tmdbId.toString());
  ctx.progress(30);
  const apiUrl2 = ctx.media.type === "movie" ? `${VIDLINK_BASE}/movie/${encryptedId}` : `${VIDLINK_BASE}/tv/${encryptedId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  const vidlinkRaw = await ctx.proxiedFetcher(apiUrl2, {
    headers: headers$1
  });
  if (!vidlinkRaw) {
    throw new NotFoundError("No response from vidlink API");
  }
  ctx.progress(60);
  let vidlinkData;
  try {
    vidlinkData = typeof vidlinkRaw === "string" ? JSON.parse(vidlinkRaw) : vidlinkRaw;
  } catch {
    throw new NotFoundError("Invalid JSON from vidlink API");
  }
  ctx.progress(80);
  if (!vidlinkData.stream) {
    throw new NotFoundError("No stream data found in vidlink response");
  }
  const { stream } = vidlinkData;
  const captions = [];
  if (stream.captions && Array.isArray(stream.captions)) {
    for (const caption of stream.captions) {
      const captionType = caption.type === "srt" ? "srt" : "vtt";
      captions.push({
        id: caption.id || caption.url,
        url: caption.url,
        language: caption.language || "Unknown",
        type: captionType,
        hasCorsRestrictions: caption.hasCorsRestrictions || false
      });
    }
  }
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: stream.id || "primary",
        type: stream.type || "file",
        qualities: stream.qualities || {},
        playlist: stream.playlist,
        captions,
        flags: [],
        headers: stream.headers || headers$1
      }
    ]
  };
}
const vidlinkScraper = makeSourcerer({
  id: "vidlink",
  name: "VidLink 🔥",
  rank: 310,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$5,
  scrapeShow: comboScraper$5
});
async function comboScraper$4(ctx) {
  const query = {
    type: ctx.media.type,
    tmdbId: ctx.media.tmdbId
  };
  if (ctx.media.type === "show") {
    query.season = ctx.media.season.number;
    query.episode = ctx.media.episode.number;
  }
  return {
    embeds: [
      { embedId: "vidnest-hollymoviehd", url: JSON.stringify(query) },
      { embedId: "vidnest-allmovies", url: JSON.stringify(query) }
    ]
  };
}
const vidnestScraper = makeSourcerer({
  id: "vidnest",
  name: "Vidnest",
  rank: 115,
  flags: [],
  disabled: true,
  // The streams cause the site to crash
  scrapeMovie: comboScraper$4,
  scrapeShow: comboScraper$4
});
const headers = {
  Origin: "https://vidrock.net",
  Referer: "https://vidrock.net/"
};
const passphrase = "x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9";
const key = CryptoJS.enc.Utf8.parse(passphrase);
const iv = CryptoJS.enc.Utf8.parse(passphrase.substring(0, 16));
const baseUrl$2 = "https://vidrock.net/api";
const userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
async function comboScraper$3(ctx) {
  const itemType = ctx.media.type;
  let itemId;
  if (itemType === "movie") {
    itemId = ctx.media.tmdbId;
  } else {
    itemId = `${ctx.media.tmdbId}_${ctx.media.season.number}_${ctx.media.episode.number}`;
  }
  const encrypted = CryptoJS.AES.encrypt(itemId, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  let encryptedBase64 = encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  encryptedBase64 = encryptedBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const encoded = encodeURIComponent(encryptedBase64);
  const url = `${baseUrl$2}/${itemType}/${encoded}`;
  const res = await ctx.proxiedFetcher(url, {
    headers: {
      ...headers,
      "User-Agent": userAgent
    }
  });
  let parsedRes = res;
  if (typeof res === "string") {
    try {
      parsedRes = JSON.parse(res);
    } catch (e) {
      throw new NotFoundError("No sources found from Vidrock API: Invalid JSON response");
    }
  }
  if (!parsedRes || typeof parsedRes !== "object" || Array.isArray(parsedRes)) {
    throw new NotFoundError("No sources found from Vidrock API: Invalid response");
  }
  const embeds = [];
  const createMirrorEmbed = (serverName, serverData) => {
    if (!(serverData == null ? void 0 : serverData.url)) return null;
    if (serverName.includes("Astra") || serverData.url.includes(".workers.dev")) return null;
    const context = {
      type: "hls",
      stream: serverData.url,
      headers,
      flags: [flags.CORS_ALLOWED],
      captions: []
    };
    return {
      embedId: "mirror",
      url: JSON.stringify(context)
    };
  };
  for (const sourceKey of Object.keys(parsedRes)) {
    const sourceData = parsedRes[sourceKey];
    if ((sourceData == null ? void 0 : sourceData.url) && sourceData.url !== null) {
      if (sourceKey === "Atlas" || sourceData.url.includes("cdn.vidrock.store/playlist/")) {
        try {
          const playlistRes = await ctx.proxiedFetcher(sourceData.url, {
            headers: {
              ...headers,
              "User-Agent": userAgent
            }
          });
          let playlistData = playlistRes;
          if (typeof playlistRes === "string") {
            try {
              playlistData = JSON.parse(playlistRes);
            } catch (e) {
              continue;
            }
          }
          if (Array.isArray(playlistData) && playlistData.length > 0) {
            const qualities = {};
            for (const stream of playlistData) {
              if ((stream == null ? void 0 : stream.url) && (stream == null ? void 0 : stream.resolution)) {
                const resolution = stream.resolution.toString();
                qualities[resolution] = {
                  type: "mp4",
                  url: stream.url
                };
              }
            }
            if (Object.keys(qualities).length > 0) {
              const context = {
                type: "file",
                qualities,
                headers,
                flags: [flags.CORS_ALLOWED],
                captions: []
              };
              embeds.push({
                embedId: "mirror",
                url: JSON.stringify(context)
              });
            }
          }
        } catch (e) {
          continue;
        }
      } else {
        const embed2 = createMirrorEmbed(sourceKey, sourceData);
        if (embed2) embeds.push(embed2);
      }
    }
  }
  if (embeds.length === 0) {
    throw new NotFoundError("No valid sources found from Vidrock API");
  }
  return {
    embeds
  };
}
const vidrockScraper = makeSourcerer({
  id: "vidrock",
  name: "Granite",
  rank: 170,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$3,
  scrapeShow: comboScraper$3
});
async function getEmbeds(id, servers, ctx) {
  var _a;
  const embeds = [];
  for (const server of servers.split(",")) {
    await ctx.proxiedFetcher(`/getEmbed.php`, {
      baseUrl: warezcdnBase,
      headers: {
        Referer: `${warezcdnBase}/getEmbed.php?${new URLSearchParams({ id, sv: server })}`
      },
      method: "HEAD",
      query: { id, sv: server }
    });
    const embedPage = await ctx.proxiedFetcher(`/getPlay.php`, {
      baseUrl: warezcdnBase,
      headers: {
        Referer: `${warezcdnBase}/getEmbed.php?${new URLSearchParams({ id, sv: server })}`
      },
      query: { id, sv: server }
    });
    const url = (_a = embedPage.match(/window.location.href\s*=\s*"([^"]+)"/)) == null ? void 0 : _a[1];
    if (url && server === "warezcdn") {
      embeds.push(
        { embedId: warezcdnembedHlsScraper.id, url },
        { embedId: warezcdnembedMp4Scraper.id, url },
        { embedId: warezPlayerScraper.id, url }
      );
    } else if (url && server === "mixdrop") embeds.push({ embedId: mixdropScraper.id, url });
  }
  return { embeds };
}
const warezcdnScraper = makeSourcerer({
  id: "warezcdn",
  name: "WarezCDN",
  disabled: true,
  rank: 115,
  flags: [],
  scrapeMovie: async (ctx) => {
    if (!ctx.media.imdbId) throw new NotFoundError("This source requires IMDB id.");
    const serversPage = await ctx.proxiedFetcher(`/filme/${ctx.media.imdbId}`, {
      baseUrl: warezcdnBase
    });
    const [, id, servers] = serversPage.match(/let\s+data\s*=\s*'\[\s*\{\s*"id":"([^"]+)".*?"servers":"([^"]+)"/);
    if (!id || !servers) throw new NotFoundError("Failed to find episode id");
    ctx.progress(40);
    return getEmbeds(id, servers, ctx);
  }
  // scrapeShow: async (ctx) => {
  //   if (!ctx.media.imdbId) throw new NotFoundError('This source requires IMDB id.');
  //   const url = `${warezcdnBase}/serie/${ctx.media.imdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  //   const serversPage = await ctx.proxiedFetcher<string>(url);
  //   const seasonsApi = serversPage.match(/var\s+cachedSeasons\s*=\s*"([^"]+)"/)?.[1];
  //   if (!seasonsApi) throw new NotFoundError('Failed to find data');
  //   ctx.progress(40);
  //   const streamsData = await ctx.proxiedFetcher<cachedSeasonsRes>(seasonsApi, {
  //     baseUrl: warezcdnBase,
  //     headers: {
  //       Referer: url,
  //       'X-Requested-With': 'XMLHttpRequest',
  //     },
  //   });
  //   const season = Object.values(streamsData.seasons).find((s) => s.name === ctx.media.season.number.toString());
  //   if (!season) throw new NotFoundError('Failed to find season id');
  //   const episode = Object.values(season.episodes).find((e) => e.name === ctx.media.season.number.toString())?.id;
  //   if (!episode) throw new NotFoundError('Failed to find episode id');
  //   const episodeData = await ctx.proxiedFetcher<string>('/core/ajax.php', {
  //     baseUrl: warezcdnBase,
  //     headers: {
  //       Referer: url,
  //       'X-Requested-With': 'XMLHttpRequest',
  //     },
  //     query: { audios: episode },
  //   });
  //   const [, id, servers] = episodeData.replace(/\\"/g, '"').match(/"\[\s*\{\s*"id":"([^"]+)".*?"servers":"([^"]+)"/)!;
  //   if (!id || !servers) throw new NotFoundError('Failed to find episode id');
  //   return getEmbeds(id, servers, ctx);
  // },
});
const baseUrl$1 = "https://watchanimeworld.in";
const zephyrBaseUrl = "https://play.zephyrflick.top";
const tmdbApiKey = "5b9790d9305dca8713b9a0afad42ea8d";
async function fetchTMDBData(tmdbId, mediaType) {
  const endpoint = mediaType === "movie" ? "movie" : "tv";
  const response = await fetch(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${tmdbApiKey}`);
  if (!response.ok) {
    throw new NotFoundError("Failed to fetch TMDB data");
  }
  const data = await response.json();
  if (mediaType === "movie") {
    const movieData = data;
    return movieData.title || movieData.original_title;
  }
  const showData = data;
  return showData.name || showData.original_name;
}
function normalizeTitle(title) {
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
}
async function comboScraper$2(ctx) {
  const isTVShow = "season" in ctx.media;
  const endpoint = isTVShow ? "tv" : "movie";
  const title = await fetchTMDBData(ctx.media.tmdbId, endpoint);
  const normalizedTitle = normalizeTitle(title);
  let watchUrl;
  if (ctx.media.type === "movie") {
    watchUrl = `${baseUrl$1}/movies/${normalizedTitle}/`;
  } else {
    const season = ctx.media.season.number;
    const episode = ctx.media.episode.number;
    watchUrl = `${baseUrl$1}/episode/${normalizedTitle}-${season}x${episode}/`;
  }
  ctx.progress(30);
  const watchPage = await ctx.proxiedFetcher(watchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
  });
  const $ = load(watchPage);
  const iframeSrc = $("iframe[data-src]").attr("data-src") || $("iframe[src]").attr("src");
  if (!iframeSrc) {
    throw new NotFoundError("No iframe found on watch page");
  }
  const hashMatch = iframeSrc.match(/\/video\/([a-f0-9]+)/);
  if (!hashMatch) {
    throw new NotFoundError("Could not extract video hash from iframe");
  }
  const videoHash = hashMatch[1];
  ctx.progress(60);
  const apiUrl2 = `${zephyrBaseUrl}/player/index.php?data=${videoHash}&do=getVideo`;
  const streamResponse = await ctx.proxiedFetcher(apiUrl2, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Referer: `${zephyrBaseUrl}/`,
      Origin: zephyrBaseUrl,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: `data=${videoHash}&do=getVideo`
  });
  const streamData = JSON.parse(streamResponse);
  if (!streamData.hls || !streamData.videoSource) {
    throw new NotFoundError("No HLS stream found");
  }
  ctx.progress(90);
  const streamHeaders = {
    Referer: `${zephyrBaseUrl}/`,
    Origin: zephyrBaseUrl,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  };
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "hls",
        playlist: streamData.videoSource,
        headers: streamHeaders,
        flags: [flags.CORS_ALLOWED],
        captions: []
      }
    ]
  };
}
const watchanimeworldScraper = makeSourcerer({
  id: "watchanimeworld",
  name: "WatchAnimeWorld",
  rank: 116,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$2,
  scrapeShow: comboScraper$2
});
const baseUrl = "https://wecima.tube";
async function comboScraper$1(ctx) {
  const searchPage = await ctx.proxiedFetcher(`/search/${encodeURIComponent(ctx.media.title)}/`, {
    baseUrl
  });
  const search$ = load(searchPage);
  const firstResult = search$(".Grid--WecimaPosts .GridItem a").first();
  if (!firstResult.length) throw new NotFoundError("No results found");
  const contentUrl = firstResult.attr("href");
  if (!contentUrl) throw new NotFoundError("No content URL found");
  ctx.progress(30);
  const contentPage = await ctx.proxiedFetcher(contentUrl, { baseUrl });
  const content$ = load(contentPage);
  let embedUrl;
  if (ctx.media.type === "movie") {
    embedUrl = content$('meta[itemprop="embedURL"]').attr("content");
  } else {
    const seasonLinks = content$(".List--Seasons--Episodes a");
    let seasonUrl;
    for (const element of seasonLinks) {
      const text = content$(element).text().trim();
      if (text.includes(`موسم ${ctx.media.season}`)) {
        seasonUrl = content$(element).attr("href");
        break;
      }
    }
    if (!seasonUrl) throw new NotFoundError(`Season ${ctx.media.season} not found`);
    const seasonPage = await ctx.proxiedFetcher(seasonUrl, { baseUrl });
    const season$ = load(seasonPage);
    const episodeLinks = season$(".Episodes--Seasons--Episodes a");
    for (const element of episodeLinks) {
      const epTitle = season$(element).find("episodetitle").text().trim();
      if (epTitle === `الحلقة ${ctx.media.episode}`) {
        const episodeUrl = season$(element).attr("href");
        if (episodeUrl) {
          const episodePage = await ctx.proxiedFetcher(episodeUrl, { baseUrl });
          const episode$ = load(episodePage);
          embedUrl = episode$('meta[itemprop="embedURL"]').attr("content");
        }
        break;
      }
    }
  }
  if (!embedUrl) throw new NotFoundError("No embed URL found");
  ctx.progress(60);
  const embedPage = await ctx.proxiedFetcher(embedUrl);
  const embed$ = load(embedPage);
  const videoSource = embed$('source[type="video/mp4"]').attr("src");
  if (!videoSource) throw new NotFoundError("No video source found");
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [],
        headers: {
          referer: baseUrl
        },
        qualities: {
          unknown: {
            type: "mp4",
            url: videoSource
          }
        },
        captions: []
      }
    ]
  };
}
const wecimaScraper = makeSourcerer({
  id: "wecima",
  name: "Wecima (Arabic)",
  rank: 3,
  disabled: false,
  flags: [],
  scrapeMovie: comboScraper$1,
  scrapeShow: comboScraper$1
});
async function comboScraper(ctx) {
  const anilistId = await getAnilistIdFromMedia(ctx, ctx.media);
  const query = {
    type: ctx.media.type,
    title: ctx.media.title,
    tmdbId: ctx.media.tmdbId,
    imdbId: ctx.media.imdbId,
    anilistId,
    ...ctx.media.type === "show" && {
      season: ctx.media.season.number,
      episode: ctx.media.episode.number
    },
    ...ctx.media.type === "movie" && { episode: 1 },
    releaseYear: ctx.media.releaseYear
  };
  return {
    embeds: [
      {
        embedId: "zunime-hd-2",
        url: JSON.stringify(query)
      },
      {
        embedId: "zunime-miko",
        url: JSON.stringify(query)
      },
      {
        embedId: "zunime-shiro",
        url: JSON.stringify(query)
      },
      {
        embedId: "zunime-zaza",
        url: JSON.stringify(query)
      }
    ]
  };
}
const zunimeScraper = makeSourcerer({
  id: "zunime",
  name: "Zunime",
  rank: 114,
  flags: [],
  scrapeShow: comboScraper
});
function gatherAllSources() {
  return [
    fsOnlineScraper,
    dopeboxScraper,
    cuevana3Scraper,
    ridooMoviesScraper,
    hdRezkaScraper,
    warezcdnScraper,
    insertunitScraper,
    soaperTvScraper,
    autoembedScraper,
    myanimeScraper,
    tugaflixScraper,
    ee3Scraper,
    fsharetvScraper,
    zoechipScraper,
    mp4hydraScraper,
    embedsuScraper,
    slidemoviesScraper,
    vidapiClickScraper,
    coitusScraper,
    streamboxScraper,
    nunflixScraper,
    EightStreamScraper,
    wecimaScraper,
    animeflvScraper,
    animekaiScraper,
    FedAPIScraper,
    pirxcyScraper,
    vidsrcvipScraper,
    rgshowsScraper,
    vidifyScraper,
    zunimeScraper,
    vidnestScraper,
    animetsuScraper,
    lookmovieScraper,
    turbovidSourceScraper,
    pelisplushdScraper,
    primewireScraper,
    movies4fScraper,
    debridScraper,
    cinehdplusScraper,
    fullhdfilmizleScraper,
    vidlinkScraper,
    vidrockScraper,
    watchanimeworldScraper,
    // Zangetsu providers (HiAnime, 4KHDHub, HDHub4u, VegaMovies, ...)
    ...zangetsuSourcerers
  ];
}
function gatherAllEmbeds() {
  return [
    ...fsOnlineEmbeds,
    ...dopeboxEmbeds,
    serverMirrorEmbed,
    upcloudScraper,
    vidCloudScraper,
    mixdropScraper,
    ridooScraper,
    closeLoadScraper,
    doodScraper,
    streamvidScraper,
    streamtapeScraper,
    warezcdnembedHlsScraper,
    warezcdnembedMp4Scraper,
    warezPlayerScraper,
    autoembedEnglishScraper,
    autoembedHindiScraper,
    autoembedBengaliScraper,
    autoembedTamilScraper,
    autoembedTeluguScraper,
    turbovidScraper,
    mp4hydraServer1Scraper,
    mp4hydraServer2Scraper,
    VidsrcsuServer1Scraper,
    VidsrcsuServer2Scraper,
    VidsrcsuServer3Scraper,
    VidsrcsuServer4Scraper,
    VidsrcsuServer5Scraper,
    VidsrcsuServer6Scraper,
    VidsrcsuServer7Scraper,
    VidsrcsuServer8Scraper,
    VidsrcsuServer9Scraper,
    VidsrcsuServer10Scraper,
    VidsrcsuServer11Scraper,
    VidsrcsuServer12Scraper,
    VidsrcsuServer20Scraper,
    viperScraper,
    streamwishJapaneseScraper,
    streamwishLatinoScraper,
    streamwishSpanishScraper,
    streamwishEnglishScraper,
    streamtapeLatinoScraper,
    ...cinemaosEmbeds,
    // ...cinemaosHexaEmbeds,
    // vidsrcNovaEmbed,
    // vidsrcCometEmbed,
    // vidsrcPulsarEmbed,
    ...vidifyEmbeds,
    ...zunimeEmbeds,
    ...AnimetsuEmbeds,
    ...VidnestEmbeds,
    myanimesubScraper,
    myanimedubScraper,
    filemoonScraper,
    vidhideLatinoScraper,
    vidhideSpanishScraper,
    vidhideEnglishScraper,
    filelionsScraper,
    droploadScraper,
    supervideoScraper,
    voeScraper,
    AnimekaiScraper
  ];
}
function getBuiltinSources() {
  return gatherAllSources().filter((v) => !v.disabled && !v.externalSource);
}
function getBuiltinExternalSources() {
  return gatherAllSources().filter((v) => v.externalSource && !v.disabled);
}
function getBuiltinEmbeds() {
  return gatherAllEmbeds().filter((v) => !v.disabled);
}
function findDuplicates(items, keyFn) {
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key2 = keyFn(item);
    if (!groups.has(key2)) {
      groups.set(key2, []);
    }
    groups.get(key2).push(item);
  }
  return Array.from(groups.entries()).filter(([_, groupItems]) => groupItems.length > 1).map(([key2, groupItems]) => ({ key: key2, items: groupItems }));
}
function formatDuplicateError(type, duplicates, keyName) {
  const duplicateList = duplicates.map(({ key: key2, items }) => {
    const itemNames = items.map((item) => item.name || item.id).join(", ");
    return `  ${keyName} ${key2}: ${itemNames}`;
  }).join("\n");
  return `${type} have duplicate ${keyName}s:
${duplicateList}`;
}
function getProviders(features, list) {
  const sources = list.sources.filter((v) => !(v == null ? void 0 : v.disabled));
  const embeds = list.embeds.filter((v) => !(v == null ? void 0 : v.disabled));
  const combined = [...sources, ...embeds];
  const duplicateIds = findDuplicates(combined, (v) => v.id);
  if (duplicateIds.length > 0) {
    throw new Error(formatDuplicateError("Sources/embeds", duplicateIds, "ID"));
  }
  const duplicateSourceRanks = findDuplicates(sources, (v) => v.rank);
  if (duplicateSourceRanks.length > 0) {
    throw new Error(formatDuplicateError("Sources", duplicateSourceRanks, "rank"));
  }
  const duplicateEmbedRanks = findDuplicates(embeds, (v) => v.rank);
  if (duplicateEmbedRanks.length > 0) {
    throw new Error(formatDuplicateError("Embeds", duplicateEmbedRanks, "rank"));
  }
  return {
    sources: sources.filter((s) => flagsAllowedInFeatures(features, s.flags)),
    embeds: embeds.filter((e) => flagsAllowedInFeatures(features, e.flags))
  };
}
function makeProviders(ops) {
  var _a;
  const features = getTargetFeatures(
    ops.proxyStreams ? "any" : ops.target,
    ops.consistentIpForRequests ?? false,
    ops.proxyStreams
  );
  const sources = [...getBuiltinSources()];
  if (ops.externalSources === "all") sources.push(...getBuiltinExternalSources());
  else {
    (_a = ops.externalSources) == null ? void 0 : _a.forEach((source) => {
      const matchingSource = getBuiltinExternalSources().find((v) => v.id === source);
      if (!matchingSource) return;
      sources.push(matchingSource);
    });
  }
  const list = getProviders(features, {
    embeds: getBuiltinEmbeds(),
    sources
  });
  return makeControls({
    embeds: list.embeds,
    sources: list.sources,
    features,
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    proxyStreams: ops.proxyStreams
  });
}
function buildProviders() {
  let consistentIpForRequests = false;
  let target = null;
  let fetcher = null;
  let proxiedFetcher = null;
  const embeds = [];
  const sources = [];
  const builtinSources = getBuiltinSources();
  const builtinExternalSources = getBuiltinExternalSources();
  const builtinEmbeds = getBuiltinEmbeds();
  return {
    enableConsistentIpForRequests() {
      consistentIpForRequests = true;
      return this;
    },
    setFetcher(f) {
      fetcher = f;
      return this;
    },
    setProxiedFetcher(f) {
      proxiedFetcher = f;
      return this;
    },
    setTarget(t) {
      target = t;
      return this;
    },
    addSource(input) {
      if (typeof input !== "string") {
        sources.push(input);
        return this;
      }
      const matchingSource = [...builtinSources, ...builtinExternalSources].find((v) => v.id === input);
      if (!matchingSource) throw new Error("Source not found");
      sources.push(matchingSource);
      return this;
    },
    addEmbed(input) {
      if (typeof input !== "string") {
        embeds.push(input);
        return this;
      }
      const matchingEmbed = builtinEmbeds.find((v) => v.id === input);
      if (!matchingEmbed) throw new Error("Embed not found");
      embeds.push(matchingEmbed);
      return this;
    },
    addBuiltinProviders() {
      sources.push(...builtinSources);
      embeds.push(...builtinEmbeds);
      return this;
    },
    build() {
      if (!target) throw new Error("Target not set");
      if (!fetcher) throw new Error("Fetcher not set");
      const features = getTargetFeatures(target, consistentIpForRequests);
      const list = getProviders(features, {
        embeds,
        sources
      });
      return makeControls({
        fetcher,
        proxiedFetcher: proxiedFetcher ?? void 0,
        embeds: list.embeds,
        sources: list.sources,
        features
      });
    }
  };
}
const isReactNative = () => {
  try {
    require("react-native");
    return true;
  } catch (e) {
    return false;
  }
};
function serializeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) {
    if (body instanceof URLSearchParams && isReactNative()) {
      return {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      };
    }
    return {
      headers: {},
      body
    };
  }
  return {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}
function getHeaders(list, res) {
  const output = new Headers();
  list.forEach((header) => {
    var _a;
    const realHeader = header.toLowerCase();
    const realValue = res.headers.get(realHeader);
    const extraValue = (_a = res.extraHeaders) == null ? void 0 : _a.get(realHeader);
    const value = extraValue ?? realValue;
    if (!value) return;
    output.set(realHeader, value);
  });
  return output;
}
function makeStandardFetcher(f) {
  const normalFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const controller = new AbortController();
    const timeout = 15e3;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await f(fullUrl, {
        method: ops.method,
        headers: {
          ...seralizedBody.headers,
          ...ops.headers
        },
        body: seralizedBody.body,
        credentials: ops.credentials,
        signal: controller.signal
        // Pass the signal to fetch
      });
      clearTimeout(timeoutId);
      let body;
      const contentType = (_a = res.headers.get("content-type")) == null ? void 0 : _a.toLowerCase();
      const isJson = contentType == null ? void 0 : contentType.includes("application/json");
      const isBinary = (contentType == null ? void 0 : contentType.includes("application/wasm")) || (contentType == null ? void 0 : contentType.includes("application/octet-stream")) || (contentType == null ? void 0 : contentType.includes("binary"));
      if (res.status === 204) {
        body = null;
      } else if (isJson) {
        body = await res.json();
      } else if (isBinary) {
        body = await res.arrayBuffer();
      } else {
        body = await res.text();
      }
      return {
        body,
        finalUrl: res.extraUrl ?? res.url,
        headers: getHeaders(ops.readHeaders, res),
        statusCode: res.status
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Fetch request to ${fullUrl} timed out after ${timeout}ms`);
      }
      throw error;
    }
  };
  return normalFetch;
}
const headerMap = {
  cookie: "X-Cookie",
  referer: "X-Referer",
  origin: "X-Origin",
  "user-agent": "X-User-Agent",
  "x-real-ip": "X-X-Real-Ip"
};
const responseHeaderMap = {
  "x-set-cookie": "Set-Cookie"
};
function makeSimpleProxyFetcher(proxyUrl, f) {
  const proxiedFetch = async (url, ops) => {
    const fetcher = makeStandardFetcher(async (a, b) => {
      const controller = new AbortController();
      const timeout = 2e4;
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await f(a, {
          method: (b == null ? void 0 : b.method) || "GET",
          headers: (b == null ? void 0 : b.headers) || {},
          body: b == null ? void 0 : b.body,
          credentials: b == null ? void 0 : b.credentials,
          signal: controller.signal
          // Pass the signal to fetch
        });
        clearTimeout(timeoutId);
        res.extraHeaders = new Headers();
        Object.entries(responseHeaderMap).forEach((entry) => {
          var _a;
          const value = res.headers.get(entry[0]);
          if (!value) return;
          (_a = res.extraHeaders) == null ? void 0 : _a.set(entry[1].toLowerCase(), value);
        });
        res.extraUrl = res.headers.get("X-Final-Destination") ?? res.url;
        return res;
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(`Fetch request to ${a} timed out after ${timeout}ms`);
        }
        throw error;
      }
    });
    const fullUrl = makeFullUrl(url, ops);
    const headerEntries = Object.entries(ops.headers).map((entry) => {
      const key2 = entry[0].toLowerCase();
      if (headerMap[key2]) return [headerMap[key2], entry[1]];
      return entry;
    });
    return fetcher(proxyUrl, {
      ...ops,
      query: {
        destination: fullUrl
      },
      headers: Object.fromEntries(headerEntries),
      baseUrl: void 0
    });
  };
  return proxiedFetch;
}
export {
  NotFoundError,
  buildProviders,
  createM3U8ProxyUrl,
  flags,
  getBuiltinEmbeds,
  getBuiltinExternalSources,
  getBuiltinSources,
  getM3U8ProxyUrl,
  labelToLanguageCode,
  makeProviders,
  makeSimpleProxyFetcher,
  makeStandardFetcher,
  setM3U8ProxyUrl,
  targets,
  updateM3U8ProxyUrl
};
