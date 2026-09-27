-- City-level peer concentration from GeoIP. Aggregates only: one row per
-- (date, country_code, city) carrying the GeoIP representative coordinates and
-- a peer count — no raw peer addresses are stored. Powers the /network
-- "node locations" cluster map alongside daily_peer_countries.
CREATE TABLE IF NOT EXISTS daily_peer_cities (
  date TEXT NOT NULL,
  country TEXT NOT NULL,
  country_code TEXT NOT NULL,
  city TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  peers INTEGER NOT NULL,
  PRIMARY KEY (date, country_code, city)
);
CREATE INDEX IF NOT EXISTS idx_peer_cities_date ON daily_peer_cities (date);
