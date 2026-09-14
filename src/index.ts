export interface Env {
  ALLOWED_ORIGIN?: string;
}

type UnknownMap = Record<string, unknown>;

// Bounded hot cache and shared requests within a worker isolate.
const memoryCache = new Map<string, {expires: number; body: string}>();
const pendingRequests = new Map<string, Promise<{expires: number; body: string}>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, {status: 204, headers: cors});
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({status: "ok", service: "e0-stations-worker"}, 200, cors);
      }

      if (request.method !== "POST") {
        return json({error: "Use POST."}, 405, cors);
      }

      const data = await readJson(request);
      if (url.pathname === "/searchStations") {
        return await cachedJson(url, data, cors, 21600, () => searchStations(data, env), ctx);
      }
      if (url.pathname === "/searchStationsBounds") {
        return await cachedJson(url, data, cors, 21600, () => searchStationsBounds(data, env), ctx);
      }
      if (url.pathname === "/searchStationsText") {
        return await cachedJson(url, data, cors, 21600, () => searchStationsText(data, env), ctx);
      }
      if (url.pathname === "/getStationDetails") {
        return await cachedJson(url, data, cors, 86400, () => getStationDetails(data, env), ctx);
      }
      if (url.pathname === "/getPlacePhoto") {
        return json(await getPlacePhoto(data, env), 200, cors);
      }
      return json({error: "Unknown endpoint."}, 404, cors);
    } catch (error) {
      const message =
        error instanceof PublicError
          ? error.message
          : "Station data is temporarily unavailable.";
      const status = error instanceof PublicError ? error.status : 503;
      const details = error instanceof PublicError ? error.details : undefined;
      if (!(error instanceof PublicError)) console.error(error);
      return json({error: message, ...(details ? {details} : {})}, status, cors);
    }
  },
};

async function searchStations(data: UnknownMap, env: Env): Promise<UnknownMap> {
  const latitude = finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude = finiteNumber(data.longitude, "longitude", -180, 180);
  const radiusMeters = finiteNumber(
    data.radiusMeters,
    "search radius",
    250,
    50000,
  );
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 100),
  );
  return overpassNearbyStations(latitude, longitude, radiusMeters, maxResults);
}

async function searchStationsBounds(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const south = finiteNumber(data.south, "south latitude", -90, 90);
  const west = finiteNumber(data.west, "west longitude", -180, 180);
  const north = finiteNumber(data.north, "north latitude", -90, 90);
  const east = finiteNumber(data.east, "east longitude", -180, 180);
  if (south >= north) {
    throw new PublicError(400, "Invalid viewport latitude range.");
  }
  if (west >= east) {
    throw new PublicError(400, "Invalid viewport longitude range.");
  }
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 80, "result count", 1, 150),
  );
  return overpassBoundsStations({south, west, north, east}, maxResults);
}

async function searchStationsText(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const query = typeof data.query === "string" ? data.query.trim() : "";
  if (query.length < 2 || query.length > 120) {
    throw new PublicError(400, "Search must contain 2 to 120 characters.");
  }
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 60),
  );
  const latitude =
    data.latitude === undefined
      ? null
      : finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude =
    data.longitude === undefined
      ? null
      : finiteNumber(data.longitude, "longitude", -180, 180);
  return overpassTextStations(query, latitude, longitude, maxResults);
}

async function getStationDetails(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const rawPlaceId = typeof data.placeId === "string" ? data.placeId : "";
  const osmId = parseOsmPlaceId(rawPlaceId);
  if (!osmId) {
    throw new PublicError(400, "Invalid OpenStreetMap station ID.");
  }
  return overpassStationDetails(osmId);
}

