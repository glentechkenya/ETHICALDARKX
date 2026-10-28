#!/bin/bash
cd "$(dirname "$0")/cloudflared"
exec ../cloudflared-bin tunnel --config ./config.yml run --protocol http2
