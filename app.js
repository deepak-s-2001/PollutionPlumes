const { useState, useEffect, useRef, useCallback } = React;

/* =======================================================
   CONFIG
   ======================================================= */
const PLUME = {
  // particle density & limits
  baseParticles: 140,
  maxParticlesPerMonitor: 450,

  // motion (Leaflet is in degrees; we step in deg/frame)
  speedFactorDeg: 0.010,      // raise for faster motion
  noiseAngleScale: 0.1,       // radians of angle modulation
  noiseSpaceLat: 80,           // spatial frequency (lat)
  noiseSpaceLon: 90,           // spatial frequency (lon)
  noiseTime: 0.00028,          // temporal frequency

  // trail behavior
  fadeAmount: 0.03,            // lower = longer visual trails
  maxRangeDeg: 0.08,           // how far a particle can travel before death

  // continuous spawner
  spawnPerSec: 80,             // particles/sec per monitor (scaled by pollution)
  initialBurst: 140,           // seed on activation/first draw

  // visuals
  color: { r: 239, g: 68, b: 68 },
  minSize: 1.6,
  maxSize: 6.0,

  // zoom behavior
  minZoomActive: 4,

  // --- Spread controls (NEW) ---
  spreadAngleMult: 10.0,   // multiplies angular variation; e.g., 1.5 = wider, 0.7 = tighter
  crosswindDrift: 0.0,    // adds sideways drift (0..~1). 0 keeps current look.
  spawnRadiusMult: 1.0,   // scales initial spawn radius (1.5 = wider origin)
  spawnAngleJitter: 1.0,  // scales initial spawn angle jitter (1.5 = wider origin fan)

};

/* =======================================================
   HELPERS
   ======================================================= */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function createParticleForMonitor(m, windAngle) {
  // Start slightly upwind/around station
  const lat0 = m.lat;
  const lon0 = m.lon;
  const backAngle = windAngle + Math.PI + (Math.random() - 0.5) * 0.5 * PLUME.spawnAngleJitter;
  const r = (Math.random() * 0.003 + 0.0002) * PLUME.spawnRadiusMult;
  return {
    lat: lat0 + Math.cos(backAngle) * r,
    lon: lon0 + Math.sin(backAngle) * r,
    life: Math.random() * 0.2,
    nseed: Math.random() * 1000,
    speed:
      (m.windSpeed / 1000) *
      PLUME.speedFactorDeg *
      (0.7 + Math.random() * 0.8),
    dead: false
  };
}

const getAQIColor = (aqi) =>
  aqi <= 50 ? "#10b981" :
  aqi <= 100 ? "#fbbf24" :
  aqi <= 150 ? "#f97316" :
  aqi <= 200 ? "#ef4444" :
  aqi <= 300 ? "#a855f7" : "#991b1b";

const getAQILabel = (aqi) =>
  aqi <= 50 ? "Good" :
  aqi <= 100 ? "Moderate" :
  aqi <= 150 ? "Unhealthy for Sensitive Groups" :
  aqi <= 200 ? "Unhealthy" :
  aqi <= 300 ? "Very Unhealthy" : "Hazardous";

const getDirectionDesc = (deg) => {
  const dirs = [
    "North", "Northeast", "East", "Southeast",
    "South", "Southwest", "West", "Northwest"
  ];
  return dirs[Math.round(deg / 45) % 8];
};

/* Simple demo wind-rose data generator (replace with real histograms if available) */
function getWindRoseData(monitor) {
  return [
    { angle: 0,   frequency: 8,  avgAQI: 45 },
    { angle: 45,  frequency: 12, avgAQI: 62 },
    { angle: 90,  frequency: 15, avgAQI: 58 },
    { angle: 135, frequency: 18, avgAQI: 71 },
    { angle: 180, frequency: 22, avgAQI: 95 },
    { angle: 225, frequency: 25, avgAQI: monitor.aqi },
    { angle: 270, frequency: 14, avgAQI: 67 },
    { angle: 315, frequency: 10, avgAQI: 52 }
  ];
}

/* =======================================================
   APP
   ======================================================= */