async function getPlacePhoto(_data: UnknownMap, _env: Env): Promise<UnknownMap> {
  return {photoUri: null};
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpassNearbyStations(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  maxResults: number,
): Promise<UnknownMap> {
  const radius = Math.min(Math.trunc(radiusMeters), 50000);
  const query = `[out:json][timeout:2];(
    node["amenity"="fuel"](around:${radius},${latitude},${longitude});
    way["amenity"="fuel"](around:${radius},${latitude},${longitude});
    relation["amenity"="fuel"](around:${radius},${latitude},${longitude});
  );out body center qt ${maxResults};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    stations = await fetchPhotonNearby(latitude, longitude, radius / 1000, maxResults);
  }
  return {stations: stations.slice(0, maxResults)};
}

type Bounds = {south: number; west: number; north: number; east: number};

async function overpassBoundsStations(
  bounds: Bounds,
  maxResults: number,
): Promise<UnknownMap> {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(",");
  const query = `[out:json][timeout:2];
    nwr["amenity"="fuel"](${bbox});
    out body center qt ${maxResults};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    stations = await fetchPhotonNearby(centerLat, centerLon, 20, maxResults);
  }
  return {stations: stations.filter(station =>
    typeof station.latitude === "number" && typeof station.longitude === "number" &&
    station.latitude >= bounds.south && station.latitude <= bounds.north &&
    station.longitude >= bounds.west && station.longitude <= bounds.east
  ).slice(0, maxResults)};
}

async function overpassTextStations(
  queryText: string,
  latitude: number | null,
  longitude: number | null,
  maxResults: number,
): Promise<UnknownMap> {
  // A geocoder resolves names/cities quickly; only use the broader scan as fallback.
  try {
    const stations = await fetchPhotonText(queryText, latitude, longitude, maxResults);
    if (stations.length > 0) return {stations};
  } catch {}
  const term = escapeOverpassRegex(queryText);
  const countryPattern = "^(IN|AE|QA|SA|KW|MV|US|FR|OM|BH)$";
  const query = `[out:json][timeout:2];
    area["ISO3166-1"~"${countryPattern}"]["admin_level"="2"]->.searchCountries;
    (
      node["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      node["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      node["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
    );out body center qt ${Math.min(maxResults * 3, 60)};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    if (response === null) throw new PublicError(503, "Station sources are temporarily unavailable.");
  } else if (latitude !== null && longitude !== null) {
    stations.sort(
      (a, b) => stationDistanceKm(a, latitude, longitude) - stationDistanceKm(b, latitude, longitude),
    );
  }
  return {stations: stations.slice(0, maxResults)};
}

async function overpassStationDetails(osmId: OsmPlaceId): Promise<UnknownMap> {
  // Nodes include coordinates in the element API; ways/relations need Overpass centers.
  if (osmId.type === "node") {
    try {
      const data = await upstreamJson(
        "https://api.openstreetmap.org/api/0.6/node/" + osmId.id + ".json", {}, 1500);
      const station = sanitizeOsmStations(data.elements)[0] ?? null;
      if (station) return {station};
    } catch {}
  }
  const query = "[out:json][timeout:1];" + osmId.type + "(" + osmId.id + ");out body center 1;";
  const response = await overpassRequest(query, 1000);
  return {station: sanitizeOsmStations(response.elements)[0] ?? null};
}

async function upstreamJson(url: string, init: RequestInit = {}, timeoutMs = 2000): Promise<UnknownMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": "E0FinderBot/1.0 (+https://e0finder.com)",
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new PublicError(503, "Station source is unavailable.");
    return objectValue(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

async function overpassRequest(query: string, timeoutMs = 3000): Promise<UnknownMap> {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = await upstreamJson(endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
        body: new URLSearchParams({data: query}),
      }, timeoutMs);
      if (Array.isArray(body.elements) && !body.remark) return body;
    } catch {}
  }
  throw new PublicError(503, "Station sources are temporarily unavailable.");
}

async function fetchPhotonNearby(
  lat: number, lon: number, radiusKm: number, maxResults: number,
): Promise<UnknownMap[]> {
  return (await fetchPhotonText("fuel", lat, lon, maxResults))
    .filter(station => stationDistanceKm(station, lat, lon) <= radiusKm)
    .sort((a, b) => stationDistanceKm(a, lat, lon) - stationDistanceKm(b, lat, lon));
}

async function fetchPhotonText(
  query: string, lat: number | null, lon: number | null, maxResults: number,
): Promise<UnknownMap[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("osm_tag", "amenity:fuel");
  url.searchParams.set("limit", String(Math.min(maxResults, 50)));
  if (lat !== null && lon !== null) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
  }
  const data = await upstreamJson(url.toString());
  if (!Array.isArray(data.features)) throw new PublicError(503, "Invalid station source response.");
  return parsePhotonFeatures(data.features).slice(0, maxResults);
}

function parsePhotonFeatures(features: any[]): UnknownMap[] {
  const results: UnknownMap[] = [];
  for (const f of features) {
    const geom = f.geometry || {};
    const coords = geom.coordinates || [];
    const props = f.properties || {};
    if (coords.length < 2 || props.osm_key !== "amenity" || props.osm_value !== "fuel" ||
        !Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) ||
        Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) continue;
    const fLon = coords[0];
    const fLat = coords[1];
    const rawType = String(props.osm_type || "N").toUpperCase();
    const type = rawType === "W" ? "way" : rawType === "R" ? "relation" : "node";
    const osmId = props.osm_id;
    if (!Number.isSafeInteger(osmId) || osmId <= 0 || !["N", "W", "R"].includes(rawType)) continue;
    const name = props.name || props.street || "Fuel Station";
    const address = [props.street, props.city, props.state, props.country].filter(Boolean).join(", ") || `Near ${name}`;
    results.push({
      placeId: `osm:${type}:${osmId}`,
      name,
      address,
      latitude: fLat,
      longitude: fLon,
      sourceUri: `https://www.openstreetmap.org/${type}/${osmId}`,
      primaryType: "gas_station",
      phone: null,
      isOpen: null,
      openingHours: [],
      rating: null,
      reviewCount: null,
      fuelTypes: [],
      fuelPriceType: null,
      price: null,
      currency: "INR",
      priceUpdatedAt: null,
      photoResourceName: null,
      photoAttributions: [],
    });
  }
  return results;
}

