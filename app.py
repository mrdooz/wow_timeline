import hashlib
import json
import os
import time
import requests
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

CACHE_DIR = os.environ.get("CACHE_DIR") or os.path.join(os.path.dirname(__file__), "cache")

# --- WarcraftLogs API Client ---

CLIENT_ID = None
CLIENT_SECRET = None
TOKEN = None
TOKEN_EXPIRES = 0

API_URL = "https://www.warcraftlogs.com/api/v2/client"
TOKEN_URL = "https://www.warcraftlogs.com/oauth/token"


def load_credentials():
    global CLIENT_ID, CLIENT_SECRET
    env_id = os.environ.get("WCL_CLIENT_ID")
    env_secret = os.environ.get("WCL_CLIENT_SECRET")
    if env_id and env_secret:
        CLIENT_ID = env_id
        CLIENT_SECRET = env_secret
        return
    with open("credentials.json") as f:
        creds = json.load(f)
    CLIENT_ID = creds["client_id"]
    CLIENT_SECRET = creds["client_secret"]


def get_token():
    global TOKEN, TOKEN_EXPIRES
    if TOKEN and time.time() < TOKEN_EXPIRES:
        return TOKEN
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "client_credentials",
    }, auth=(CLIENT_ID, CLIENT_SECRET))
    resp.raise_for_status()
    data = resp.json()
    TOKEN = data["access_token"]
    TOKEN_EXPIRES = time.time() + data.get("expires_in", 3600) - 60
    return TOKEN


def graphql(query, variables=None):
    token = get_token()
    resp = requests.post(API_URL, json={
        "query": query,
        "variables": variables or {},
    }, headers={"Authorization": f"Bearer {token}"})
    resp.raise_for_status()
    result = resp.json()
    if "errors" in result:
        raise Exception(f"GraphQL errors: {result['errors']}")
    return result["data"]


def cache_get(key):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, hashlib.sha256(key.encode()).hexdigest() + ".json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


def cache_set(key, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, hashlib.sha256(key.encode()).hexdigest() + ".json")
    with open(path, "w") as f:
        json.dump(data, f)


def fetch_fights(code):
    cached = cache_get(f"fights:{code}")
    if cached is not None:
        return cached

    query = """
    query($code: String!) {
        reportData {
            report(code: $code) {
                title
                fights(killType: Encounters) {
                    id
                    encounterID
                    name
                    kill
                    startTime
                    endTime
                    difficulty
                    bossPercentage
                }
            }
        }
    }
    """
    data = graphql(query, {"code": code})
    report = data["reportData"]["report"]
    fights = report["fights"]
    for f in fights:
        f["duration"] = (f["endTime"] - f["startTime"]) / 1000.0
    result = {"title": report["title"], "fights": fights}
    cache_set(f"fights:{code}", result)
    return result