const AQIPollutionTracker = () => {
  // state
  const [selectedMonitor, setSelectedMonitor] = useState(null);
  const [showAllTracking, setShowAllTracking] = useState(false);
  const [visualizationType, setVisualizationType] = useState("particles");
  const [showWindRose, setShowWindRose] = useState(false);

  // refs
  const mapRef = useRef(null);
  const canvasRef = useRef(null);
  const markersRef = useRef([]);
  const animationRef = useRef(null);
  const lastTsRef = useRef(performance.now());

  // demo monitors
  const monitors = [
    {
      id: 1, name: "Downtown Detroit",
      lat: 42.3314, lon: -83.0458,
      aqi: 142, pm25: 58.4, pm10: 82.1, o3: 33, no2: 30, so2: 11, co: 26,
      windSpeed: 11, windDirection: 240, dominantPollutant: "PM2.5"
    },
    {
      id: 2, name: "Dearborn",
      lat: 42.3223, lon: -83.1763,
      aqi: 168, pm25: 72.3, pm10: 95.8, o3: 28, no2: 35, so2: 15, co: 32,
      windSpeed: 13, windDirection: 225, dominantPollutant: "PM2.5"
    },
    {
      id: 3, name: "Belle Isle",
      lat: 42.3387, lon: -82.9853,
      aqi: 98, pm25: 38.2, pm10: 52.4, o3: 45, no2: 22, so2: 8, co: 18,
      windSpeed: 15, windDirection: 270, dominantPollutant: "PM2.5"
    }
  ];

  /* ---------------------------------------
     1) Init Leaflet + overlay canvas + markers
     --------------------------------------- */
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map("leaflet-map", { zoomControl: true })
      .setView([42.3314, -83.0458], 12);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO" }
    ).addTo(map);

    mapRef.current = map;

    // canvas overlay in overlayPane
    const canvas = document.createElement("canvas");
    canvas.className = "particle-canvas";
    canvas.style.background = "transparent";
    map.getPanes().overlayPane.appendChild(canvas);
    canvasRef.current = canvas;

    // init per-monitor particle & spawn state
    monitors.forEach(m => {
      m._particles = [];
      m._spawnAccum = 0;
    });

    // size/align canvas
    const resizeCanvas = () => {
      const size = map.getSize();
      canvas.width = size.x;
      canvas.height = size.y;
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);
    };

    resizeCanvas();
    map.on("resize", resizeCanvas);
    map.on("zoomstart", resizeCanvas);
    map.on("zoomend", resizeCanvas);
    new ResizeObserver(resizeCanvas)
      .observe(document.getElementById("leaflet-map"));

    // keep aligned while panning
    map.on("move", () => {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);
    });

    // markers
    const markerHTML =
      `<div class="monitor-marker"><div class="ring"></div><div class="dot"></div></div>`;
    markersRef.current = monitors.map((m) => {
      const mk = L.marker([m.lat, m.lon], {
        icon: L.divIcon({ className: "", html: markerHTML, iconSize: [0, 0] })
      }).addTo(map);

      mk.on("click", () => {
        // activate only this monitor
        setSelectedMonitor(m);
        setShowAllTracking(false);
        setShowWindRose(false); // reset rose when changing selection
      });

      return { monitor: m, marker: mk };
    });
  }, []);

  /* ---------------------------------------
     2) Animation frame
     --------------------------------------- */
  const frame = useCallback(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) {
      animationRef.current = requestAnimationFrame(frame);
      return;
    }

    const ctx = canvas.getContext("2d");
    const topLeft = map.containerPointToLayerPoint([0, 0]);

    // Ghost-free fade (BEFORE translate)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${PLUME.fadeAmount})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "lighter";

    // Now align to Leaflet pane
    ctx.translate(-topLeft.x, -topLeft.y);

    // Bail out if too zoomed out
    if (map.getZoom() < PLUME.minZoomActive) {
      animationRef.current = requestAnimationFrame(frame);
      return;
    }

    // Active sources: ONLY selected, unless "Show All" is on
    const sources = showAllTracking
      ? markersRef.current.map(({ monitor }) => monitor)
      : selectedMonitor ? [selectedMonitor] : [];

    const now = performance.now();
    const prev = lastTsRef.current;
    let dt = (now - prev) / 1000;
    dt = clamp(dt, 0, 0.08); // avoid huge steps on tab switches
    lastTsRef.current = now;

    for (const m of sources) {
      const windAngle = (m.windDirection * Math.PI) / 180;

      // scale density by pollution
      const scale = Math.min(1, (m.pm25 || m.aqi || 100) / 150);

      // initial seeding if needed
      if (m._particles.length === 0 && PLUME.initialBurst > 0) {
        const n0 = Math.round(PLUME.initialBurst * scale);
        for (let i = 0; i < n0; i++) {
          m._particles.push(createParticleForMonitor(m, windAngle));
        }
      }

      // continuous spawning at a steady rate
      m._spawnAccum += (PLUME.spawnPerSec * scale) * dt;
      let toSpawn = Math.floor(m._spawnAccum);
      if (toSpawn > 0) {
        const room =
          PLUME.maxParticlesPerMonitor - m._particles.length;
        toSpawn = Math.min(toSpawn, Math.max(0, room));
        for (let i = 0; i < toSpawn; i++) {
          m._particles.push(createParticleForMonitor(m, windAngle));
        }
        m._spawnAccum -= toSpawn;
      }

      // update & draw
      for (const p of m._particles) {
        // smooth vector field (base wind + coherent noise)
        const n =
          Math.sin(
            (p.lat * PLUME.noiseSpaceLat +
             p.lon * PLUME.noiseSpaceLon +
             now * PLUME.noiseTime) * 2 * Math.PI
          ) * 0.6 +
          Math.cos(
            (p.lat * (PLUME.noiseSpaceLat * 0.8) -
             now * PLUME.noiseTime * 1.3) * 2 * Math.PI
          ) * 0.4;

        const localAngle = windAngle + n * PLUME.noiseAngleScale * PLUME.spreadAngleMult;
        // distance from source (before moving) to scale sideways drift
        const dLatSrc0 = p.lat - m.lat;
        const dLonSrc0 = p.lon - m.lon;
        const dist0 = Math.hypot(dLatSrc0, dLonSrc0);
        const distNorm = Math.min(1, dist0 / PLUME.maxRangeDeg); // 0 near source → 1 far


        // integrate (deg); correct lon step for latitude
        const cosLat = Math.max(0.15, Math.cos((p.lat * Math.PI) / 180));

        // forward motion along localAngle
        const dLat = Math.sin(localAngle) * p.speed;
        const dLon = Math.cos(localAngle) * (p.speed / cosLat);
        
        // small sideways drift (perpendicular to localAngle), grows with distance
        const perpLat = Math.sin(localAngle + Math.PI / 2);
        const perpLon = Math.cos(localAngle + Math.PI / 2) / cosLat;
        const cw = PLUME.crosswindDrift * distNorm * p.speed;

        p.lat += dLat + perpLat * cw;
        p.lon += dLon + perpLon * cw;

        p.life += 0.002;

        // death conditions
        const dLatSrc = p.lat - m.lat;
        const dLonSrc = p.lon - m.lon;
        const dist = Math.hypot(dLatSrc, dLonSrc);
        if (dist > PLUME.maxRangeDeg || p.life > 2.2) {
          p.dead = true;
          continue;
        }

        // draw
        const pt = map.latLngToLayerPoint([p.lat, p.lon]);
        const density = 1 - Math.min(dist / PLUME.maxRangeDeg, 1);
        const size = clamp(2 + 5 * density, PLUME.minSize, PLUME.maxSize);
        const alpha = Math.max(0.10, 0.85 * density * (1 - p.life * 0.5));
        const { r, g, b } = PLUME.color;

        const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, size);
        grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // prune dead
      m._particles = m._particles.filter(p => !p.dead);
    }

    ctx.globalCompositeOperation = "source-over";
    animationRef.current = requestAnimationFrame(frame);
  }, [selectedMonitor, showAllTracking]);

  // (re)start animation on dep changes
  useEffect(() => {
    cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationRef.current);
  }, [frame]);

  /* ---------------------------------------
     RENDER
     --------------------------------------- */
  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <h1>Detroit Metro AQI & Pollution Transport</h1>
        <div className="info-bar">
          <div className="info-box">
            <svg className="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <p>
              Click a monitor to animate only that site’s pollution transport. Use “Show Pollutant Tracking”
              to view all monitors at once.
            </p>
          </div>
          <button
            className={`btn ${showAllTracking ? "btn-success" : "btn-primary"}`}
            onClick={() => {
              setShowAllTracking(prev => {
                const next = !prev;
                if (next) {
                  setSelectedMonitor(null);
                  setShowWindRose(false);
                }
                return next;
              });
            }}
          >
            {showAllTracking ? "✓ Showing All Monitors" : "Show Pollutant Tracking"}
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="controls">
        <button
          className={`btn-control ${visualizationType === "particles" ? "active" : ""}`}
          onClick={() => setVisualizationType("particles")}
        >
          Particle Transport
        </button>
        <button
          className={`btn-control ${showWindRose ? "active" : ""}`}
          onClick={() => setShowWindRose(v => !v)}
          disabled={!selectedMonitor}
          title={selectedMonitor ? "Toggle Wind Rose" : "Select a monitor to view Wind Rose"}
        >
          {showWindRose ? "Hide Wind Rose" : "View Wind Rose"}
        </button>
      </div>

      {/* Main */}
      <div className="main-content">
        <div className="map-container">
          <div id="leaflet-map"></div>
        </div>

        {/* Sidebar */}
        <div className={`sidebar ${selectedMonitor ? "open" : ""}`}>
          {selectedMonitor && (
            <>
              <div className="sidebar-header">
                <h2>{selectedMonitor.name}</h2>
                <button
                  className="close-btn"
                  onClick={() => {
                    setSelectedMonitor(null);
                    setShowWindRose(false);
                  }}
                >
                  ✕
                </button>
              </div>

              <div className="sidebar-content">
                {/* AQI summary */}
                <div
                  className="aqi-summary"
                  style={{
                    backgroundColor: getAQIColor(selectedMonitor.aqi) + "20",
                    color: getAQIColor(selectedMonitor.aqi)
                  }}
                >
                  <div
                    className="aqi-circle"
                    style={{
                      backgroundColor: getAQIColor(selectedMonitor.aqi),
                      color: "white"
                    }}
                  >
                    <div className="aqi-label">{selectedMonitor.dominantPollutant}</div>
                    <div>{selectedMonitor.aqi}</div>
                  </div>
                  <div style={{ fontWeight: 600 }}>{getAQILabel(selectedMonitor.aqi)}</div>
                </div>

                {/* Pollutants grid */}
                <div className="pollutants-grid">
                  {[
                    { k: "pm25", l: "PM₂․₅", u: "µg/m³" },
                    { k: "pm10", l: "PM₁₀", u: "µg/m³" },
                    { k: "o3",  l: "O₃",   u: "ppb"   },
                    { k: "no2", l: "NO₂",  u: "ppb"   },
                    { k: "so2", l: "SO₂",  u: "ppb"   },
                    { k: "co",  l: "CO",   u: "ppb"   }
                  ].map(({ k, l, u }) => (
                    <div key={k} className="pollutant-card">
                      <div className="pollutant-label">{l}</div>
                      <div className="pollutant-value">{selectedMonitor[k]}</div>
                      <div className="pollutant-unit">{u}</div>
                    </div>
                  ))}
                </div>

                {/* Wind info */}
                <div className="wind-info-box">
                  <div className="wind-info-label">Wind Speed</div>
                  <div className="wind-info-value">{selectedMonitor.windSpeed} mph</div>
                  <div className="wind-info-label">Direction</div>
                  <div className="wind-info-value">
                    {getDirectionDesc(selectedMonitor.windDirection)} ({selectedMonitor.windDirection}°)
                  </div>
                </div>

                {/* Wind Rose Toggle Panel */}
                {showWindRose && (
                  <div className="wind-rose-container">
                    <div className="wind-rose-header">
                      <div className="wind-rose-title">Wind Rose</div>
                    </div>

                    <div className="wind-rose-svg-container">
                      <svg viewBox="-30 -30 60 60" style={{ width: "100%", height: "100%" }}>
                        {/* rings */}
                        <circle r="25" fill="rgba(0,0,0,0.05)" stroke="#ddd" strokeWidth="0.5" />
                        <circle r="16" fill="none" stroke="#ddd" strokeWidth="0.5" />
                        <circle r="8"  fill="none" stroke="#ddd" strokeWidth="0.5" />

                        {/* cardinal labels */}
                        {["N","E","S","W"].map((dir, i) => {
                          const angle = i * 90 - 90;
                          const rad = (angle * Math.PI) / 180;
                          const x = Math.cos(rad) * 28;
                          const y = Math.sin(rad) * 28;
                          return (
                            <text
                              key={dir}
                              x={x}
                              y={y}
                              textAnchor="middle"
                              fontSize="3"
                              fill="#666"
                              fontWeight="bold"
                            >
                              {dir}
                            </text>
                          );
                        })}

                        {/* petals */}
                        {getWindRoseData(selectedMonitor).map((d, idx) => {
                          const angle = d.angle - 90;
                          const length = (d.frequency / 25) * 22;
                          const color = getAQIColor(d.avgAQI);
                          const spread = 20;

                          const x1 = Math.cos(((angle - spread) * Math.PI) / 180) * length;
                          const y1 = Math.sin(((angle - spread) * Math.PI) / 180) * length;
                          const x2 = Math.cos(((angle + spread) * Math.PI) / 180) * length;
                          const y2 = Math.sin(((angle + spread) * Math.PI) / 180) * length;

                          return (
                            <path
                              key={idx}
                              d={`M 0 0 L ${x1} ${y1} L ${x2} ${y2} Z`}
                              fill={color}
                              opacity="0.85"
                              stroke={color}
                              strokeWidth="0.3"
                            />
                          );
                        })}

                        <circle r="1.5" fill="white" stroke="#999" strokeWidth="0.3" />
                      </svg>
                    </div>

                    <div className="wind-rose-description">
                      Petal size encodes frequency of winds from each direction; color shows typical AQI along those paths.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<AQIPollutionTracker />);