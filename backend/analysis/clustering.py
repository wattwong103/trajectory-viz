"""
Trajectory clustering — groups similar trajectories using feature-based clustering.

Approach:
1. Extract a fixed-length feature vector per trajectory:
   (start_lon, start_lat, end_lon, end_lat, distance_km, dep_hour, avg_speed)
2. Normalize features to [0, 1] range
3. Cluster with either HDBSCAN (if available) or DBSCAN (sklearn fallback)
4. Return cluster assignments with representative trajectories

This runs on trips (not waypoints) since clustering millions of variable-length
sequences would be too expensive for interactive use. The spatial OD pattern
is the primary clustering signal for mobility data.
"""

import math

from fastapi import APIRouter, Depends, Query

from ..db import get_connection
from ..filters import TripFilters, trip_filters

router = APIRouter()

# Try HDBSCAN first, fall back to sklearn DBSCAN
try:
    from hdbscan import HDBSCAN as Clusterer

    def make_clusterer(min_size: int):
        return Clusterer(min_cluster_size=min_size, metric='euclidean')

    ALGO_NAME = "HDBSCAN"
except ImportError:
    try:
        from sklearn.cluster import DBSCAN

        def make_clusterer(min_size: int):
            return DBSCAN(eps=0.15, min_samples=min_size, metric='euclidean')

        ALGO_NAME = "DBSCAN"
    except ImportError:
        make_clusterer = None
        ALGO_NAME = "none"


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@router.get("/analysis/clustering/status")
async def clustering_status():
    """Check if clustering libraries are available."""
    return {
        "available": make_clusterer is not None,
        "algorithm": ALGO_NAME,
        "message": (
            "Clustering ready" if make_clusterer
            else "Install hdbscan or scikit-learn: pip install hdbscan scikit-learn"
        ),
    }


@router.post("/analysis/clustering/run")
async def run_clustering(
    sample_size: int = Query(5000, ge=100, le=50000),
    min_cluster_size: int = Query(20, ge=5, le=500),
    f: TripFilters = Depends(trip_filters),
):
    """Run clustering on a sample of trips.

    Features per trip (normalized to [0,1]):
    - start_lon, start_lat (spatial origin)
    - end_lon, end_lat (spatial destination)
    - distance_km (trip length)
    - dep_hour (temporal pattern)

    Returns cluster assignments with summary statistics.
    """
    if make_clusterer is None:
        return {
            "error": "No clustering library available. Install: pip install hdbscan scikit-learn",
            "clusters": [],
        }

    conn = get_connection()
    where = f.where(extra=[
        "distance_km IS NOT NULL",
        "distance_km > 0",
        "start_lon IS NOT NULL",
        "end_lon IS NOT NULL",
    ])

    rows = conn.execute(f"""
        SELECT vehicle_key, trip_id,
               start_lon, start_lat, end_lon, end_lat,
               distance_km, dep_hour, vehicle_type
        FROM trips
        {where}
        USING SAMPLE {sample_size}
    """).fetchall()

    if len(rows) < min_cluster_size * 2:
        return {
            "error": f"Not enough trips ({len(rows)}) for clustering. Need at least {min_cluster_size * 2}.",
            "clusters": [],
        }

    # Extract features
    features = []
    trip_data = []
    for r in rows:
        vkey, tid, slon, slat, elon, elat, dist, hour, vtype = r
        features.append([slon, slat, elon, elat, dist or 0, hour or 0])
        trip_data.append({
            "vehicle_key": vkey, "trip_id": tid,
            "start": [slon, slat], "end": [elon, elat],
            "distance_km": round(dist, 1) if dist else 0,
            "dep_hour": hour, "vehicle_type": vtype,
        })

    # Normalize features to [0, 1]
    import numpy as np
    X = np.array(features, dtype=np.float64)
    mins = X.min(axis=0)
    maxs = X.max(axis=0)
    ranges = maxs - mins
    ranges[ranges == 0] = 1  # avoid division by zero
    X_norm = (X - mins) / ranges

    # Weight spatial features higher than temporal
    # [start_lon, start_lat, end_lon, end_lat, distance, hour]
    weights = np.array([2.0, 2.0, 2.0, 2.0, 1.0, 0.5])
    X_weighted = X_norm * weights

    # Cluster
    clusterer = make_clusterer(min_cluster_size)
    labels = clusterer.fit_predict(X_weighted)

    # Build cluster summaries
    cluster_ids = set(labels)
    cluster_ids.discard(-1)  # remove noise label

    clusters = []
    for cid in sorted(cluster_ids):
        mask = labels == cid
        members = [trip_data[i] for i in range(len(labels)) if labels[i] == cid]
        cluster_features = X[mask]

        # Centroid
        centroid = cluster_features.mean(axis=0)

        # Representative trip (closest to centroid in feature space)
        dists = np.linalg.norm(cluster_features - centroid, axis=1)
        rep_idx = np.where(mask)[0][np.argmin(dists)]

        clusters.append({
            "cluster_id": int(cid),
            "size": int(mask.sum()),
            "centroid": {
                "start": [round(centroid[0], 4), round(centroid[1], 4)],
                "end": [round(centroid[2], 4), round(centroid[3], 4)],
                "avg_distance_km": round(float(centroid[4]), 1),
                "avg_dep_hour": round(float(centroid[5]), 1),
            },
            "representative": trip_data[rep_idx],
            "members": members[:20],  # cap at 20 for response size
        })

    noise_count = int((labels == -1).sum())

    return {
        "algorithm": ALGO_NAME,
        "total_trips": len(rows),
        "num_clusters": len(clusters),
        "noise_count": noise_count,
        "clusters": sorted(clusters, key=lambda c: -c["size"]),
    }


