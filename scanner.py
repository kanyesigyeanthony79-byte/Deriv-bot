
import os
import json
import time
import urllib.request
import websocket

DERIV_URL = "wss://api.derivws.com/trading/v1/options/ws/public"
TIMEFRAME = 900
MARKETS = {
    "R_10": "Volatility 10",
    "R_25": "Volatility 25",
    "R_50": "Volatility 50",
    "R_75": "Volatility 75",
    "JD100": "Jump 100"
}

STATE_FILE = "signal_state.json"


def ema(values, period):
    if len(values) < period:
        return None

    result = sum(values[:period]) / period
    multiplier = 2 / (period + 1)

    for value in values[period:]:
        result = (value * multiplier) + (result * (1 - multiplier))

    return result


def rsi(values, period=14):
    changes = [values[i] - values[i-1]
               for i in range(1, len(values))]

    if len(changes) < period:
        return None

    gains = [max(x, 0) for x in changes[:period]]
    losses = [max(-x, 0) for x in changes[:period]]

    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    for change in changes[period:]:
        avg_gain = (avg_gain * 13 + max(change, 0)) / 14
        avg_loss = (avg_loss * 13 + max(-change, 0)) / 14

    if avg_loss == 0:
        return 100

    return 100 - (100 / (1 + avg_gain / avg_loss))


def atr(candles, period=14):
    if len(candles) < period + 1:
        return None

    ranges = []

    for i in range(1, len(candles)):
        current = candles[i]
        previous = candles[i-1]

        tr = max(
            current["high"] - current["low"],
            abs(current["high"] - previous["close"]),
            abs(current["low"] - previous["close"])
        )
        ranges.append(tr)

    return sum(ranges[-period:]) / period


def get_candles(symbol):
    ws = websocket.create_connection(
        DERIV_URL,
        timeout=20,
        origin="https://app.deriv.com"
    )

    try:
        ws.send(json.dumps({
            "ticks_history": symbol,
            "count": 150,
            "end": "latest",
            "style": "candles",
            "granularity": TIMEFRAME,
            "req_id": 1
        }))

        while True:
            response = json.loads(ws.recv())

            if response.get("req_id") == 1:
                break

        if "error" in response:
            raise Exception(response["error"]["message"])

        return response["candles"], int(response["pip_size"])

    finally:
        ws.close()


def load_state():
    try:
        with open(STATE_FILE) as file:
            return json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    with open(STATE_FILE, "w") as file:
        json.dump(state, file, indent=2)


def send_telegram(payload):
    worker_url = os.environ.get("TELEGRAM_WORKER_URL")
    api_key = os.environ.get("SIGNAL_API_KEY")

    if not worker_url or not api_key:
        raise Exception("Telegram GitHub secrets are missing")

    request = urllib.request.Request(
        worker_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key
        },
        method="POST"
    )

    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.loads(response.read().decode())

    if not result.get("success"):
        raise Exception("Telegram Worker rejected the signal")

    return result


def scan_market(symbol, name, state):
    print(f"\nScanning {name}...")

    raw_candles, precision = get_candles(symbol)

    now = int(time.time())

    candles = [
        c for c in raw_candles
        if int(c["epoch"]) + TIMEFRAME <= now
    ]

    if len(candles) < 60:
        print("Not enough completed candles")
        return

    closes = [float(c["close"]) for c in candles]

    fast_ema = ema(closes, 20)
    slow_ema = ema(closes, 50)
    current_rsi = rsi(closes, 14)
    current_atr = atr(candles, 14)

    if None in (fast_ema, slow_ema, current_rsi, current_atr):
        print("Indicator calculation incomplete")
        return

    last = candles[-1]
    entry = closes[-1]

    direction = None

    if (
        fast_ema > slow_ema
        and entry > fast_ema
        and 50 < current_rsi < 70
        and last["close"] > last["open"]
    ):
        direction = "BUY"

    elif (
        fast_ema < slow_ema
        and entry < fast_ema
        and 30 < current_rsi < 50
        and last["close"] < last["open"]
    ):
        direction = "SELL"

    print(
        f"EMA20={fast_ema:.5f}, "
        f"EMA50={slow_ema:.5f}, "
        f"RSI={current_rsi:.2f}, "
        f"ATR={current_atr:.5f}"
    )

    if not direction:
        print("No qualifying signal")
        return

    candle_id = f'{last["epoch"]}:{direction}'

    if state.get(symbol) == candle_id:
        print("Duplicate signal skipped")
        return

    distance = current_atr * 1.5

    if direction == "BUY":
        stop = entry - distance
        tp1 = entry + (distance * 2)
        tp2 = entry + (distance * 3)
    else:
        stop = entry + distance
        tp1 = entry - (distance * 2)
        tp2 = entry - (distance * 3)

    payload = {
        "market": name,
        "direction": direction,
        "entry": round(entry, precision),
        "stopLoss": round(stop, precision),
        "tp1": round(tp1, precision),
        "tp2": round(tp2, precision)
    }

    print("Qualifying signal:", json.dumps(payload))

    result = send_telegram(payload)

    state[symbol] = candle_id
    save_state(state)

    print("Telegram delivery:", result["message"])


def main():
    print("DERIV HOSTED SCANNER STARTED")
    state = load_state()

    for symbol, name in MARKETS.items():
        try:
            scan_market(symbol, name, state)
        except Exception as error:
            print(f"Error scanning {name}: {error}")

    print("\nSCANNER FINISHED")


if __name__ == "__main__":
    main()