function sanitizeOsmStations(value: unknown): UnknownMap[] {
  return (Array.isArray(value) ? value : [])
    .map(sanitizeOsmPlace)
    .filter((station): station is UnknownMap => station !== null);
}

function sanitizeOsmPlace(value: unknown): UnknownMap | null {
  const element = objectValue(value);
  const tags = objectValue(element.tags);
  const center = objectValue(element.center);
  const latitude =
    typeof element.lat === "number"
      ? element.lat
      : typeof center.lat === "number"
        ? center.lat
        : null;
  const longitude =
    typeof element.lon === "number"
      ? element.lon
      : typeof center.lon === "number"
        ? center.lon
        : null;
  const type = typeof element.type === "string" ? element.type : "";
  const id = typeof element.id === "number" ? Math.trunc(element.id) : null;
  if (!type || id === null || latitude === null || longitude === null) return null;

  const name = [tags.name, tags["name:en"], tags.brand, tags.operator]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .find((value) => !/^(pump|pumps|petrolpump|petrolpumps|fuelstation|gasstation|petrolstation)$/i.test(value.replace(/[^a-z0-9]/gi, "")))
    ?.trim() || "Unnamed fuel station";
  return {
    placeId: `osm:${type}:${id}`,
    name,
    brand: firstText(tags.brand, tags.operator),
    address: osmAddress(tags),
    latitude,
    longitude,
    sourceUri: `https://www.openstreetmap.org/${type}/${id}`,
    primaryType: "gas_station",
    phone: firstText(tags.phone, tags["contact:phone"]),
    isOpen: null,
    openingHours: typeof tags.opening_hours === "string" ? [tags.opening_hours] : [],
    rating: null,
    reviewCount: null,
    fuelTypes: osmFuelTypes(tags),
    fuelPriceType: null,
    price: null,
    currency: "INR",
    priceUpdatedAt: null,
    photoResourceName: null,
    photoAttributions: [],
  };
}

function osmAddress(tags: UnknownMap): string {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
    tags["addr:state"],
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : "Address unavailable";
}