# F3 — Route-similarity clustering (Phase 2 Step 2.6).
# Differs from /clustering/run in feature space: route_similarity uses the
# set of DRM link_ids each trajectory traverses, then DBSCAN over pairwise
# Jaccard distance. Detects "trips that share the same infrastructure".
@router.post("/analysis/clustering/route-similarity")
async def route_similarity(
    sample_size: int = Query(
        200, ge=20, le=2000,
        description=(
            "Number of trajectories sampled. O(N^2) memory + compute. "
            "Sprint B6 benchmark on synthetic link sets (vocab=500, 10-100 links/trip): "
            "N=200 → 0.05s, N=500 → 0.3s, N=1000 → 1.3s, N=2000 → 5.2s. "
            "Wall time is dominated by the pairwise Jaccard kernel (pure Python); "
            "raise the cap only if you've vectorized with numpy bitsets or MinHash LSH."
        ),
    ),
    eps: float = Query(
        0.3, ge=0.01, le=0.95,
        description="DBSCAN eps in Jaccard distance (0=identical link sets, 1=disjoint).",
    ),
    min_samples: int = Query(3, ge=2, le=50),
    f: TripFilters = Depends(trip_filters),
):
    """Cluster trajectories by Jaccard similarity of their link-id sets.

    Implementation:
      1. Sample N (vehicle_key, trip_id) pairs matching the filter.
      2. Fetch each trip's set of distinct link_ids from waypoints.
      3. Compute pairwise Jaccard distance: 1 - |A ∩ B| / |A ∪ B|.
      4. DBSCAN(metric='precomputed') over the distance matrix.

    Trips with no link_id-bearing waypoints (e.g. no trajectory ingested for
    that source) are dropped from the sample.
    """
    try:
        import numpy as np
        from sklearn.cluster import DBSCAN
    except ImportError:
        return {"error": "scikit-learn not installed", "algorithm": "none"}

    conn = get_connection()
    trip_where = f.where()

    # Sample (vehicle_key, trip_id) refs from trips. Sampling here (not waypoints)
    # avoids over-weighting long trips.
    sampled = conn.execute(f"""
        SELECT vehicle_key, trip_id
        FROM trips
        {trip_where}
        USING SAMPLE {int(sample_size)}
    """).fetchall()

    if not sampled:
        return {
            "algorithm": "DBSCAN-Jaccard-on-links",
            "total_trips": 0,
            "num_clusters": 0,
            "noise_count": 0,
            "clusters": [],
        }

    # Bulk-fetch link_ids for the sampled trips. Composite IN is DuckDB-native.
    # vehicle_key is VARCHAR so we quote it; trip_id is BIGINT so it's bare.
    pairs = ", ".join(
        f"({_sql_string_literal(vk)}, {int(tid)})" for vk, tid in sampled
    )
    wp_rows = conn.execute(f"""
        SELECT vehicle_key, trip_id, link_id
        FROM waypoints
        WHERE (vehicle_key, trip_id) IN ({pairs})
          AND link_id IS NOT NULL AND link_id != ''
    """).fetchall()

    # Group: {(vehicle_key, trip_id): set(link_ids)}
    by_trip: dict[tuple, set[str]] = {}
    for vk, tid, lk in wp_rows:
        by_trip.setdefault((vk, tid), set()).add(lk)

    # Drop sampled trips that had zero matching waypoints (no trajectory data).
    trip_keys = [k for k in sampled if k in by_trip]
    link_sets = [by_trip[k] for k in trip_keys]
    n = len(trip_keys)

    if n < 2:
        return {
            "algorithm": "DBSCAN-Jaccard-on-links",
            "total_trips": n,
            "num_clusters": 0,
            "noise_count": n,
            "clusters": [],
            "note": "Not enough trips with waypoint data to cluster.",
        }

    # Pairwise Jaccard distance matrix (symmetric).
    distances = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        ai = link_sets[i]
        for j in range(i + 1, n):
            aj = link_sets[j]
            if not ai or not aj:
                d = 1.0
            else:
                inter = len(ai & aj)
                union = len(ai | aj)
                d = 1.0 - (inter / union if union else 0.0)
            distances[i, j] = d
            distances[j, i] = d

    db = DBSCAN(eps=eps, min_samples=min_samples, metric="precomputed")
    labels = db.fit_predict(distances)

    # Group results by cluster label.
    clusters_out: dict[int, list[tuple]] = {}
    noise = 0
    for i, label in enumerate(labels):
        lbl = int(label)
        if lbl == -1:
            noise += 1
            continue
        clusters_out.setdefault(lbl, []).append(trip_keys[i])

    return {
        "algorithm": "DBSCAN-Jaccard-on-links",
        "total_trips": n,
        "num_clusters": len(clusters_out),
        "noise_count": noise,
        "eps": eps,
        "min_samples": min_samples,
        "clusters": [
            {
                "cluster_id": cid,
                "size": len(members),
                "representative": {
                    "vehicle_key": members[0][0],
                    "trip_id": members[0][1],
                    "link_count": len(by_trip[members[0]]),
                },
                "members": [
                    {"vehicle_key": vk, "trip_id": tid}
                    for vk, tid in members[:50]
                ],
            }
            for cid, members in sorted(clusters_out.items(), key=lambda kv: -len(kv[1]))
        ],
    }


def _sql_string_literal(value: str) -> str:
    """Single-quote a VARCHAR value for inline SQL. Doubles embedded apostrophes."""
    return "'" + value.replace("'", "''") + "'"
