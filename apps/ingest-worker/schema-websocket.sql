-- Create enum for candle intervals
CREATE TYPE candle_interval AS ENUM ('1m', '5m', '15m', '1h', '1d');

-- Create enum for data sources
CREATE TYPE data_source AS ENUM ('ws', 'api');

-- Create enum for WebSocket status
CREATE TYPE ws_status AS ENUM ('online', 'offline', 'degraded');

-- Market candles table for historical OHLC data
CREATE TABLE market_candles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    instrument_key TEXT NOT NULL, -- Denormalized for performance (matches instruments.provider_instrument_key)
    interval candle_interval NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL, -- Start of the time bucket
    open NUMERIC NOT NULL,
    high NUMERIC NOT NULL,
    low NUMERIC NOT NULL,
    close NUMERIC NOT NULL,
    volume NUMERIC,
    source data_source NOT NULL DEFAULT 'ws',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Ensure no duplicate candles for same instrument/interval/time bucket
    UNIQUE(instrument_key, interval, bucket_start)
);

-- Partition by month for better performance (adjust as needed)
-- CREATE TABLE market_candles_y2026m04 PARTITION OF market_candles
-- FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Instrument status table for WebSocket health monitoring
CREATE TABLE instrument_status (
    instrument_key TEXT PRIMARY KEY, -- Matches instruments.provider_instrument_key
    ws_status ws_status NOT NULL DEFAULT 'offline',
    last_ws_ts TIMESTAMPTZ, -- Last successful WebSocket tick
    last_api_ts TIMESTAMPTZ, -- Last successful API fallback
    heartbeat_ts TIMESTAMPTZ, -- Last heartbeat/pong from WS
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- WebSocket failures audit table
CREATE TABLE ws_failures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_key TEXT NOT NULL,
    failure_type TEXT NOT NULL, -- 'connection_lost', 'reconnect_failed', 'parse_error', etc.
    failure_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error_message TEXT,
    recovered_ts TIMESTAMPTZ, -- When connection was restored
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_market_candles_instrument_key_interval_time ON market_candles(instrument_key, interval, bucket_start DESC);
CREATE INDEX idx_market_candles_bucket_start ON market_candles(bucket_start DESC);
CREATE INDEX idx_market_candles_instrument_id ON market_candles(instrument_id);

CREATE INDEX idx_instrument_status_ws_status ON instrument_status(ws_status);
CREATE INDEX idx_instrument_status_last_ws_ts ON instrument_status(last_ws_ts DESC);

CREATE INDEX idx_ws_failures_instrument_key ON ws_failures(instrument_key);
CREATE INDEX idx_ws_failures_failure_ts ON ws_failures(failure_ts DESC);
CREATE INDEX idx_ws_failures_recovered_ts ON ws_failures(recovered_ts) WHERE recovered_ts IS NOT NULL;

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at
CREATE TRIGGER update_market_candles_updated_at BEFORE UPDATE ON market_candles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_instrument_status_updated_at BEFORE UPDATE ON instrument_status FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) - adjust as needed for your auth system
ALTER TABLE market_candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE ws_failures ENABLE ROW LEVEL SECURITY;

-- Policies (example - adjust based on your auth requirements)
-- CREATE POLICY "Allow all operations for authenticated users" ON market_candles FOR ALL USING (auth.role() = 'authenticated');
-- CREATE POLICY "Allow all operations for authenticated users" ON instrument_status FOR ALL USING (auth.role() = 'authenticated');
-- CREATE POLICY "Allow all operations for authenticated users" ON ws_failures FOR ALL USING (auth.role() = 'authenticated');</content>
<parameter name="filePath">r:\Projects\Stock\apps\ingest-worker\schema-websocket.sql