function osmFuelTypes(tags: UnknownMap): string[] {
  const fuels = [
    ["fuel:diesel", "Diesel"],
    ["fuel:petrol", "Petrol"],
    ["fuel:octane_91", "Petrol 91"],
    ["fuel:octane_95", "Petrol 95"],
    ["fuel:octane_98", "Petrol 98"],
    ["fuel:electricity", "EV charging"],
    ["fuel:cng", "CNG"],
    ["fuel:lpg", "LPG"],
  ];
  return fuels
    .filter(([key]) => tags[key] === "yes")
    .map(([, label]) => label);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function escapeOverpassRegex(value: string): string {
  return value.replace(/[\\"\[\]().*+?^${}|]/g, "\\$&");
}

function stationDistanceKm(station: UnknownMap, latitude: number, longitude: number): number {
  const stationLat = typeof station.latitude === "number" ? station.latitude : null;
  const stationLng = typeof station.longitude === "number" ? station.longitude : null;
  if (stationLat === null || stationLng === null) return Number.POSITIVE_INFINITY;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(stationLat - latitude);
  const deltaLng = toRadians(stationLng - longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latitude)) *
      Math.cos(toRadians(stationLat)) *
      Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type OsmPlaceId = {type: "node" | "way" | "relation"; id: number};

function parseOsmPlaceId(value: string): OsmPlaceId | null {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(value);
  if (!match) return null;
  return {type: match[1] as OsmPlaceId["type"], id: Number(match[2])};
}

async function readJson(request: Request): Promise<UnknownMap> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicError(400, "Invalid request.");
  }
  return value as UnknownMap;
}

function objectValue(value: unknown): UnknownMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownMap)
    : {};
}

function finiteNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new PublicError(400, "Invalid " + name + ".");
  }
  return value;
}

async function cachedJson(
  url: URL, data: UnknownMap, cors: HeadersInit, ttlSeconds: number,
  producer: () => Promise<UnknownMap>, ctx: ExecutionContext,
): Promise<Response> {
  const keyUrl = new URL(url);
  keyUrl.pathname = "/__cache/v3" + url.pathname;
  keyUrl.search = "";
  keyUrl.searchParams.set("query", stableCacheKey(data));
  const key = keyUrl.toString();
  const now = Date.now();
  const memory = memoryCache.get(key);
  if (memory && memory.expires > now) {
    return cachedResponse(memory.body, cors, memory.expires, "HIT-MEM");
  }
  memoryCache.delete(key);
  const cacheKey = new Request(key);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const expires = Number(hit.headers.get("X-E0-Expires"));
      if (Number.isFinite(expires) && expires > now) {
        const body = await hit.text();
        remember(key, body, expires);
        return cachedResponse(body, cors, expires, "HIT-EDGE");
      }
    }
  } catch {}

  let pending = pendingRequests.get(key);
  if (!pending) {
    pending = (async () => {
      const body = await producer(); // Errors are never cached as empty results.
      const empty = Array.isArray(body.stations) ? body.stations.length === 0 : !body.station;
      const expires = Date.now() + Math.min(ttlSeconds, empty ? 60 : ttlSeconds) * 1000;
      const serialized = JSON.stringify(body);
      remember(key, serialized, expires);
      const response = cachedResponse(serialized, cors, expires, "MISS");
      try {
        ctx.waitUntil(caches.default.put(cacheKey, response).catch(() => {}));
      } catch {}
      return {body: serialized, expires};
    })();
    pendingRequests.set(key, pending);
  }
  try {
    const result = await pending;
    return cachedResponse(result.body, cors, result.expires, "MISS");
  } finally {
    if (pendingRequests.get(key) === pending) pendingRequests.delete(key);
  }
}

function remember(key: string, body: string, expires: number): void {
  memoryCache.delete(key);
  memoryCache.set(key, {body, expires});
  while (memoryCache.size > 256) memoryCache.delete(memoryCache.keys().next().value!);
}

function cachedResponse(body: string, cors: HeadersInit, expires: number, status: string): Response {
  return new Response(body, {headers: {
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=" + Math.max(0, Math.floor((expires - Date.now()) / 1000)),
    "X-E0-Expires": String(expires),
    "X-E0-Cache": status,
  }});
}

function json(
  body: unknown,
  status: number,
  cors: HeadersInit,
  cacheControl = "no-store",
  cacheStatus?: "HIT" | "MISS",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...(cacheStatus ? {"X-E0-Cache": cacheStatus} : {}),
      ...cors,
    },
  });
}

function stableCacheKey(data: UnknownMap): string {
  return encodeURIComponent(JSON.stringify(canonicalCacheValue(data)));
}

function canonicalCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCacheValue);
  if (!value || typeof value !== "object") {
    return value;
  }
  const source = value as UnknownMap;
  const normalized: UnknownMap = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    normalized[key] = canonicalCacheValue(item);
  }
  return normalized;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

class PublicError extends Error {
  readonly status: number;
  readonly details?: UnknownMap;
  constructor(
    status: number,
    message: string,
    details?: UnknownMap,
  ) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