def fetch_timeline(code, fight_id):
    cached = cache_get(f"timeline:{code}:{fight_id}")
    if cached is not None:
        return cached

    # First get fight info and master data
    meta_query = """
    query($code: String!) {
        reportData {
            report(code: $code) {
                masterData {
                    abilities { gameID name icon }
                    actors { id name type subType }
                }
                fights(killType: Encounters) {
                    id
                    name
                    startTime
                    endTime
                    difficulty
                    kill
                    bossPercentage
                }
            }
        }
    }
    """
    meta = graphql(meta_query, {"code": code})
    report = meta["reportData"]["report"]
    fight = next(f for f in report["fights"] if f["id"] == fight_id)

    abilities_map = {a["gameID"]: a for a in report["masterData"]["abilities"]}
    actors_map = {a["id"]: a for a in report["masterData"]["actors"]}

    start = fight["startTime"]
    end = fight["endTime"]

    # Fetch boss casts
    boss_casts = fetch_all_events(code, fight_id, start, end, "Casts", "Enemies")

    # Fetch raid damage taken
    damage_taken = fetch_all_events(code, fight_id, start, end, "DamageTaken", "Friendlies")

    # Fetch deaths
    deaths = fetch_all_events(code, fight_id, start, end, "Deaths", "Friendlies")

    # Process boss casts into timeline entries
    cast_entries = []
    for event in boss_casts:
        game_id = event.get("abilityGameID", 0)
        ability_info = abilities_map.get(game_id, {})
        cast_entries.append({
            "time": (event["timestamp"] - start) / 1000.0,
            "ability": ability_info.get("name", f"Unknown ({game_id})"),
            "abilityIcon": ability_info.get("icon", ""),
            "gameID": game_id,
            "source": actors_map.get(event.get("sourceID"), {}).get("name", "Boss"),
        })

    # Aggregate damage taken into 1-second buckets
    duration = (end - start) / 1000.0
    bucket_count = max(1, int(duration))
    damage_buckets = [0] * bucket_count
    # Also track per-ability damage events for source rectangles
    ability_damage = {}
    for event in damage_taken:
        # Skip damage from friendly sources (e.g. Stagger, self-damage)
        source = actors_map.get(event.get("sourceID"), {})
        if source.get("type") in ("Player", "Pet"):
            continue
        t = (event["timestamp"] - start) / 1000.0
        bucket = min(int(t), bucket_count - 1)
        amount = event.get("amount", 0) + event.get("absorbed", 0)
        damage_buckets[bucket] += amount
        # Track per-ability
        game_id = event.get("abilityGameID", 0)
        name = abilities_map.get(game_id, {}).get("name", f"Unknown ({game_id})")
        if game_id not in ability_damage:
            ability_info = abilities_map.get(game_id, {})
            ability_damage[game_id] = {
                "name": name,
                "icon": ability_info.get("icon", ""),
                "gameID": game_id,
                "events": [],
                "buckets": [0] * bucket_count,
            }
        ability_damage[game_id]["events"].append({"time": t, "amount": amount})
        ability_damage[game_id]["buckets"][bucket] += amount

    # Build damage source segments (cluster events within 3s gaps)
    damage_sources = []
    for game_id, info in ability_damage.items():
        events = info["events"]
        events.sort(key=lambda e: e["time"])
        total = sum(e["amount"] for e in events)
        # Skip very minor sources (< 1% of total damage)
        total_damage = sum(damage_buckets)
        if total_damage > 0 and total / total_damage < 0.01:
            continue
        # Cluster into segments
        segments = []
        seg_start = events[0]["time"]
        seg_end = events[0]["time"]
        seg_total = events[0]["amount"]
        for e in events[1:]:
            if e["time"] - seg_end <= 3.0:
                seg_end = e["time"]
                seg_total += e["amount"]
            else:
                segments.append({"start": seg_start, "end": seg_end, "total": seg_total})
                seg_start = e["time"]
                seg_end = e["time"]
                seg_total = e["amount"]
        segments.append({"start": seg_start, "end": seg_end, "total": seg_total})
        damage_sources.append({
            "name": info["name"],
            "icon": info["icon"],
            "gameID": info["gameID"],
            "total": total,
            "segments": segments,
            "buckets": info["buckets"],
        })

    # Sort by total damage descending
    damage_sources.sort(key=lambda s: s["total"], reverse=True)

    # Process deaths
    death_entries = []
    for event in deaths:
        target = actors_map.get(event.get("targetID"), {})
        death_entries.append({
            "time": (event["timestamp"] - start) / 1000.0,
            "player": target.get("name", "Unknown"),
        })

    result = {
        "fight": {
            "name": fight["name"],
            "duration": duration,
            "kill": fight["kill"],
            "difficulty": fight["difficulty"],
            "bossPercentage": fight.get("bossPercentage"),
        },
        "casts": cast_entries,
        "damage": damage_buckets,
        "damageSources": damage_sources,
        "deaths": death_entries,
    }
    cache_set(f"timeline:{code}:{fight_id}", result)
    return result


def fetch_all_events(code, fight_id, start, end, data_type, hostility_type):
    all_events = []
    current_start = start
    while current_start is not None:
        query = """
        query($code: String!, $fightID: Int!, $start: Float!, $end: Float!,
              $dataType: EventDataType!, $hostilityType: HostilityType!) {
            reportData {
                report(code: $code) {
                    events(
                        fightIDs: [$fightID]
                        startTime: $start
                        endTime: $end
                        dataType: $dataType
                        hostilityType: $hostilityType
                        limit: 10000
                    ) {
                        data
                        nextPageTimestamp
                    }
                }
            }
        }
        """
        data = graphql(query, {
            "code": code,
            "fightID": fight_id,
            "start": current_start,
            "end": end,
            "dataType": data_type,
            "hostilityType": hostility_type,
        })
        events = data["reportData"]["report"]["events"]
        all_events.extend(events["data"])
        current_start = events.get("nextPageTimestamp")
    return all_events


# --- Flask Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/fights")
def api_fights():
    code = request.args.get("code", "").strip()
    if not code:
        return jsonify({"error": "Missing report code"}), 400
    try:
        result = fetch_fights(code)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/timeline")
def api_timeline():
    code = request.args.get("code", "").strip()
    fight_id = request.args.get("fight", type=int)
    if not code or fight_id is None:
        return jsonify({"error": "Missing code or fight ID"}), 400
    try:
        result = fetch_timeline(code, fight_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


load_credentials()

if __name__ == "__main__":
    print(f"Loaded WarcraftLogs client: {CLIENT_ID}")
    app.run(debug=True, port=5000)
