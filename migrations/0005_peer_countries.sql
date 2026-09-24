-- hourly peer country concentration from GeoIP (aggregates only, no raw addresses stored)
CREATE TABLE IF NOT EXISTS daily_peer_countries (
  date TEXT, country TEXT, country_code TEXT, peers INTEGER,
  PRIMARY KEY (date, country)
);
