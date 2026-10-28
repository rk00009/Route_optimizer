
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { allocation } = require("./allocation");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_AGENT = "RouteOptimizerStudentProject/1.0 (local development app)";
const MAX_ROUTE_POINTS = 101;

async function getJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      ...extraHeaders
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Provider returned HTTP ${response.status}`);
  }

  return response.json();
}

async function withFallback(urls, label) {
  let lastError;

  for (const url of urls) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `${label} is unavailable from this computer. Tried ${urls.length} provider(s). ` +
    `Last error: ${lastError?.message || "unknown error"}`
  );
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });

  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, "." + decodeURIComponent(safePath));

  if (
    !filePath.startsWith(PUBLIC_DIR + path.sep) &&
    filePath !== path.join(PUBLIC_DIR, "index.html")
  ) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return res.end("Not found");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function normalizePhotonResults(data, query) {
  const features = Array.isArray(data?.features) ? data.features : [];

  return features
    .filter(feature => {
      const coords = feature?.geometry?.coordinates;
      return Array.isArray(coords) &&
        Number.isFinite(coords[0]) &&
        Number.isFinite(coords[1]);
    })
    .map(feature => {
      const p = feature.properties || {};
      const label = [
        p.name,
        p.street,
        p.housenumber,
        p.city || p.town || p.village,
        p.state,
        p.postcode,
        p.country
      ].filter(Boolean).join(", ");

      return {
        lat: String(feature.geometry.coordinates[1]),
        lon: String(feature.geometry.coordinates[0]),
        display_name: label || query,
        provider: "Photon",
        matched_query: query,
        type: p.type || "",
        confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : null
      };
    });
}

function buildGeocodeQueries(cleaned) {
  const queries = [cleaned];
  const withoutNearLandmark = cleaned
    .replace(/\bnear\b[^,;]*/i, "")
    .replace(/,\s*,/g, ",")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();

  if (withoutNearLandmark && withoutNearLandmark !== cleaned) {
    queries.push(withoutNearLandmark);
  }

  const parts = cleaned.split(",").map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const localityQueries = [
      parts.slice(-3).join(", "),
      parts.slice(-2).join(", ")
    ];
    localityQueries.forEach(localityQuery => {
      if (localityQuery !== cleaned && !queries.includes(localityQuery)) {
        queries.push(localityQuery);
      }
    });
  }

  return queries;
}

async function geocodeAddress(query) {
  const cleaned = query.trim();
  const queries = buildGeocodeQueries(cleaned);
  let lastError = null;

  for (const searchQuery of queries) {
    try {
      const url =
        "https://photon.komoot.io/api/?q=" +
        encodeURIComponent(searchQuery) +
        "&limit=8&lang=en";
      const data = await getJson(url);
      const photonResults = normalizePhotonResults(data, searchQuery)
        .map(result => ({ ...result, broad_match: searchQuery !== cleaned }));
      if (photonResults.length) return deduplicateResults(photonResults);
    } catch (error) {
      lastError = error;
      console.warn("Photon lookup failed:", error.message);
    }
  }

  for (const searchQuery of queries) {
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1&countrycodes=in&q=" +
        encodeURIComponent(searchQuery);
      const results = await getJson(url, { "Accept-Language": "en" });
      const normalized = Array.isArray(results) ? results
        .filter(item => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)))
        .map(item => ({
          lat: String(item.lat),
          lon: String(item.lon),
          display_name: item.display_name || searchQuery,
          provider: "Nominatim",
          matched_query: searchQuery,
          broad_match: searchQuery !== cleaned,
          type: item.type || "",
          category: item.category || ""
        })) : [];
      if (normalized.length) return deduplicateResults(normalized);
    } catch (error) {
      lastError = error;
      console.warn("Nominatim lookup failed:", error.message);
    }
  }

  for (const searchQuery of queries) {
    try {
      const url =
        "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=8&forStorage=false&singleLine=" +
        encodeURIComponent(searchQuery);
      const data = await getJson(url);
      const normalized = Array.isArray(data?.candidates) ? data.candidates
        .filter(item =>
          Number.isFinite(Number(item?.location?.y)) &&
          Number.isFinite(Number(item?.location?.x))
        )
        .map(item => ({
          lat: String(item.location.y),
          lon: String(item.location.x),
          display_name: item.address || searchQuery,
          provider: "ArcGIS",
          matched_query: searchQuery,
          broad_match: searchQuery !== cleaned,
          confidence: Number.isFinite(Number(item.score)) ? Number(item.score) : null
        })) : [];
      if (normalized.length) return deduplicateResults(normalized);
    } catch (error) {
      lastError = error;
      console.warn("ArcGIS lookup failed:", error.message);
    }
  }

  if (lastError) {
    throw new Error(
      "Address lookup service is unavailable. Check your internet connection and try again."
    );
  }

  return [];
}

function deduplicateResults(results) {
  const seen = new Set();
  return results.filter(result => {
    const key = `${Number(result.lat).toFixed(6)},${Number(result.lon).toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    if (req.method === "POST" && url.pathname === "/api/allocate") {
      const input = await readJsonBody(req);
      return sendJson(res, 200, allocation(input));
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "Route Optimizer backend"
      });
    }

    if (url.pathname === "/api/geocode") {
      const query = (url.searchParams.get("q") || "").trim();

      if (!query) {
        return sendJson(res, 400, {
          error: "Please provide an address to search."
        });
      }

      const results = await geocodeAddress(query);
      return sendJson(res, 200, results);
    }

    if (
      url.pathname === "/api/table" ||
      url.pathname === "/api/route"
    ) {
      const coordinates =
        (url.searchParams.get("coordinates") || "").trim();

      const coordinatePattern =
        /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?(?:;-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)*$/;

      if (!coordinatePattern.test(coordinates)) {
        return sendJson(res, 400, {
          error: "Invalid coordinates sent to routing service."
        });
      }

      const points = coordinates.split(";").map(pair => pair.split(",").map(Number));
      if (
        points.length < 2 ||
        points.length > MAX_ROUTE_POINTS ||
        points.some(([lon, lat]) =>
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          lat < -90 ||
          lat > 90 ||
          lon < -180 ||
          lon > 180
        )
      ) {
        return sendJson(res, 400, {
          error: `Provide between 2 and ${MAX_ROUTE_POINTS} valid coordinate pairs.`
        });
      }

      const isTable = url.pathname === "/api/table";

      const suffix = isTable
        ? "?annotations=distance,duration"
        : "?overview=full&geometries=geojson&steps=false";

      const providers = isTable
        ? [
            `https://router.project-osrm.org/table/v1/driving/${coordinates}${suffix}`,
            `https://routing.openstreetmap.de/routed-car/table/v1/driving/${coordinates}${suffix}`
          ]
        : [
            `https://router.project-osrm.org/route/v1/driving/${coordinates}${suffix}`,
            `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordinates}${suffix}`
          ];

      const result = await withFallback(
        providers,
        isTable ? "Road-distance service" : "Road route service"
      );

      if (result.code !== "Ok") {
        return sendJson(res, 502, {
          error: result.message ||
            "The routing provider could not calculate this route."
        });
      }

      return sendJson(res, 200, result);
    }

    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(`[${req.method} ${url.pathname}]`, error.message);

    return sendJson(res, 502, {
      error: error.message || "A backend request failed."
    });
  }
});

server.listen(PORT, () => {
  console.log(`Route Optimizer running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
