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
from fastapi import APIRouter, Query
from typing import Optional
from ..db import get_connection, build_trip_filter

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
    vehicle_type: Optional[str] = Query(None, pattern="^(truck|taxi)$"),
    city: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    simulation_day: Optional[int] = Query(None, ge=0),
    sample_size: int = Query(5000, ge=100, le=50000),
    min_cluster_size: int = Query(20, ge=5, le=500),
    goods_type: Optional[str] = Query(None, pattern="^[a-z_]+$"),
    min_hour: Optional[int] = Query(None, ge=0, le=23),
    max_hour: Optional[int] = Query(None, ge=0, le=23),
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
    extra = [
        "distance_km IS NOT NULL",
        "distance_km > 0",
        "start_lon IS NOT NULL",
        "end_lon IS NOT NULL",
    ]
    if goods_type:
        extra.append(f"goods_type = '{goods_type}'")
    if min_hour is not None:
        extra.append(f"dep_hour >= {int(min_hour)}")
    if max_hour is not None:
        extra.append(f"dep_hour <= {int(max_hour)}")
    where = build_trip_filter(vehicle_type, city, simulation_day, extra=extra)

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
