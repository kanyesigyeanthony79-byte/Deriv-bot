
import json
import websocket

DERIV_URL = "wss://api.derivws.com/trading/v1/options/ws/public"

def main():
    print("Connecting to Deriv...")

    ws = websocket.create_connection(
        DERIV_URL,
        timeout=20,
        origin="https://app.deriv.com"
    )

    print("Connected successfully!")

    request = {
        "ticks_history": "R_10",
        "count": 5,
        "end": "latest",
        "style": "candles",
        "granularity": 900,
        "req_id": 1
    }

    ws.send(json.dumps(request))

    while True:
        response = json.loads(ws.recv())

        if response.get("req_id") == 1:
            break

    ws.close()

    if "error" in response:
        raise Exception(response["error"]["message"])

    candles = response.get("candles", [])

    print("Market: Volatility 10")
    print("Candles received:", len(candles))

    for candle in candles:
        print(candle)

    if not candles:
        raise Exception("No candle data received")

    print("DERIV CONNECTION TEST PASSED")

if __name__ == "__main__":
    main()
