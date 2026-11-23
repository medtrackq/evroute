# EVROUTE's own route planner: the official Valhalla image, for Thailand only. A Railway service with
# Root Directory "routing" and a volume at /custom_files (see README.md). On first start it downloads
# Thailand from OpenStreetMap (Geofabrik) and builds its routing tiles (tens of minutes), keeps them on
# the volume, then answers on port 8002 on Railway's private network only; server.mjs reaches it
# through VALHALLA_URL and falls back to the public FOSSGIS server when it doesn't answer.
FROM ghcr.io/valhalla/valhalla-scripted:latest

# use_tiles_ignore_pbf: restarts use the tiles already built (force_rebuild=True to refresh the map)
# server_threads: the host's core count otherwise, too many for the memory a small service has
# build_admins: country data, so it knows Thailand drives on the left
ENV tile_urls=https://download.geofabrik.de/asia/thailand-latest.osm.pbf \
    use_tiles_ignore_pbf=True \
    server_threads=2 \
    build_admins=True \
    build_time_zones=True \
    build_elevation=False \
    build_transit=False \
    serve_tiles=True

EXPOSE 8002
